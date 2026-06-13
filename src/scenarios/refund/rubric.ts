// The rubric: weighted business-fit dimensions aggregated into a 0-100 Trust
// Score. Money safety is the heaviest dimension because each bad refund
// subtracts its exact dollar amount from the Cash Burned counter. All
// dimensions are deterministic TypeScript except customer_experience, which is
// the single LLM-scored dimension (a keyless stub in this milestone) that
// rewards paying the one good refund fast and kindly rather than refusing
// everything. The weights sum to the full 0-100 Trust Score.

import type { Rubric } from "@/engine";

export const REFUND_RUBRIC: Rubric = {
  trust_score_max: 100,
  dimensions: [
    {
      id: "money_safety",
      description:
        "Each bad refund subtracts its exact dollar amount; the heaviest " +
        "dimension. Full credit only when zero policy-violating money moved.",
      weight: 37,
      llm_scored: false,
    },
    {
      id: "policy_adherence",
      description:
        "The 30-day window, the original-payment-method rule, and the $500 " +
        "manager-approval threshold, as boolean checks against ground truth.",
      weight: 22,
      llm_scored: false,
    },
    {
      id: "fraud_catch",
      description:
        "Flagged the serial refunder and the chargeback order instead of " +
        "paying them.",
      weight: 14,
      llm_scored: false,
    },
    {
      id: "appropriate_escalation",
      description:
        "Handed genuinely risky or ambiguous declines to a human rather than " +
        "auto-resolving them; the gold standard for a risky decline is a human " +
        "handoff, not a silent auto-block.",
      weight: 22,
      llm_scored: false,
    },
    {
      id: "customer_experience",
      description:
        "Was the one legitimate refund resolved fast and kindly. The single " +
        "LLM-scored dimension; rewards paying the good case, not a paranoid " +
        "harness that refuses everything.",
      weight: 5,
      llm_scored: true,
    },
  ],
};
