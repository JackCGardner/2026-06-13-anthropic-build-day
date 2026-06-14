// The loan pack tests. They lock the seeded population's determinism and stats,
// the schema validation through the loader, the train/held-out/eval-sample split
// invariants, and the fact that every loan dossier is served by the GENERIC
// kernel (no hand-coded loan kernels): a seeded WorldState plus a dossier-built
// kernel returns the seeded signals for an applicant and 404s a missing one.

import { describe, it, expect } from "vitest";
import type { EgressRequest, WorldState } from "@/engine";
import { createGenericKernel } from "@/engine/kernels/generic-kernel.js";

// A minimal GET EgressRequest for exercising a dossier-built kernel directly.
function get(toolId: string, path: string): EgressRequest {
  return { tool_id: toolId, method: "GET", path, query: {}, headers: {}, body: "" };
}
import {
  loadLoanPack,
  generatePopulation,
  LOAN_POPULATION_SIZE,
  LOAN_DOSSIERS,
  LENDING_GUIDELINES_MARKDOWN,
  DEFAULT_EVAL_SAMPLE_SIZE,
} from "./index.js";

// Build a scoped WorldState for one applicant's slice of one tool, the way the
// World Runner seeds the world from a pack's per-tool records.
function seedState(
  toolId: string,
  records: Record<string, Record<string, unknown>>,
): WorldState {
  return {
    fixture_id: "app_000",
    tool_id: toolId,
    seed: "test",
    version: 0,
    records,
    idempotency: {},
    counters: {},
    monthly_refund_budget_cents: 0,
  };
}

describe("loan population generator", () => {
  it("is deterministic and keyless-reproducible", () => {
    const a = generatePopulation();
    const b = generatePopulation();
    expect(a).toEqual(b);
    expect(a.length).toBe(LOAN_POPULATION_SIZE);
  });

  it("produces a varied mix across all three risk tiers", () => {
    const pop = generatePopulation();
    const tiers = new Map<string, number>();
    for (const a of pop) {
      const t = a.ground_truth.true_risk_tier;
      tiers.set(t, (tiers.get(t) ?? 0) + 1);
    }
    expect(tiers.get("prime")).toBeGreaterThan(0);
    expect(tiers.get("near_prime")).toBeGreaterThan(0);
    expect(tiers.get("subprime")).toBeGreaterThan(0);
  });

  it("correlates true_outcome with risk tier but with noise", () => {
    const pop = generatePopulation();
    const defaultRate = (tier: string): number => {
      const inTier = pop.filter((a) => a.ground_truth.true_risk_tier === tier);
      const defaults = inTier.filter(
        (a) => a.ground_truth.true_outcome === "default",
      ).length;
      return defaults / inTier.length;
    };
    // The mapping is informative: prime defaults far less than subprime.
    expect(defaultRate("prime")).toBeLessThan(defaultRate("subprime"));
    expect(defaultRate("prime")).toBeLessThan(defaultRate("near_prime"));
    // But noisy: no tier is degenerate (every-repay or every-default), so a
    // blanket threshold on the tier-correlated signals cannot be perfect.
    expect(defaultRate("prime")).toBeGreaterThan(0);
    expect(defaultRate("subprime")).toBeLessThan(1);
  });

  it("balances the protected class with a shared repayment distribution", () => {
    const pop = generatePopulation();
    const counts = { group_a: 0, group_b: 0 };
    const defaults = { group_a: 0, group_b: 0 };
    for (const a of pop) {
      const g = a.ground_truth.protected_class;
      counts[g] += 1;
      if (a.ground_truth.true_outcome === "default") defaults[g] += 1;
    }
    // Both groups are well represented and their default rates are close, so any
    // approval disparity a policy produces is the policy's bias, not the world's.
    expect(counts.group_a).toBeGreaterThan(10);
    expect(counts.group_b).toBeGreaterThan(10);
    const rateA = defaults.group_a / counts.group_a;
    const rateB = defaults.group_b / counts.group_b;
    expect(Math.abs(rateA - rateB)).toBeLessThan(0.2);
  });
});

