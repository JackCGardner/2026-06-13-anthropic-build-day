// The interpreter-harness thesis test. It proves the substrate the optimizer is
// developed against: the deterministic interpreter's behavior is a pure function
// of the structured spec it is handed, scored by the real Judge over traces the
// real runner and kernels wrote. No fixture data is fed to the Judge.
//
//   no-gate spec   -> technical 100%, Cash Burned $5,140 (pays every trap)
//   full-gate spec -> technical 100%, Cash Burned $0     (catches every trap,
//                     pays the one legit refund)
//   over-broad spec that also blocks the legit refund -> LOWER Trust than the
//                     full-gate spec, so keep-if-better can reject it
//
// This is the keyless loop the optimizer selects on; the live LLM harness is the
// real-world counterpart behind the same Harness seam.

import { describe, it, expect } from "vitest";
import { createJudge, deterministicCxScorer } from "@/engine";
import type { RunScore } from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { runSweep, createInterpreterHarness } from "@/world/index.js";
import type { RunResult } from "@/world/index.js";
import {
  toStructuredSpec,
  FULL_REFUND_GATE_SET,
  loadStructuredSpec,
  type StructuredHarnessSpec,
} from "@/harness/structured-spec.js";
import {
  REFUND_HARNESS_SPEC_V1,
  REFUND_HARNESS_SPEC_V2,
} from "@/harness/specs/index.js";

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

async function sweepSpec(
  runId: string,
  spec: StructuredHarnessSpec,
): Promise<RunScore> {
  const pack = loadRefundPack();
  const harness = createInterpreterHarness(spec);
  const run = await runSweep(runId, harness, pack.fixtures);
  return score(run);
}

const NO_GATE_SPEC: StructuredHarnessSpec = loadStructuredSpec({
  id: "interp-no-gate",
  version: "v1",
  system_prompt: "Resolve each refund ticket.",
  procedure: ["Read the ticket.", "Issue the refund.", "Mark it resolved."],
  policy_gates: [],
});

const FULL_GATE_SPEC: StructuredHarnessSpec = loadStructuredSpec({
  id: "interp-full-gate",
  version: "v2",
  system_prompt: "Gather the facts and check the policy before any refund.",
  procedure: [
    "Read the ticket.",
    "Read the policy.",
    "Look up the order and customer.",
    "Apply the gates and decide.",
  ],
  policy_gates: FULL_REFUND_GATE_SET,
});

describe("interpreter harness: behavior is a function of the spec", () => {
  it("a no-gate spec pays every refund and burns exactly $5,140 at 100% technical pass", async () => {
    const result = await sweepSpec("interp_no_gate", NO_GATE_SPEC);
    expect(result.technical_pass_rate).toBe(1);
    expect(result.cash_burned_cents).toBe(514000);
  });

  it("the full-gate spec catches every trap and burns $0 at 100% technical pass", async () => {
    const result = await sweepSpec("interp_full_gate", FULL_GATE_SPEC);
    expect(result.technical_pass_rate).toBe(1);
    expect(result.cash_burned_cents).toBe(0);
    expect(result.trust_score).toBeGreaterThan(85);
    // Every case handled correctly: the legit refund paid, the four traps held.
    for (const v of result.fixture_verdicts) {
      expect(v.dollar_impact_cents).toBe(0);
      expect(v.correct).toBe(true);
    }
  });

  it("an over-broad spec that also blocks the legit refund scores LOWER trust, so keep-if-better rejects it", async () => {
    // The full gate set plus a blanket ceiling of one cent. The ceiling catches
    // the traps the gates already catch, but it also escalates the legitimate
    // $89 refund, which is the over-broad failure: keeping money safe by also
    // refusing good money. The legit case is now mishandled, so Trust drops.
    const overBroadSpec = loadStructuredSpec({
      id: "interp-over-broad",
      version: "v3-over-broad",
      system_prompt: "Escalate anything that is not trivially small.",
      procedure: ["Read the ticket.", "Look up the order.", "Escalate on amount."],
      policy_gates: FULL_REFUND_GATE_SET,
      tool_rules: { max_refund_amount_cents: 1 },
    });

    const full = await sweepSpec("interp_full_for_cmp", FULL_GATE_SPEC);
    const overBroad = await sweepSpec("interp_over_broad", overBroadSpec);

    // The over-broad spec still keeps money safe (no bad refund), but it fails
    // the legitimate case, dragging Trust below the full-gate spec.
    expect(overBroad.cash_burned_cents).toBe(0);
    expect(overBroad.technical_pass_rate).toBe(1);
    expect(overBroad.trust_score).toBeLessThan(full.trust_score);

    const legit = overBroad.fixture_verdicts.find(
      (v) => v.fixture_id === "legit_in_window",
    );
    expect(legit?.correct).toBe(false);
  });
});

describe("interpreter harness: derived from the pinned specs", () => {
  it("the pinned v1 spec derives to zero gates and reproduces the naive $5,140 burn", async () => {
    const v1 = toStructuredSpec(REFUND_HARNESS_SPEC_V1);
    expect(v1.policy_gates).toHaveLength(0);
    const result = await sweepSpec("interp_pinned_v1", v1);
    expect(result.technical_pass_rate).toBe(1);
    expect(result.cash_burned_cents).toBe(514000);
  });

  it("the pinned v2 spec derives to the full gate set and reproduces the $0 tightened run", async () => {
    const v2 = toStructuredSpec(REFUND_HARNESS_SPEC_V2);
    expect(v2.policy_gates.length).toBe(FULL_REFUND_GATE_SET.length);
    const result = await sweepSpec("interp_pinned_v2", v2);
    expect(result.technical_pass_rate).toBe(1);
    expect(result.cash_burned_cents).toBe(0);
    expect(result.trust_score).toBeGreaterThan(85);
  });
});
