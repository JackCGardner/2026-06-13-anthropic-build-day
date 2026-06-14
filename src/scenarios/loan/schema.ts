// The loan pack's typed contract. The refund pack's ScenarioPackSchema is
// fixture-shaped with refund-specific ground truth (correct_action, dollar
// impact), so the loan pack defines its own population-shaped schema rather than
// bending the frozen refund contract. It mirrors the same conventions: a string
// id, a one-paragraph brief, an array of ToolDossier (instantiated as synthetic
// tools through the GENERIC kernel, with no hand-coded loan kernels), and a
// train/held-out split by applicant id. The unit of work is an applicant, not a
// fixture: visible application fields the agent can query through the tools, plus
// hidden ground truth the multi-objective judge alone reads.

import { z } from "zod";
import { ToolDossierSchema } from "@/engine";

// The terminal action the underwriting agent takes per applicant. Unlike the
// refund task there is no single correct action: the judge scores the portfolio
// of decisions against hidden outcomes, so the same action can be right on one
// applicant and wrong on another.
export const LoanDecisionSchema = z.enum([
  "approve",
  "decline",
  "counter_offer",
  "request_more_info",
]);
export type LoanDecision = z.infer<typeof LoanDecisionSchema>;

// The protected-class attribute used only for fair-lending scoring. It is a
// neutral group label, never a real demographic, so the world stays synthetic
// while still letting the judge measure approval-rate disparity and bias in the
// rationale. The agent can read it on the application (a faithful fairness trap:
// the signal is present, and acting on it is what the fair-lending constraint
// punishes), but a sound policy must not let it drive the decision.
export const ProtectedClassSchema = z.enum(["group_a", "group_b"]);
export type ProtectedClass = z.infer<typeof ProtectedClassSchema>;

// The true repayment outcome of an applicant, were the full loan booked. The
// judge uses it to compute realized yield and expected loss. It is correlated
// with the queryable signals (a low score and thin cashflow default more often)
// but with realistic noise, so no blanket threshold on any single signal is
// optimal and judgment across signals matters.
export const TrueOutcomeSchema = z.enum(["repay", "default"]);
export type TrueOutcome = z.infer<typeof TrueOutcomeSchema>;

// The latent risk tier the applicant truly belongs to, independent of which
// signals happen to be noisy. Used by the population generator to balance the
// mix (clearly-good, clearly-bad, genuinely-marginal) and by the judge for
// diagnostics; it is never visible to the agent.
export const TrueRiskTierSchema = z.enum(["prime", "near_prime", "subprime"]);
export type TrueRiskTier = z.infer<typeof TrueRiskTierSchema>;

// The visible application fields the agent can query. These are the facts a real
// application form carries; the bureau, bank, and fraud tools add the rest of
// the signal. principal_cents is the requested loan amount; term_months its
// length; stated_income_cents the applicant's self-reported income (which the
// bank-transaction signal can corroborate or contradict).
export const LoanApplicationSchema = z.object({
  applicant_id: z.string(),
  principal_cents: z.number().int().positive(),
  term_months: z.number().int().positive(),
  purpose: z.enum([
    "debt_consolidation",
    "home_improvement",
    "auto",
    "medical",
    "business",
    "other",
  ]),
  stated_income_cents: z.number().int().nonnegative(),
  // The protected-class attribute is part of the application the agent can see.
  // Its presence is intentional: the fair-lending constraint exists precisely
  // because the signal is available and must not be acted on.
  protected_class: ProtectedClassSchema,
});
export type LoanApplication = z.infer<typeof LoanApplicationSchema>;

// The hidden ground truth the judge scores against. None of this is returned by
// any tool: true_outcome and loss_given_default drive expected loss and yield,
// true_risk_tier balances the population, and protected_class (echoed here for
// the judge's disparity computation) anchors the fairness measurement.
export const LoanGroundTruthSchema = z.object({
  true_outcome: TrueOutcomeSchema,
  // Fraction of principal lost if this applicant is approved and defaults, in
  // [0,1]. A secured or well-documented loan recovers more on default (lower
  // LGD) than an unsecured thin-file one.
  loss_given_default: z.number().min(0).max(1),
  true_risk_tier: TrueRiskTierSchema,
  protected_class: ProtectedClassSchema,
});
export type LoanGroundTruth = z.infer<typeof LoanGroundTruthSchema>;

// Per-(tool, applicant) seed state: the keyed records written into each tool's
// slice before the harness starts, keyed by owning tool_id. This is the same
// shape the refund fixtures use, so the World Runner seeds a loan applicant's
// tools exactly the way it seeds a refund fixture's.
export const ApplicantSeedStateSchema = z.record(
  z.string(), // tool_id
  z.object({
    records: z.record(z.string(), z.record(z.string(), z.unknown())),
  }),
);
export type ApplicantSeedState = z.infer<typeof ApplicantSeedStateSchema>;

// One applicant: the visible application, the seed for every owning tool's
// hidden state (bureau, bank, fraud, guidelines), and the ground truth used only
// by the judge.
export const ApplicantSchema = z.object({
  applicant_id: z.string(),
  application: LoanApplicationSchema,
  hidden_state: ApplicantSeedStateSchema,
  ground_truth: LoanGroundTruthSchema,
});
export type Applicant = z.infer<typeof ApplicantSchema>;

// Train/held-out split by applicant id. The headline multi-objective score is
// computed on the held-out population; the eval sample bounds the live DSPy loop.
export const LoanSplitsSchema = z.object({
  train: z.array(z.string()),
  held_out: z.array(z.string()),
  // A small, configurable subset of applicant ids used by the live optimizer
  // loop so per-candidate cost stays bounded. The full population is used for
  // final scoring; the eval sample is a representative slice of it.
  eval_sample: z.array(z.string()),
});
export type LoanSplits = z.infer<typeof LoanSplitsSchema>;

// Population-level statistics, computed by the generator and asserted at load.
// These are the headline facts about the world: how many applicants, the base
// default rate, and the fraction that are genuinely marginal (the cases where
// judgment, not a blanket rule, decides the score).
export const PopulationStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  train_count: z.number().int().nonnegative(),
  held_out_count: z.number().int().nonnegative(),
  eval_sample_count: z.number().int().nonnegative(),
  // Fraction of the population whose true_outcome is "default".
  default_base_rate: z.number().min(0).max(1),
  // Fraction in the near_prime tier: the genuinely-marginal cases where a
  // counter-offer or a careful read of the signals, not a blanket threshold,
  // separates a good policy from a bad one.
  marginal_fraction: z.number().min(0).max(1),
  // Approval-base-rate inputs the judge's fairness check reads: the count of
  // applicants in each protected class, so a disparity can be normalized.
  protected_class_counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type PopulationStats = z.infer<typeof PopulationStatsSchema>;

// The full loan pack: id, brief, the population of applicants, the synthetic
// tool dossiers (instantiated through the generic kernel), the splits, and the
// computed population stats. Validated on load.
export const LoanScenarioPackSchema = z.object({
  id: z.string(),
  brief: z.string(),
  applicants: z.array(ApplicantSchema),
  dossiers: z.array(ToolDossierSchema),
  splits: LoanSplitsSchema,
  stats: PopulationStatsSchema,
});
export type LoanScenarioPack = z.infer<typeof LoanScenarioPackSchema>;
