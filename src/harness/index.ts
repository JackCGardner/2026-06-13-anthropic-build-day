// The harness module: the pinned harness specs, the typed spec loader, the
// generator with its deterministic consistency gates, and the live harness that
// drives a real model through the Agent SDK query() loop. Everything except the
// live model call itself is keyless; the live harness checks for a credential at
// run time and throws MissingApiKeyError without touching the network if none is
// present, so it builds and typechecks keyless alongside the rest.

export * from "./specs/index.js";
export * from "./generator.js";
export type { LiveCxScorerFactory } from "./cx-scorer-seam.js";
export {
  createLiveHarness,
  hasModelCredential,
  MissingApiKeyError,
} from "./live-harness.js";
export type { LiveHarnessOptions } from "./live-harness.js";
export {
  buildFunctionTools,
  qualifiedToolName,
  FUNCTION_TOOL_SERVER_NAME,
} from "./function-tools.js";
export type { BuiltFunctionTool } from "./function-tools.js";
export {
  GateSchema,
  GateLookupSchema,
  GateCheckSchema,
  GateOnFailSchema,
  ToolRulesSchema,
  StructuredHarnessSpecSchema,
  FULL_REFUND_GATE_SET,
  toStructuredSpec,
  loadStructuredSpec,
} from "./structured-spec.js";

// The loan harness surface: the optimizable loan underwriting spec, the loan
// function tools, and the live loan harness. It is the second pack's harness
// alongside the refund harness above, sharing the same live-harness credential
// guard and trace conventions.
export {
  LoanHarnessSpecSchema,
  LoanToolManifestEntrySchema,
  loadLoanHarnessSpec,
  LOAN_TOOL_MANIFEST,
  LOAN_HARNESS_MODEL,
  LOAN_SEED_SYSTEM_PROMPT,
  LOAN_SEED_PROCEDURE,
  LOAN_SUCCESS_CRITERION,
  LOAN_HARNESS_SPEC_SEED,
  buildLoanFunctionTools,
  loanQualifiedToolName,
  LOAN_FUNCTION_TOOL_SERVER_NAME,
  LOAN_DECISION_KEY_PREFIX,
  createLiveLoanHarness,
} from "./loan/index.js";
export type {
  LoanHarnessSpec,
  LoanToolManifestEntry,
  BuiltLoanFunctionTool,
  LiveLoanHarness,
  LiveLoanHarnessOptions,
} from "./loan/index.js";
export type {
  Gate,
  GateLookup,
  GateCheck,
  GateOnFail,
  ToolRules,
  StructuredHarnessSpec,
} from "./structured-spec.js";
