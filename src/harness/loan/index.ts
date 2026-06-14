// The loan harness module: the optimizable loan underwriting spec, the loan
// function tools (which dispatch in-process through the run's handle into the
// generic kernels), and the live loan harness that drives a real model over those
// tools. Everything except the model call itself is keyless; the live harness
// checks for a credential at run time and throws MissingApiKeyError without
// touching the network if none is present.

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
  type LoanHarnessSpec,
  type LoanToolManifestEntry,
} from "./loan-harness-spec.js";

export {
  buildLoanFunctionTools,
  loanQualifiedToolName,
  LOAN_FUNCTION_TOOL_SERVER_NAME,
  LOAN_DECISION_KEY_PREFIX,
  type BuiltLoanFunctionTool,
} from "./loan-function-tools.js";

export {
  createLiveLoanHarness,
  type LiveLoanHarness,
  type LiveLoanHarnessOptions,
} from "./loan-live-harness.js";
