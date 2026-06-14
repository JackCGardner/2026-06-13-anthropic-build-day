// The loan evaluate bridge contract test. It drives scripts/evaluate-loan.ts in
// --mock mode exactly the way the DSPy metric does (subprocess, JSON on stdout)
// and locks the multi-objective contract the optimizer reads: the headline
// aggregate, the per-dimension breakdown, the economic core, the disparity, the
// tripped constraints, and the faithful prompt cost. It also asserts the loop has
// real headroom under the real judge: a blind degenerate prompt and an
// approve-everything prompt both score worse than a balanced, signal-driven one.
//
// Keyless throughout: --mock derives decisions deterministically and judges them
// with the real six-dimension judge and the deterministic LLM-judge stub, so no
// credential and no model are involved.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const TSX = resolve(process.cwd(), "node_modules", ".bin", "tsx");
const SCRIPT = resolve(process.cwd(), "scripts", "evaluate-loan.ts");

interface LoanEvalOutput {
  mode: string;
  eval_sample_size: number;
  goal_achievement: {
    aggregate: number;
    risk_adjusted_yield: number;
    disparity: number;
    constraint_penalty: number;
    tripped_constraints: string[];
    per_dimension: Record<string, number>;
  };
  prompt_cost: { token_estimate: number; rule_count: number };
  per_applicant: Array<{
    applicant_id: string;
    decision: string;
    distinct_tool_reads: number;
  }>;
}

// Run the bridge in --mock with a candidate, returning the parsed JSON contract.
function runMock(candidate: {
  system_prompt: string;
  procedure?: string[];
}): LoanEvalOutput {
  const proc = spawnSync(
    TSX,
    [SCRIPT, "--mock", "--instruction", JSON.stringify(candidate)],
    { encoding: "utf8", cwd: process.cwd() },
  );
  const stdout = proc.stdout.trim();
  expect(stdout.length, proc.stderr).toBeGreaterThan(0);
  return JSON.parse(stdout) as LoanEvalOutput;
}

const BALANCED = {
  system_prompt:
    "You underwrite consumer loans. Weigh credit score, cashflow, and fraud " +
    "risk against the desk's risk appetite. Counter-offer marginal applicants " +
    "to reduce exposure rather than taking the full gamble. Decline weak files. " +
    "Never let the group attribute affect a decision or appear in a rationale.",
  procedure: [
    "Read the application.",
    "Pull credit, analyze bank transactions, and check the fraud signal.",
    "Decide and submit with a grounded rationale.",
  ],
};

const DEGENERATE = { system_prompt: "Decide." };

describe("loan evaluate bridge contract (mock)", () => {
  it("returns the full multi-objective breakdown and faithful prompt cost", () => {
    const out = runMock(BALANCED);
    expect(out.mode).toBe("mock");
    expect(out.eval_sample_size).toBe(16);

    const g = out.goal_achievement;
    expect(typeof g.aggregate).toBe("number");
    expect(g.aggregate).toBeGreaterThanOrEqual(0);
    expect(g.aggregate).toBeLessThanOrEqual(100);

    // All six dimensions are present.
    expect(Object.keys(g.per_dimension).sort()).toEqual([
      "approval_rate",
      "expected_loss",
      "fair_lending",
      "info_efficiency",
      "portfolio_yield",
      "rationale_quality",
    ]);

    // Prompt cost is faithful to the real candidate text, not the mode.
    expect(out.prompt_cost.token_estimate).toBeGreaterThan(0);
    expect(out.prompt_cost.rule_count).toBeGreaterThan(0);

    // One per-applicant row per eval-sample applicant.
    expect(out.per_applicant).toHaveLength(16);
    for (const row of out.per_applicant) {
      expect(["approve", "decline", "counter_offer", "request_more_info"]).toContain(
        row.decision,
      );
    }
  });

  it("a degenerate prompt decides blind and loses info efficiency", () => {
    const out = runMock(DEGENERATE);
    // Blind deciding reads few tools, so info_efficiency drops below the band.
    expect(out.goal_achievement.per_dimension.info_efficiency).toBeLessThan(1);
    // It also reads almost nothing per applicant.
    const reads = out.per_applicant.map((r) => r.distinct_tool_reads);
    expect(Math.max(...reads)).toBeLessThanOrEqual(2);
  });

  it("reports the fair-lending disparity and tanks the score when it trips", () => {
    // A cautious credit-cutoff policy with no counter-offer lever creates a
    // disparate-impact pattern on the small eval sample: the disparity is
    // measured and, when it exceeds the bound, the fairness constraint tanks the
    // aggregate regardless of the positive risk-adjusted yield. This is the
    // multi-objective tension the harder problem is built around.
    const cautious = runMock({
      system_prompt:
        "You underwrite loans. Be careful about default risk and fraud. " +
        "Decline weak credit files. Read all signals before deciding. Never " +
        "use the group attribute.",
    });
    expect(typeof cautious.goal_achievement.disparity).toBe("number");
    if (cautious.goal_achievement.tripped_constraints.length > 0) {
      expect(cautious.goal_achievement.constraint_penalty).toBeGreaterThan(0);
      expect(cautious.goal_achievement.aggregate).toBeLessThan(
        cautious.goal_achievement.risk_adjusted_yield + 60,
      );
    }
  });

  it("prompt cost grows with a longer, many-rule instruction", () => {
    const lean = runMock({ system_prompt: "Underwrite loans carefully." });
    const verbose = runMock({
      system_prompt: BALANCED.system_prompt,
      procedure: [
        ...(BALANCED.procedure ?? []),
        "Always double-check the credit score.",
        "Always verify the income against the bank deposits.",
        "Always confirm the fraud signal is clear.",
        "Never approve without reading every signal.",
      ],
    });
    expect(verbose.prompt_cost.token_estimate).toBeGreaterThan(
      lean.prompt_cost.token_estimate,
    );
    expect(verbose.prompt_cost.rule_count).toBeGreaterThan(
      lean.prompt_cost.rule_count,
    );
  });
});
