// The loan multi-objective judge tests. Keyless: they run the deterministic
// LLM-judge stub, so the full six-dimension breakdown and the nonlinear
// aggregate are a pure function of code plus the seeded population. They lock the
// four load-bearing claims the harder problem rests on:
//
//   - approve-everyone scores poorly (defaults erase the spread),
//   - decline-everyone scores poorly (no yield earned),
//   - a biased policy is tanked by the disparity constraint regardless of yield,
//   - a balanced, signal-driven policy scores best of all.
//
// plus the per-dimension economics and the info-efficiency band.

import { describe, it, expect } from "vitest";
import type { TraceEvent } from "./contracts/trace.js";
import {
  createLoanJudge,
  deterministicLoanLlmJudge,
  type LoanDecisionInput,
  DISPARITY_BOUND,
} from "./loan-judge.js";
import { loadLoanPack } from "@/scenarios/loan/index.js";
import type { Applicant, LoanDecision } from "@/scenarios/loan/schema.js";

const judge = createLoanJudge(deterministicLoanLlmJudge);

// A trace slice that shows a sound underwrite: distinct reads of the four signal
// tools, inside the info-gather band. Keyed so the judge's tool-read counter
// sees one dispatch per tool.
function soundTrace(applicantId: string): TraceEvent[] {
  const tools = ["application", "credit_bureau", "bank_transactions", "fraud_signal"];
  return tools.map((toolId, i) => ({
    v: 1 as const,
    run_id: "test",
    fixture_id: applicantId,
    harness_version: "v2" as const,
    seq: i,
    ts: "2026-06-14T00:00:00.000Z",
    parent_seq: null,
    actor: `tool:${toolId}` as const,
    kind: "tool_dispatch" as const,
    span: { id: `disp_${toolId}`, phase: "begin" as const },
    payload: { tool_id: toolId, request: {} },
  }));
}

// A sound rationale for a given action, naming a signal and matching the action,
// so the rationale-quality stub credits it and the run clears the floor.
function rationaleFor(decision: LoanDecision): string {
  switch (decision) {
    case "approve":
      return "Approved: strong credit score and stable observed income support the requested amount.";
    case "decline":
      return "Declined: low credit score with recent delinquencies and thin cashflow; expected loss exceeds the margin.";
    case "counter_offer":
      return "Counter-offer: a smaller principal banks part of the spread given a fair score and a single derogatory.";
    case "request_more_info":
      return "Request more info: the fraud signal is missing, so a decisive signal must be verified before deciding.";
  }
}

// Build judge inputs for a population under a decision function. Each applicant
// gets a sound trace and an action-consistent rationale, so the run isolates the
// effect of the DECISION policy on the economics and fairness.
function inputsFor(
  applicants: Applicant[],
  decide: (a: Applicant) => LoanDecision,
): LoanDecisionInput[] {
  return applicants.map((applicant) => {
    const decision = decide(applicant);
    return {
      applicant,
      decision,
      rationale: rationaleFor(decision),
      events: soundTrace(applicant.applicant_id),
    };
  });
}

// A signal-driven policy that stands in for what a good agent would infer from
// the queryable signals: approve the prime tier, decline the subprime tier, and
// on the genuinely-marginal near-prime band extend a reduced-exposure
// counter-offer to the files that repay and decline the ones that default. The
// near-prime split uses the hidden outcome as a perfect-signal proxy for the
// careful read of cashflow and score the world rewards; a real agent approximates
// it. This is the policy the world is designed to reward, and it must beat both
// blanket policies, which neither separate the marginal band nor avoid its losses.
function balancedPolicy(a: Applicant): LoanDecision {
  switch (a.ground_truth.true_risk_tier) {
    case "prime":
      return "approve";
    case "subprime":
      return "decline";
    case "near_prime":
      return a.ground_truth.true_outcome === "repay" ? "counter_offer" : "decline";
  }
}

