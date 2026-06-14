// The optimizer loop: it improves a structured harness spec from judge feedback.
// This is the product's central claim made executable. Starting from a rule-
// silent v1 spec, it runs the harness over the train split, judges the run,
// asks the proposer for candidate edits, evaluates each candidate by re-running
// and re-judging, and KEEPS a candidate only if the train Trust Score rises AND
// the technical-pass rate holds at 100%. It iterates until no candidate improves
// the score (plateau), then reports the held-out Trust Score for the final spec.
//
// The selection rule, not the proposer, is what makes this honest. The proposer
// offers tightenings and deliberately over-broad probes alike; keep-if-better
// rejects any edit that lowers Trust, including an over-broad block-all that
// keeps Cash Burned at zero but refuses the one legitimate refund. The headline
// metric is the held-out Trust Score, validated on fixtures the loop never
// trained or selected on.

import { createJudge, deterministicCxScorer } from "@/engine";
import type { Fixture, RunScore, TraceEvent } from "@/engine";
import type { Rubric } from "@/engine";
import { createInterpreterHarness, runSweep } from "@/world/index.js";
import type { Harness } from "@/engine";
import type { StructuredHarnessSpec } from "@/harness/structured-spec.js";
import type { CandidateEdit, EditProposer } from "./proposer.js";

// How a candidate fared when it was run and judged: its scores plus the
// keep-or-reject verdict and the reason, recorded verbatim in the trajectory.
export interface CandidateOutcome {
  label: string;
  version: string;
  expected_helpful: boolean;
  train_trust_score: number;
  train_cash_burned_cents: number;
  technical_pass_rate: number;
  kept: boolean;
  reason: string;
}

// One round of the loop: the spec it started from, every candidate it evaluated
// and why each was kept or rejected, and the spec it ended the round on.
export interface OptimizerRound {
  round: number;
  start_version: string;
  start_train_trust_score: number;
  start_train_cash_burned_cents: number;
  start_technical_pass_rate: number;
  candidates: CandidateOutcome[];
  kept_label: string | null;
  end_version: string;
  end_train_trust_score: number;
  end_train_cash_burned_cents: number;
}

// The full result: the final spec, its train and held-out scores, the gate ids
// it discovered, and the complete per-round trajectory. The held-out Trust Score
// is the headline metric the product reports.
export interface OptimizerResult {
  start_spec: StructuredHarnessSpec;
  final_spec: StructuredHarnessSpec;
  discovered_gate_ids: string[];
  rounds: OptimizerRound[];
  train_score: RunScore;
  held_out_score: RunScore;
}

// The harness factory the loop drives. The keyless path builds the deterministic
// interpreter from each candidate spec; the live path builds an LLM-backed
// harness. Both fill the same Harness seam, so the loop is identical.
export type HarnessFactory = (spec: StructuredHarnessSpec) => Harness;

// The interpreter factory: the keyless default. Editing the spec is the only
// thing that changes what this harness does, which is what lets the loop run and
// be CI-tested without a model.
export const interpreterHarnessFactory: HarnessFactory = (spec) =>
  createInterpreterHarness(spec);

export interface OptimizeOptions {
  startSpec: StructuredHarnessSpec;
  proposer: EditProposer;
  rubric: Rubric;
  trainFixtures: Fixture[];
  holdoutFixtures: Fixture[];
  harnessFactory?: HarnessFactory;
  // The maximum number of rounds before the loop stops regardless of progress,
  // a guard against a proposer that never converges. The deterministic proposer
  // converges well within this; it is a safety rail, not the stop condition.
  maxRounds?: number;
}

const DEFAULT_MAX_ROUNDS = 12;
// Trust Score improvements below this are treated as noise, not progress, so the
// loop plateaus cleanly rather than chasing rounding-level gains.
const MIN_IMPROVEMENT = 1e-6;

// Run one spec over a set of fixtures and return both the judge's run score and
// the raw per-fixture traces, so the proposer can read what the harness did.
async function runAndJudge(
  runId: string,
  spec: StructuredHarnessSpec,
  rubric: Rubric,
  fixtures: Fixture[],
  factory: HarnessFactory,
): Promise<{ score: RunScore; traces: TraceEvent[][] }> {
  const harness = factory(spec);
  const run = await runSweep(runId, harness, fixtures);
  const judge = createJudge(deterministicCxScorer);
  const score = await judge.scoreRun({
    runId: run.runId,
    harnessVersion: run.harnessVersion,
    rubric,
    fixtures: run.fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      fixture: f.fixture,
      events: f.events,
    })),
  });
  return { score, traces: run.fixtures.map((f) => f.events) };
}

