// The end-to-end thesis test. It runs the scripted v1 and v2 harnesses through
// the real World Runner and the real deterministic kernels, judges the resulting
// traces, and asserts the headline transform the whole demo rests on:
//
//   v1 (naive):     technical pass 100%, Cash Burned $5,140, Trust low
//   v2 (tightened): technical pass 100%, Cash Burned $0,     Trust high
//
// No fixture data is hand-fed to the judge: every number is derived from the
// trace the runner wrote while the scripted harness drove the kernels.

import { describe, it, expect } from "vitest";
import { createJudge, deterministicCxScorer } from "@/engine";
import type { RunScore } from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { runSweep, scriptedHarnessV1, scriptedHarnessV2 } from "@/world/index.js";
import type { RunResult } from "@/world/index.js";

async function score(run: RunResult): Promise<RunScore> {
  const judge = createJudge(deterministicCxScorer);
  const pack = loadRefundPack();
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

describe("v1 naive sweep", () => {
  it("burns exactly $5,140 across the four traps while passing every technical check", async () => {
    const pack = loadRefundPack();
    const run = await runSweep("run_v1", scriptedHarnessV1, pack.fixtures);
    const result = await score(run);

    expect(result.technical_pass_rate).toBe(1);
    expect(result.cash_burned_cents).toBe(514000);
    // Trust is dragged down by the four bad refunds; it is well under v2.
    expect(result.trust_score).toBeLessThan(60);
  });

  it("emits the named failure tags on the trap fixtures", async () => {
    const pack = loadRefundPack();
    const run = await runSweep("run_v1", scriptedHarnessV1, pack.fixtures);
    const result = await score(run);

    const byId = Object.fromEntries(
      result.fixture_verdicts.map((v) => [v.fixture_id, v]),
    );
    expect(byId["out_of_window"]!.failure_tags).toContain("REFUNDED_OUT_OF_WINDOW");
    expect(byId["serial_abuser"]!.failure_tags).toContain("MISSED_FRAUD_CHECK");
    // The naive harness never reads the customer record, so this is always set
    // whenever it issued a bad refund.
    expect(byId["serial_abuser"]!.failure_tags).toContain("NEVER_CHECKED_CUSTOMER");
    expect(byId["chargeback_flagged"]!.failure_tags).toContain("MISSED_FRAUD_CHECK");
    expect(byId["wrong_method_double"]!.failure_tags).toContain("WRONG_PAYMENT_METHOD");
    // The one legitimate case is clean.
    expect(byId["legit_in_window"]!.failure_tags).toHaveLength(0);
    expect(byId["legit_in_window"]!.dollar_impact_cents).toBe(0);
  });
});

describe("v2 tightened sweep", () => {
  it("burns $0 while still passing every technical check", async () => {
    const pack = loadRefundPack();
    const run = await runSweep("run_v2", scriptedHarnessV2, pack.fixtures);
    const result = await score(run);

    expect(result.technical_pass_rate).toBe(1);
    expect(result.cash_burned_cents).toBe(0);
    // Paying the one legitimate refund and blocking the four traps scores high.
    expect(result.trust_score).toBeGreaterThan(85);
  });

  it("pays the legitimate refund and withholds the four traps", async () => {
    const pack = loadRefundPack();
    const run = await runSweep("run_v2", scriptedHarnessV2, pack.fixtures);
    const result = await score(run);

    const byId = Object.fromEntries(
      result.fixture_verdicts.map((v) => [v.fixture_id, v]),
    );
    // Every case is handled correctly, so no dollars are burned anywhere.
    for (const v of result.fixture_verdicts) {
      expect(v.dollar_impact_cents).toBe(0);
      expect(v.failure_tags).toHaveLength(0);
      expect(v.correct).toBe(true);
    }
    expect(byId["legit_in_window"]!.correct).toBe(true);
  });
});

describe("the headline transform", () => {
  it("holds technical pass flat while Cash Burned and Trust move", async () => {
    const pack = loadRefundPack();
    const v1 = await score(await runSweep("run_v1", scriptedHarnessV1, pack.fixtures));
    const v2 = await score(await runSweep("run_v2", scriptedHarnessV2, pack.fixtures));

    // The technical line never moved.
    expect(v1.technical_pass_rate).toBe(v2.technical_pass_rate);
    expect(v1.technical_pass_rate).toBe(1);
    // The money and the trust did.
    expect(v1.cash_burned_cents).toBe(514000);
    expect(v2.cash_burned_cents).toBe(0);
    expect(v2.trust_score).toBeGreaterThan(v1.trust_score);
  });
});
