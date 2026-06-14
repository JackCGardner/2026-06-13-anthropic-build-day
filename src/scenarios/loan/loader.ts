// The typed loader. It assembles the loan pack from the seeded population, the
// tool dossiers, and the guidelines document, derives a deterministic train /
// held-out split and a configurable eval sample, computes the population
// statistics, and validates the whole pack against LoanScenarioPackSchema before
// handing it to any consumer. A malformed applicant, dossier, or stat fails
// loudly at load time rather than silently downstream, exactly as the refund
// loader does for its pack.

import {
  type Applicant,
  type LoanScenarioPack,
  type LoanSplits,
  type PopulationStats,
  type ProtectedClass,
  LoanScenarioPackSchema,
} from "./schema.js";
import { LOAN_PACK_ID, LOAN_BRIEF } from "./brief.js";
import { LOAN_DOSSIERS } from "./dossiers.js";
import { generatePopulation } from "./population.js";

// The default eval-sample size for the live DSPy loop. Small enough that a
// per-candidate live evaluation stays cost-bounded, large enough to span the
// tiers and both protected classes so the multi-objective signal is meaningful.
// The full population is always used for final scoring; the eval sample only
// bounds the optimizer's inner loop.
export const DEFAULT_EVAL_SAMPLE_SIZE = 16;

// The held-out fraction of the population. The headline multi-objective score is
// computed on the held-out split; the rest trains the optimizer.
const HELD_OUT_FRACTION = 0.35;

// Options for assembling the pack. eval_sample_size lets the optimizer trade
// cost against signal without regenerating the population.
export interface LoadLoanPackOptions {
  eval_sample_size?: number;
}

// Build a deterministic, stratified split. Applicants are already laid out by
// tier (prime, then near_prime, then subprime) with groups alternating, so a
// fixed-stride selection across the whole sequence keeps both the tier mix and
// the group balance proportional in every subset. The split is by applicant id,
// reproducible with no randomness beyond the seeded population itself.
function buildSplits(
  applicants: Applicant[],
  evalSampleSize: number,
): LoanSplits {
  const ids = applicants.map((a) => a.applicant_id);
  const groupOf = new Map<string, ProtectedClass>(
    applicants.map((a) => [a.applicant_id, a.application.protected_class]),
  );

  // Held-out is every k-th applicant across the tier-ordered sequence, so it
  // draws proportionally from every tier and both groups rather than clustering
  // in one tier. The stride is chosen from the held-out fraction.
  const heldOutCount = Math.max(1, Math.round(ids.length * HELD_OUT_FRACTION));
  const stride = Math.max(2, Math.round(ids.length / heldOutCount));

  const heldOut: string[] = [];
  const train: string[] = [];
  ids.forEach((id, i) => {
    if (i % stride === 0 && heldOut.length < heldOutCount) {
      heldOut.push(id);
    } else {
      train.push(id);
    }
  });

  // The eval sample is a representative slice of the TRAIN split (the optimizer
  // never sees held-out during its inner loop). The population alternates the two
  // groups strictly across the tier order, so a single fixed stride can alias
  // onto one group and leave the sample group-degenerate, which collapses the
  // fair-lending signal the judge depends on. To keep both groups present at any
  // sample size, the two groups are sampled independently each by its own stride
  // and then interleaved, so the eval sample spans tiers AND carries both groups
  // proportionally. The selection is still fully deterministic.
  const clampedSize = Math.max(1, Math.min(evalSampleSize, train.length));
  const trainByGroup = (target: ProtectedClass): string[] =>
    train.filter((id) => groupOf.get(id) === target);
  const groupA = trainByGroup("group_a");
  const groupB = trainByGroup("group_b");

  // Split the budget across the groups in proportion to their presence in train,
  // giving each group at least one slot when train carries it, so neither group
  // can be sampled away.
  const targetA =
    groupA.length === 0
      ? 0
      : Math.max(1, Math.round((clampedSize * groupA.length) / train.length));
  const targetB = Math.max(0, clampedSize - targetA);

  const pickEvenly = (pool: string[], want: number): string[] => {
    if (want <= 0 || pool.length === 0) return [];
    const take = Math.min(want, pool.length);
    const stride = Math.max(1, Math.floor(pool.length / take));
    const picked: string[] = [];
    for (let i = 0; i < pool.length && picked.length < take; i += stride) {
      picked.push(pool[i]!);
    }
    return picked;
  };

  const pickedA = pickEvenly(groupA, targetA);
  const pickedB = pickEvenly(groupB, Math.min(targetB, groupB.length));

  // Interleave the two group picks so the eval sample alternates groups, matching
  // the population's own layout, then trim to the requested size.
  const evalSample: string[] = [];
  for (let i = 0; i < Math.max(pickedA.length, pickedB.length); i += 1) {
    if (i < pickedA.length) evalSample.push(pickedA[i]!);
    if (i < pickedB.length) evalSample.push(pickedB[i]!);
  }
  const evalSampleSized = evalSample.slice(0, clampedSize);

  return { train, held_out: heldOut, eval_sample: evalSampleSized };
}

// Compute the population statistics from the applicants and the split. These are
// the headline facts about the world and are asserted in the schema on load.
function computeStats(applicants: Applicant[], splits: LoanSplits): PopulationStats {
  const total = applicants.length;
  const defaults = applicants.filter(
    (a) => a.ground_truth.true_outcome === "default",
  ).length;
  const marginal = applicants.filter(
    (a) => a.ground_truth.true_risk_tier === "near_prime",
  ).length;

  const protectedCounts: Record<string, number> = {};
  for (const a of applicants) {
    const key = a.ground_truth.protected_class;
    protectedCounts[key] = (protectedCounts[key] ?? 0) + 1;
  }

  return {
    total,
    train_count: splits.train.length,
    held_out_count: splits.held_out.length,
    eval_sample_count: splits.eval_sample.length,
    default_base_rate: total === 0 ? 0 : round4(defaults / total),
    marginal_fraction: total === 0 ? 0 : round4(marginal / total),
    protected_class_counts: protectedCounts,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// Build and validate the loan scenario pack. Throws if the assembled pack does
// not satisfy LoanScenarioPackSchema. The population is seeded, so repeated calls
// with the same options return an identical pack.
export function loadLoanPack(options: LoadLoanPackOptions = {}): LoanScenarioPack {
  const evalSampleSize = options.eval_sample_size ?? DEFAULT_EVAL_SAMPLE_SIZE;
  const applicants = generatePopulation();
  const splits = buildSplits(applicants, evalSampleSize);
  const stats = computeStats(applicants, splits);

  const candidate = {
    id: LOAN_PACK_ID,
    brief: LOAN_BRIEF,
    applicants,
    dossiers: LOAN_DOSSIERS,
    splits,
    stats,
  };
  return LoanScenarioPackSchema.parse(candidate);
}