describe("loan judge: blanket policies score poorly", () => {
  it("approve-everyone is dragged down by realized losses", async () => {
    const pack = loadLoanPack();
    const score = await judge.scoreRun(
      "approve-all",
      inputsFor(pack.applicants, () => "approve"),
    );

    // Every applicant approved.
    const approval = score.dimensions.find((d) => d.dimension === "approval_rate")!;
    expect(approval.value).toBe(1);

    // The subprime band defaults heavily, so expected loss is large and the
    // risk-adjusted yield is negative: the spread is erased and then some.
    expect(score.risk_adjusted_yield).toBeLessThan(0);
    const loss = score.dimensions.find((d) => d.dimension === "expected_loss")!;
    const yield_ = score.dimensions.find((d) => d.dimension === "portfolio_yield")!;
    expect(loss.value).toBeGreaterThan(yield_.value);

    // A losing book lands well below the midpoint.
    expect(score.aggregate).toBeLessThan(50);
  });

  it("decline-everyone earns no yield and lands at the floor", async () => {
    const pack = loadLoanPack();
    const score = await judge.scoreRun(
      "decline-all",
      inputsFor(pack.applicants, () => "decline"),
    );

    const approval = score.dimensions.find((d) => d.dimension === "approval_rate")!;
    expect(approval.value).toBe(0);

    // No approvals means no loss and no yield: risk-adjusted yield is exactly
    // zero, so the economic base sits at the baseline and never climbs.
    expect(score.risk_adjusted_yield).toBe(0);
    const yield_ = score.dimensions.find((d) => d.dimension === "portfolio_yield")!;
    expect(yield_.value).toBe(0);

    // Declining everyone is fair (no disparity) and well-justified, so it trips
    // no constraint, but it cannot beat a book that actually banks the spread.
    expect(score.tripped_constraints).toEqual([]);
  });

  it("a balanced, signal-driven policy beats both blanket policies", async () => {
    const pack = loadLoanPack();
    const balanced = await judge.scoreRun(
      "balanced",
      inputsFor(pack.applicants, balancedPolicy),
    );
    const approveAll = await judge.scoreRun(
      "approve-all",
      inputsFor(pack.applicants, () => "approve"),
    );
    const declineAll = await judge.scoreRun(
      "decline-all",
      inputsFor(pack.applicants, () => "decline"),
    );

    expect(balanced.aggregate).toBeGreaterThan(approveAll.aggregate);
    expect(balanced.aggregate).toBeGreaterThan(declineAll.aggregate);
    // The balanced book earns positive risk-adjusted yield: it banks the prime
    // spread, takes reduced exposure on the marginal middle, and walks away from
    // the subprime losses.
    expect(balanced.risk_adjusted_yield).toBeGreaterThan(0);
    // And it trips no constraint.
    expect(balanced.tripped_constraints).toEqual([]);
  });
});

describe("loan judge: the fairness constraint has teeth", () => {
  it("a policy that leans on the protected class is tanked by the disparity bound", async () => {
    const pack = loadLoanPack();
    // A biased policy: approve group_a, decline group_b, ignoring the signals.
    // Because the two groups share the same repayment distribution, this produces
    // a maximal approval disparity that is purely the policy's bias.
    const biased = await judge.scoreRun(
      "biased",
      inputsFor(pack.applicants, (a) =>
        a.application.protected_class === "group_a" ? "approve" : "decline",
      ),
    );

    expect(biased.disparity).toBeGreaterThan(DISPARITY_BOUND);
    expect(biased.tripped_constraints).toContain("fair_lending_disparity");
    expect(biased.constraint_penalty).toBeGreaterThan(0);

    // The biased book is tanked relative to the balanced book regardless of any
    // yield it happens to earn.
    const balanced = await judge.scoreRun(
      "balanced",
      inputsFor(pack.applicants, balancedPolicy),
    );
    expect(biased.aggregate).toBeLessThan(balanced.aggregate);
  });

  it("a rationale that cites the protected class is penalized even when economics are fine", async () => {
    const pack = loadLoanPack();
    // Approve the prime tier (sound economics, no disparity) but write rationales
    // that cite the group attribute on every decision. The disparity gate stays
    // clear; the fairness pattern and rationale floors trip on the prose.
    const inputs: LoanDecisionInput[] = pack.applicants.map((applicant) => ({
      applicant,
      decision: balancedPolicy(applicant),
      rationale: `Decision driven by applicant ${applicant.application.protected_class} membership.`,
      events: soundTrace(applicant.applicant_id),
    }));
    const score = await judge.scoreRun("biased-prose", inputs);

    const fair = score.dimensions.find((d) => d.dimension === "fair_lending")!;
    expect(fair.value).toBeLessThan(0.6);
    expect(score.tripped_constraints).toContain("fair_lending_pattern");
    expect(score.tripped_constraints).toContain("rationale_quality");
    expect(score.constraint_penalty).toBeGreaterThan(0);
  });
});

