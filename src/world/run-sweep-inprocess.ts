// The in-process keyless sweep: the single data source the evidence viewer reads.
// It runs the scripted v1 (naive) and v2 (tightened) harnesses across every
// refund fixture through the World Runner and the deterministic kernels, judges
// each run, and returns one typed SweepResult carrying the run scores, the
// per-fixture verdicts, the full per-fixture trace, and the pinned harness specs.
//
// Nothing here shells out and nothing calls a model: the scripted harness drives
// the world through structured dispatch and the judge is deterministic over the
// trace plus fixture ground truth. The headline numbers (v1 $5,140 / Trust 38,
// v2 $0 / Trust 91, technical pass pinned at 100% on both) are therefore computed
// the same way the CLI sweep computes them, with no key anywhere in the pipeline.

import { createJudge, deterministicCxScorer } from "@/engine";
import type {
  RunScore,
  TraceEvent,
  HarnessVersion,
  Fixture,
} from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import {
  runSweep,
  scriptedHarnessV1,
  scriptedHarnessV2,
} from "@/world/index.js";
import type { RunResult } from "@/world/index.js";
import {
  PINNED_REFUND_SPECS,
  type HarnessSpec,
} from "@/harness/specs/index.js";

// One fixture's worth of evidence for the viewer: the judge's verdict plus the
// full unified trace the runner wrote for that fixture, so the trace panel can
// replay the shell -> egress -> tool_dispatch -> state_mutation chain.
export interface SweepFixtureResult {
  fixture_id: string;
  // The visible ticket the harness saw, for the fixture picker labels.
  ticket: Fixture["ticket"];
  // The hidden correct action, so the dashboard can mark each verdict against
  // ground truth (refund / escalate / block).
  correct_action: Fixture["ground_truth"]["correct_action"];
  events: TraceEvent[];
}

// One harness version's full result: the aggregate RunScore (technical pass %,
// Cash Burned, Trust Score, per-fixture verdicts) plus the per-fixture traces
// and the pinned spec the viewer renders in the spec panel.
export interface SweepVersionResult {
  version: HarnessVersion;
  spec: HarnessSpec;
  score: RunScore;
  fixtures: SweepFixtureResult[];
}

// The whole keyless sweep: the before (v1) and after (v2) sides the viewer puts
// side by side. This is the exact JSON the /api/sweep route returns.
export interface SweepResult {
  v1: SweepVersionResult;
  v2: SweepVersionResult;
}

// Run and judge one harness version, then fold the per-fixture traces together
// with the verdicts into the viewer-facing shape. The run id is fixed per
// version so the result is stable across calls.
async function sweepVersion(
  version: HarnessVersion,
): Promise<SweepVersionResult> {
  const pack = loadRefundPack();
  const harness =
    version === "v1" ? scriptedHarnessV1 : scriptedHarnessV2;

  const run: RunResult = await runSweep(
    `run_${version}`,
    harness,
    pack.fixtures,
  );

  const judge = createJudge(deterministicCxScorer);
  const score: RunScore = await judge.scoreRun({
    runId: run.runId,
    harnessVersion: version,
    rubric: pack.rubric,
    fixtures: run.fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      fixture: f.fixture,
      events: f.events,
    })),
  });

  const fixtures: SweepFixtureResult[] = run.fixtures.map((f) => ({
    fixture_id: f.fixtureId,
    ticket: f.fixture.ticket,
    correct_action: f.fixture.ground_truth.correct_action,
    events: f.events,
  }));

  return {
    version,
    spec: PINNED_REFUND_SPECS[version],
    score,
    fixtures,
  };
}

// Run the full keyless sweep for both harness versions. Deterministic and fast:
// no shell, no model, no network. Safe to call on every request to the route.
export async function runSweepInProcess(): Promise<SweepResult> {
  const [v1, v2] = await Promise.all([
    sweepVersion("v1"),
    sweepVersion("v2"),
  ]);
  return { v1, v2 };
}
