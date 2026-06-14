// The loan underwriting harness spec: the surface DSPy optimizes for the loan
// pack, parallel to the pinned refund spec but population-shaped. Where the
// refund spec is bound to the frozen HarnessSpecSchema (v1/v2, refund tools),
// the loan world has four terminal actions, no single right answer per
// applicant, and a multi-objective score, so it defines its own typed spec
// rather than bending the frozen refund contract.
//
// The optimizable surface is exactly two fields: the system_prompt and the
// ordered procedure. The tool manifest, the submit-decision contract, and the
// model are fixed, so the optimizer is scored purely on the instruction text,
// the same discipline the refund bridge enforces.

import { z } from "zod";

// One read tool the underwriting agent can call. `tool_id` is the dossier the
// call dispatches into through the generic kernel; `op_id` is the operation;
// `description` is public prose only (what the tool returns), never a lending
// rule. The loan dossiers enforce no policy, so there is nothing hidden to leak.
export const LoanToolManifestEntrySchema = z.object({
  name: z.string(),
  tool_id: z.string(),
  op_id: z.string(),
  description: z.string(),
});
export type LoanToolManifestEntry = z.infer<typeof LoanToolManifestEntrySchema>;

// The loan harness spec. The version is a free-form label so the optimizer can
// name candidate generations without colliding with the refund v1/v2 enum.
export const LoanHarnessSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  // The model the live harness drives. Pinned to Opus for the live path.
  model: z.string(),
  // The optimizable system prompt handed to the agent.
  system_prompt: z.string(),
  // The read tools the agent may call, each dispatching into a loan dossier.
  tool_manifest: z.array(LoanToolManifestEntrySchema),
  // The optimizable ordered procedure the agent should follow.
  procedure: z.array(z.string()),
  // The single line the agent is reminded it is judged on. Not a rule list: the
  // tradeoffs are the agent's to weigh, which is the headroom DSPy optimizes.
  success_criterion: z.string(),
});
export type LoanHarnessSpec = z.infer<typeof LoanHarnessSpecSchema>;

// Validate a candidate loan harness spec against the schema and return the typed
// value. Throws on any violation so a malformed candidate fails at load time.
export function loadLoanHarnessSpec(candidate: unknown): LoanHarnessSpec {
  return LoanHarnessSpecSchema.parse(candidate);
}

// The fixed loan tool manifest. Five read tools, one per loan dossier, plus the
// submit_decision capture tool the harness wires separately (it is not a world
// read, so it is not in the manifest). Every entry's tool_id/op_id matches a
// LOAN_DOSSIERS operation, so each resolves to a real generic kernel route.
export const LOAN_TOOL_MANIFEST: LoanToolManifestEntry[] = [
  {
    name: "read_application",
    tool_id: "application",
    op_id: "get_application",
    description:
      "Read the submitted application: requested amount, term, purpose, " +
      "stated income, and a reporting group attribute.",
  },
  {
    name: "pull_credit_report",
    tool_id: "credit_bureau",
    op_id: "get_report",
    description:
      "Pull the credit bureau report: credit score, open accounts, " +
      "derogatory count, recent delinquencies, inquiries, and account age.",
  },
  {
    name: "analyze_bank_transactions",
    tool_id: "bank_transactions",
    op_id: "get_cashflow",
    description:
      "Analyze bank transactions: observed monthly income, income " +
      "volatility, average balance, recent NSF events, and existing debt " +
      "payments.",
  },
  {
    name: "check_fraud_signal",
    tool_id: "fraud_signal",
    op_id: "get_signal",
    description:
      "Check the fraud vendor signal: a fraud risk score and the identity " +
      "and velocity flags that drove it.",
  },
  {
    name: "read_lending_guidelines",
    tool_id: "lending_guidelines",
    op_id: "get_guidelines",
    description:
      "Read the desk's written lending guidelines and risk appetite. It " +
      "states ranges and priorities, not pass/fail thresholds.",
  },
];

// The default model the live loan harness drives. Pinned to Opus, matching the
// refund live path and the loan live judge.
export const LOAN_HARNESS_MODEL = "claude-opus-4-8";

// A decent starting underwriting instruction: the seed the optimizer improves.
// It tells the agent to gather the signals that matter, weigh the guidelines and
// risk appetite, choose among the four actions, and write a grounded rationale.
// It is deliberately competent but under-specified: it names no thresholds and
// no single right action, because the tradeoffs are exactly what the optimizer
// has to learn to balance against the multi-objective score.
export const LOAN_SEED_SYSTEM_PROMPT =
  "You are an underwriting agent for a consumer lending desk. For each " +
  "applicant, gather the signals that matter, weigh them against the desk's " +
  "lending guidelines and risk appetite, and reach one terminal decision: " +
  "approve, decline, counter-offer (a smaller or shorter loan for a marginal " +
  "applicant), or request more information. The desk earns a thin interest " +
  "margin on loans that repay and loses principal on loans that default, so " +
  "neither approving everyone nor declining everyone is sound: price risk and " +
  "use the counter-offer to bank marginal applicants at reduced exposure. The " +
  "group attribute on the application is for reporting only and must never " +
  "influence a decision or appear in a rationale. Write a short rationale that " +
  "names the signals you relied on and is consistent with the action you took.";

// The seed procedure. Read the application first, gather the signals, read the
// guidelines, decide, and submit. Concise on purpose so the optimizer starts
// near the rule budget the regularizers reward.
export const LOAN_SEED_PROCEDURE: string[] = [
  "Read the application to understand the requested amount, term, and purpose.",
  "Pull the credit report, analyze bank transactions, and check the fraud signal.",
  "Read the lending guidelines and weigh the signals against the risk appetite.",
  "Decide approve, decline, counter-offer, or request more information, and " +
    "submit the decision with a short rationale naming the signals you used.",
];

// The success criterion shown to the agent. It is the multi-objective goal in
// one line, not a checklist: maximize risk-adjusted yield while staying fair and
// well justified. The agent is told the shape of the score, not how to game it.
export const LOAN_SUCCESS_CRITERION =
  "Across the portfolio, maximize risk-adjusted yield (margin on repaid loans " +
  "net of losses on defaults) while keeping approvals fair across the group " +
  "attribute and every decision soundly justified.";

// The committed seed loan harness spec, used as the base the optimizer's
// candidate instruction is layered onto and as the keyless default.
export const LOAN_HARNESS_SPEC_SEED: LoanHarnessSpec = {
  id: "loan-harness-seed",
  version: "seed",
  model: LOAN_HARNESS_MODEL,
  system_prompt: LOAN_SEED_SYSTEM_PROMPT,
  tool_manifest: LOAN_TOOL_MANIFEST,
  procedure: LOAN_SEED_PROCEDURE,
  success_criterion: LOAN_SUCCESS_CRITERION,
};