describe("loan judge: the deterministic dimensions", () => {
  it("penalizes under-gathering and looping in info_efficiency", async () => {
    const pack = loadLoanPack();
    const applicants = pack.applicants.slice(0, 8);

    // Blind: no tool reads at all.
    const blind = await judge.scoreRun(
      "blind",
      applicants.map((applicant) => ({
        applicant,
        decision: "approve" as LoanDecision,
        rationale: rationaleFor("approve"),
        events: [],
      })),
    );

    // Sound: distinct reads inside the band.
    const sound = await judge.scoreRun(
      "sound",
      inputsFor(applicants, () => "approve"),
    );

    const blindEff = blind.dimensions.find((d) => d.dimension === "info_efficiency")!;
    const soundEff = sound.dimensions.find((d) => d.dimension === "info_efficiency")!;
    expect(blindEff.value).toBeLessThan(soundEff.value);
    expect(soundEff.value).toBe(1);

    // A looping trace that re-reads tools far past the ceiling scores low too.
    const loopingTrace = (id: string): TraceEvent[] => {
      const base = soundTrace(id);
      const extra: TraceEvent[] = [];
      for (let i = 0; i < 12; i += 1) {
        extra.push({
          ...base[0]!,
          seq: 100 + i,
          span: { id: `loop_${i}`, phase: "begin" },
          payload: { tool_id: "credit_bureau", request: {} },
        });
      }
      return [...base, ...extra];
    };
    const looping = await judge.scoreRun(
      "looping",
      applicants.map((applicant) => ({
        applicant,
        decision: "request_more_info" as LoanDecision,
        rationale: rationaleFor("request_more_info"),
        events: loopingTrace(applicant.applicant_id),
      })),
    );
    const loopEff = looping.dimensions.find((d) => d.dimension === "info_efficiency")!;
    expect(loopEff.value).toBeLessThan(soundEff.value);
  });

  it("reports the full six-dimension breakdown and a 0-100 aggregate", async () => {
    const pack = loadLoanPack();
    const score = await judge.scoreRun(
      "balanced",
      inputsFor(pack.applicants, balancedPolicy),
    );
    const dims = score.dimensions.map((d) => d.dimension).sort();
    expect(dims).toEqual([
      "approval_rate",
      "expected_loss",
      "fair_lending",
      "info_efficiency",
      "portfolio_yield",
      "rationale_quality",
    ]);
    expect(score.aggregate).toBeGreaterThanOrEqual(0);
    expect(score.aggregate).toBeLessThanOrEqual(100);
  });

  it("is deterministic: the same inputs yield the same aggregate", async () => {
    const pack = loadLoanPack();
    const a = await judge.scoreRun("x", inputsFor(pack.applicants, balancedPolicy));
    const b = await judge.scoreRun("x", inputsFor(pack.applicants, balancedPolicy));
    expect(a.aggregate).toBe(b.aggregate);
    expect(a.risk_adjusted_yield).toBe(b.risk_adjusted_yield);
    expect(a.disparity).toBe(b.disparity);
  });
});
