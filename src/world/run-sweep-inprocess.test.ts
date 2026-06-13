// The evidence viewer reads exactly one data source: runSweepInProcess. This
// test calls that function directly, with no server and no API key, and asserts
// the headline numbers the UI renders are computed correctly from the trace:
//
//   v1 (naive):     technical pass 100%, Cash Burned $5,140, Trust 38
//   v2 (tightened): technical pass 100%, Cash Burned $0,     Trust 91
//
// It also checks the route's payload shape (specs and per-fixture traces) so a
// regression in the viewer contract fails here rather than in the browser.

import { describe, it, expect } from "vitest";
import { runSweepInProcess } from "@/world/index.js";

describe("the in-process keyless sweep behind the viewer", () => {
  it("computes v1 $5,140 / Trust 38 and v2 $0 / Trust 91, both technical 100%", async () => {
    const sweep = await runSweepInProcess();

    expect(sweep.v1.score.technical_pass_rate).toBe(1);
    expect(sweep.v1.score.cash_burned_cents).toBe(514000);
    // The dashboard renders Math.round(trust_score); the raw score is 38.35.
    expect(Math.round(sweep.v1.score.trust_score)).toBe(38);

    expect(sweep.v2.score.technical_pass_rate).toBe(1);
    expect(sweep.v2.score.cash_burned_cents).toBe(0);
    // Raw score is 91.15, rendered as 91.
    expect(Math.round(sweep.v2.score.trust_score)).toBe(91);
  });

  it("carries the pinned specs and full per-fixture traces for the panels", async () => {
    const sweep = await runSweepInProcess();

    expect(sweep.v1.spec.version).toBe("v1");
    expect(sweep.v2.spec.version).toBe("v2");

    // Every fixture ships its full trace so the trace panel can replay it.
    expect(sweep.v1.fixtures.length).toBeGreaterThan(0);
    expect(sweep.v1.fixtures.length).toBe(sweep.v2.fixtures.length);
    for (const f of sweep.v1.fixtures) {
      expect(f.events.length).toBeGreaterThan(0);
    }

    // One verdict per fixture on each side.
    expect(sweep.v1.score.fixture_verdicts.length).toBe(
      sweep.v1.fixtures.length,
    );
  });
});
