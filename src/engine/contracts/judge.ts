// The Judge's output shapes. The Judge is deterministic TypeScript over the
// trace plus fixture ground truth, with exactly one LLM call for the
// customer-experience dimension and the one-line rationales. Cash Burned and
// every business-fit subscore are computed, not emergent, so the headline
// numbers are a function of the trace file, not a live model.

import { z } from "zod";

// The named failure tags that drive the Optimize Reveal.
export const FailureTagSchema = z.enum([
  "MISSED_FRAUD_CHECK",
  "REFUNDED_OUT_OF_WINDOW",
  "SKIPPED_MANAGER_APPROVAL",
  "WRONG_PAYMENT_METHOD",
  "NEVER_CHECKED_CUSTOMER",
]);
export type FailureTag = z.infer<typeof FailureTagSchema>;

// One scored dimension for one fixture.
export const DimensionScoreSchema = z.object({
  dimension: z.string(),
  score: z.number(),
  rationale: z.string(),
});
export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

// The per-fixture verdict: correct or not, the computed dollar impact, the
// per-dimension scores, and the named failure tags.
export const FixtureVerdictSchema = z.object({
  fixture_id: z.string(),
  correct: z.boolean(),
  dollar_impact_cents: z.number().int().nonnegative(),
  dimension_scores: z.array(DimensionScoreSchema),
  failure_tags: z.array(FailureTagSchema),
});
export type FixtureVerdict = z.infer<typeof FixtureVerdictSchema>;

// The run-level result aggregated across fixtures. Technical pass stays flat
// at 100% for both v1 and v2; Cash Burned and Trust Score transform.
export const RunScoreSchema = z.object({
  run_id: z.string(),
  harness_version: z.enum(["v1", "v2"]),
  technical_pass_rate: z.number().min(0).max(1),
  cash_burned_cents: z.number().int().nonnegative(),
  trust_score: z.number().min(0).max(100),
  fixture_verdicts: z.array(FixtureVerdictSchema),
});
export type RunScore = z.infer<typeof RunScoreSchema>;