// Evaluate one candidate on the train split and decide keep-or-reject against
// the incumbent. A candidate is kept only if its Trust Score strictly beats the
// incumbent, its technical-pass rate is a full 100%, AND it does not regress any
// case the incumbent already handled correctly. The no-regression clause is what
// rejects an over-broad edit: a blanket block-all can raise aggregate Trust by
// escalating the remaining traps, but it flips the legitimate refund from
// correct to incorrect, so it is rejected even though Cash Burned reads zero.
function judgeCandidate(
  candidate: CandidateEdit,
  candidateScore: RunScore,
  incumbentTrust: number,
  incumbentCorrect: ReadonlySet<string>,
): CandidateOutcome {
  const technicalOk = candidateScore.technical_pass_rate >= 1 - MIN_IMPROVEMENT;
  const improves = candidateScore.trust_score > incumbentTrust + MIN_IMPROVEMENT;
  const regressed = candidateScore.fixture_verdicts.find(
    (v) => incumbentCorrect.has(v.fixture_id) && !v.correct,
  );

  let kept = false;
  let reason: string;
  if (!technicalOk) {
    reason = `technical pass fell to ${pct(candidateScore.technical_pass_rate)}; rejected`;
  } else if (regressed) {
    reason = `over-broad: it stops handling ${regressed.fixture_id} correctly; rejected`;
  } else if (!improves) {
    reason =
      candidateScore.trust_score < incumbentTrust - MIN_IMPROVEMENT
        ? `Trust fell ${incumbentTrust.toFixed(1)} -> ${candidateScore.trust_score.toFixed(1)}; rejected`
        : `Trust did not improve (${candidateScore.trust_score.toFixed(1)}); rejected`;
  } else {
    kept = true;
    reason = `Trust rose ${incumbentTrust.toFixed(1)} -> ${candidateScore.trust_score.toFixed(1)} at 100% technical; kept`;
  }

  return {
    label: candidate.label,
    version: candidate.spec.version,
    expected_helpful: candidate.expected_helpful,
    train_trust_score: candidateScore.trust_score,
    train_cash_burned_cents: candidateScore.cash_burned_cents,
    technical_pass_rate: candidateScore.technical_pass_rate,
    kept,
    reason,
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

// The loop. Each round: judge the incumbent on train, ask the proposer for
// candidates, evaluate every candidate on train, and adopt the single best
// improving candidate (highest Trust among those that pass keep-if-better). When
// no candidate improves, the loop has plateaued and stops. Finally, score the
// incumbent on the held-out split for the headline metric.
export async function optimize(
  options: OptimizeOptions,
): Promise<OptimizerResult> {
  const {
    startSpec,
    proposer,
    rubric,
    trainFixtures,
    holdoutFixtures,
    harnessFactory = interpreterHarnessFactory,
    maxRounds = DEFAULT_MAX_ROUNDS,
  } = options;

  let incumbent = startSpec;
  const rounds: OptimizerRound[] = [];

  // The incumbent's standing train score, recomputed when the incumbent changes.
  let incumbentRun = await runAndJudge(
    "opt_round0",
    incumbent,
    rubric,
    trainFixtures,
    harnessFactory,
  );

  for (let round = 1; round <= maxRounds; round += 1) {
    const candidates = await proposer.propose(
      incumbent,
      incumbentRun.score,
      incumbentRun.traces,
    );
    if (candidates.length === 0) break;

    const startTrust = incumbentRun.score.trust_score;
    // The fixtures the incumbent already handles correctly, so a candidate that
    // regresses any of them is rejected as over-broad.
    const incumbentCorrect = new Set(
      incumbentRun.score.fixture_verdicts
        .filter((v) => v.correct)
        .map((v) => v.fixture_id),
    );
    const outcomes: CandidateOutcome[] = [];
    let best: { candidate: CandidateEdit; run: { score: RunScore; traces: TraceEvent[][] } } | null =
      null;

    for (const [i, candidate] of candidates.entries()) {
      const run = await runAndJudge(
        `opt_r${round}_c${i}`,
        candidate.spec,
        rubric,
        trainFixtures,
        harnessFactory,
      );
      const outcome = judgeCandidate(candidate, run.score, startTrust, incumbentCorrect);
      outcomes.push(outcome);
      if (
        outcome.kept &&
        (best === null || run.score.trust_score > best.run.score.trust_score)
      ) {
        best = { candidate, run };
      }
    }

    // Adopt the single best improving candidate; mark the rest as not kept (a
    // candidate can pass keep-if-better yet still lose to a stronger sibling in
    // the same round, so only the adopted one carries kept=true in the report).
    // A candidate already rejected for a Trust drop, a technical regression, or
    // over-breadth keeps that reason; only a clean improver that merely lost the
    // round is relabeled.
    let keptLabel: string | null = null;
    if (best) {
      for (const o of outcomes) {
        const wasKept = o.kept;
        o.kept = o.label === best.candidate.label && o.version === best.candidate.spec.version;
        if (o.kept) keptLabel = o.label;
        else if (wasKept) {
          o.reason = `Trust rose to ${o.train_trust_score.toFixed(1)} but a stronger candidate won this round; rejected`;
        }
      }
    }

    rounds.push({
      round,
      start_version: incumbent.version,
      start_train_trust_score: startTrust,
      start_train_cash_burned_cents: incumbentRun.score.cash_burned_cents,
      start_technical_pass_rate: incumbentRun.score.technical_pass_rate,
      candidates: outcomes,
      kept_label: keptLabel,
      end_version: best ? best.candidate.spec.version : incumbent.version,
      end_train_trust_score: best
        ? best.run.score.trust_score
        : startTrust,
      end_train_cash_burned_cents: best
        ? best.run.score.cash_burned_cents
        : incumbentRun.score.cash_burned_cents,
    });

    if (!best) break; // plateau: no candidate improved the incumbent.
    incumbent = best.candidate.spec;
    incumbentRun = best.run;
  }

  // Headline metric: the final spec scored on the held-out split it never
  // trained or selected on.
  const heldOut = await runAndJudge(
    "opt_heldout",
    incumbent,
    rubric,
    holdoutFixtures,
    harnessFactory,
  );

  return {
    start_spec: startSpec,
    final_spec: incumbent,
    discovered_gate_ids: incumbent.policy_gates.map((g) => g.id),
    rounds,
    train_score: incumbentRun.score,
    held_out_score: heldOut.score,
  };
}
