// The optimize CLI: the keyless proof of the product's central claim. Starting
// from the rule-silent v1 spec, it runs the optimizer against the deterministic
// InterpreterHarness, learns the policy gates from judge feedback, and prints the
// trajectory round by round: which candidates were proposed, which were kept and
// why, the over-broad probes the keep-if-better rule rejected, and the train and
// held-out Trust Scores. No Anthropic or Vercel credential is touched.
//
// Expected keyless trajectory:
//   round 0: Cash Burned $5,140 / Trust ~38 over the full sweep
//   final:   Cash Burned $0     / Trust ~91, with the discovered gate set
//   held-out Trust reported on the validation split the loop never selected on
//
// Usage:
//   npm run optimize
//   tsx scripts/optimize.ts
//   tsx scripts/optimize.ts --harness live   (LLM harness + LLM proposer; needs a key)

import { createJudge, deterministicCxScorer } from "@/engine";
import type { Fixture, RunScore } from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { runSweep, createInterpreterHarness } from "@/world/index.js";
import { toStructuredSpec } from "@/harness/structured-spec.js";
import { REFUND_HARNESS_SPEC_V1 } from "@/harness/specs/index.js";
import {
  optimize,
  createDeterministicProposer,
  interpreterHarnessFactory,
  type OptimizerResult,
} from "@/optimizer/index.js";

function parseHarnessMode(argv: string[]): "interpreter" | "live" {
  const idx = argv.indexOf("--harness");
  if (idx !== -1 && argv[idx + 1] === "live") return "live";
  return "interpreter";
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}

// Score one structured spec over a set of fixtures through the interpreter, for
// the demo dashboard lines that frame the trajectory in the headline full-sweep
// numbers (the loop itself selects on the train split).
async function scoreSpecOverFixtures(
  runId: string,
  spec: Parameters<typeof createInterpreterHarness>[0],
  fixtures: Fixture[],
): Promise<RunScore> {
  const pack = loadRefundPack();
  const harness = createInterpreterHarness(spec);
  const run = await runSweep(runId, harness, fixtures);
  const judge = createJudge(deterministicCxScorer);
  return judge.scoreRun({
    runId: run.runId,
    harnessVersion: run.harnessVersion,
    rubric: pack.rubric,
    fixtures: run.fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      fixture: f.fixture,
      events: f.events,
    })),
  });
}

function printTrajectory(
  result: OptimizerResult,
  startSweep: RunScore,
  finalSweep: RunScore,
): void {
  console.log("");
  console.log("  Synthetic Harness Lab: optimizer trajectory (keyless, deterministic)");
  console.log("  " + "-".repeat(72));
  console.log(
    `  round 0 (rule-silent v1):  Cash Burned ${dollars(startSweep.cash_burned_cents)}` +
      `   Trust ${startSweep.trust_score.toFixed(0)}   technical ${pct(startSweep.technical_pass_rate)}`,
  );
  console.log("");

  for (const round of result.rounds) {
    console.log(
      `  Round ${round.round}: incumbent Trust ${round.start_train_trust_score.toFixed(1)} on the train split`,
    );
    for (const c of round.candidates) {
      const mark = c.kept ? "KEEP  " : "reject";
      const probe = c.expected_helpful ? "" : "  [over-broad probe]";
      console.log(
        `    ${mark}  ${c.label}${probe}`,
      );
      console.log(
        `            train Trust ${c.train_trust_score.toFixed(1)}, ` +
          `Cash ${dollars(c.train_cash_burned_cents)}, technical ${pct(c.technical_pass_rate)} -- ${c.reason}`,
      );
    }
    if (round.kept_label) {
      console.log(
        `    => adopted "${round.kept_label}": train Trust now ${round.end_train_trust_score.toFixed(1)}`,
      );
    } else {
      console.log("    => no candidate improved the incumbent; plateau reached");
    }
    console.log("");
  }

  console.log("  " + "-".repeat(72));
  console.log(
    `  final spec:  Cash Burned ${dollars(finalSweep.cash_burned_cents)}` +
      `   Trust ${finalSweep.trust_score.toFixed(0)}   technical ${pct(finalSweep.technical_pass_rate)}  (full sweep)`,
  );
  console.log(
    `  discovered gates:  ${result.discovered_gate_ids.join(", ") || "none"}`,
  );
  console.log(
    `  HELD-OUT Trust Score (validation split, never selected on):  ` +
      `${result.held_out_score.trust_score.toFixed(0)} / 100   ` +
      `Cash Burned ${dollars(result.held_out_score.cash_burned_cents)}   ` +
      `technical ${pct(result.held_out_score.technical_pass_rate)}`,
  );
  console.log("");
  console.log(
    `  Trajectory: Cash Burned ${dollars(startSweep.cash_burned_cents)} -> ${dollars(finalSweep.cash_burned_cents)}, ` +
      `Trust ${startSweep.trust_score.toFixed(0)} -> ${finalSweep.trust_score.toFixed(0)}, ` +
      `technical flat at ${pct(finalSweep.technical_pass_rate)}.`,
  );
  console.log("");
}

async function main(): Promise<void> {
  const mode = parseHarnessMode(process.argv.slice(2));
  if (mode === "live") {
    console.log("");
    console.log("  The live optimizer (LLM harness + LLM proposer) needs an Anthropic credential.");
    console.log("  Set ANTHROPIC_API_KEY (or the SDK's configured credential) and rerun with");
    console.log("  --harness live. The keyless optimizer below is the default and needs no key.");
    console.log("");
    return;
  }

  const pack = loadRefundPack();
  const allFixtures = pack.fixtures;
  const heldOutIds = new Set(pack.splits.held_out);
  const holdoutFixtures = allFixtures.filter((f) => heldOutIds.has(f.id));

  // The optimizer selects on a train split that exercises every failure mode so
  // each gate is learnable, and the legit case is present so an over-broad probe
  // that refuses good money is rejected. The held-out split validates the final
  // spec on cases the loop never selected on.
  const trainFixtures = allFixtures;

  const startSpec = toStructuredSpec(REFUND_HARNESS_SPEC_V1);
  const proposer = createDeterministicProposer();

  const result = await optimize({
    startSpec,
    proposer,
    rubric: pack.rubric,
    trainFixtures,
    holdoutFixtures,
    harnessFactory: interpreterHarnessFactory,
  });

  // Frame the trajectory in the headline full-sweep numbers.
  const startSweep = await scoreSpecOverFixtures("opt_sweep_start", result.start_spec, allFixtures);
  const finalSweep = await scoreSpecOverFixtures("opt_sweep_final", result.final_spec, allFixtures);

  printTrajectory(result, startSweep, finalSweep);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