describe("loan pack loader", () => {
  it("loads and validates the full pack with computed stats", () => {
    const pack = loadLoanPack();
    expect(pack.id).toBe("loan-decisioning-v1");
    expect(pack.applicants.length).toBe(LOAN_POPULATION_SIZE);
    expect(pack.dossiers.length).toBe(5);
    expect(pack.stats.total).toBe(LOAN_POPULATION_SIZE);
    // A meaningful base default rate and a substantial marginal fraction: the
    // headroom the optimizer needs.
    expect(pack.stats.default_base_rate).toBeGreaterThan(0.1);
    expect(pack.stats.default_base_rate).toBeLessThan(0.9);
    expect(pack.stats.marginal_fraction).toBeGreaterThan(0.25);
  });

  it("splits train/held-out with no overlap and full coverage", () => {
    const pack = loadLoanPack();
    const train = new Set(pack.splits.train);
    const held = new Set(pack.splits.held_out);
    for (const id of train) expect(held.has(id)).toBe(false);
    expect(train.size + held.size).toBe(LOAN_POPULATION_SIZE);
    expect(held.size).toBeGreaterThan(0);
  });

  it("draws a held-out split spanning every risk tier", () => {
    const pack = loadLoanPack();
    const byId = new Map(pack.applicants.map((a) => [a.applicant_id, a]));
    const heldTiers = new Set(
      pack.splits.held_out.map((id) => byId.get(id)!.ground_truth.true_risk_tier),
    );
    expect(heldTiers.size).toBe(3);
  });

  it("honors a configurable eval-sample size bounded by the train split", () => {
    const def = loadLoanPack();
    expect(def.splits.eval_sample.length).toBe(DEFAULT_EVAL_SAMPLE_SIZE);
    const small = loadLoanPack({ eval_sample_size: 8 });
    expect(small.splits.eval_sample.length).toBe(8);
    // The eval sample is drawn from the train split only.
    const train = new Set(small.splits.train);
    for (const id of small.splits.eval_sample) expect(train.has(id)).toBe(true);
  });
});

describe("loan dossiers served by the generic kernel", () => {
  it("never declares a hidden business rule (the trap is the tradeoff, not a rule)", () => {
    for (const d of LOAN_DOSSIERS) {
      for (const op of d.operations) {
        expect(op.business_rules_not_enforced).toEqual([]);
      }
    }
  });

  it("returns seeded credit-bureau signals for an applicant", () => {
    const dossier = LOAN_DOSSIERS.find((d) => d.tool_id === "credit_bureau")!;
    const kernel = createGenericKernel(dossier);
    const state = seedState("credit_bureau", {
      "report:app_000": { id: "app_000", credit_score: 742, derogatory_count: 0 },
    });
    const res = kernel(
      get("credit_bureau", "/reports/app_000"),
      state,
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).credit_score).toBe(742);
  });

  it("404s a missing applicant via the declared existence invariant", () => {
    const dossier = LOAN_DOSSIERS.find((d) => d.tool_id === "bank_transactions")!;
    const kernel = createGenericKernel(dossier);
    const state = seedState("bank_transactions", {});
    const res = kernel(
      get("bank_transactions", "/cashflow/missing"),
      state,
    );
    expect(res.status).toBe(404);
  });

  it("returns the application including the protected-class attribute", () => {
    const dossier = LOAN_DOSSIERS.find((d) => d.tool_id === "application")!;
    const kernel = createGenericKernel(dossier);
    const state = seedState("application", {
      "application:app_000": {
        id: "app_000",
        principal_cents: 1500000,
        protected_class: "group_a",
      },
    });
    const res = kernel(
      get("application", "/applications/app_000"),
      state,
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).protected_class).toBe("group_a");
  });

  it("serves the lending guidelines as a singleton read", () => {
    const dossier = LOAN_DOSSIERS.find((d) => d.tool_id === "lending_guidelines")!;
    const kernel = createGenericKernel(dossier);
    const state = seedState("lending_guidelines", {
      "guidelines:body": { body: LENDING_GUIDELINES_MARKDOWN },
    });
    const res = kernel(
      get("lending_guidelines", "/guidelines"),
      state,
    );
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).body).toContain("Fair lending");
  });
});
