// The research pipeline's public API (doc 07 section 3). The pipeline turns an
// under-specified brief into a frozen ResearchBundle through typed stages, every
// web or model call gated behind the seam. The keyless reproduction path returns
// the committed refund bundle so the downstream generation pass is exercisable
// without a credential.

// The frozen artifacts and their schemas.
export type {
  IntakeAnswer,
  IntakePolicy,
  IntakeResult,
  Necessity,
  Capability,
  CapabilityGraph,
  CandidateKind,
  CandidateTool,
  AcquiredContract,
  GapKind,
  CompletenessGap,
  CompletenessStatus,
  CompletenessReport,
  ReviewDisposition,
  RuleReview,
  ResearchBundle,
} from "./types.js";
export {
  IntakeResultSchema,
  CapabilityGraphSchema,
  CandidateToolSchema,
  CompletenessReportSchema,
  ResearchBundleSchema,
  loadResearchBundle,
} from "./types.js";

// The seam and its credential gate.
export type {
  ResearchCapability,
  WebSearchResult,
  FetchedDocument,
} from "./seam.js";
export {
  MissingResearchCapabilityError,
  createLiveResearchCapability,
  hasResearchCredential,
  hasWebAccess,
  hasResearchCapability,
} from "./seam.js";

// The typed stages.
export type {
  IntakeQuestion,
  IntakeAnswerProvider,
  RuleReviewProvider,
} from "./stages.js";
export {
  intakeInterview,
  decomposeCapabilities,
  discoverCandidates,
  acquireContracts,
  completenessCheck,
  reviewBusinessRules,
  commitResearchBundle,
} from "./stages.js";

// The live orchestrator.
export type { ResearchBriefInput } from "./pipeline.js";
export { researchBrief } from "./pipeline.js";

// The keyless reproduction.
export { reproduceRefundBundle } from "./reproduce.js";

// The generation pass over a committed bundle (doc 07 section 5).
export type { BundleGenerationResult } from "./generate-from-bundle.js";
export {
  generateFromBundle,
  checkBundleGates,
  bundleToGenerateInput,
} from "./generate-from-bundle.js";

// The runnable synthetic world initialized from a bundle.
export type {
  InitializedTool,
  InitializedWorld,
  GenericSweepVersionResult,
} from "./initialize-world.js";
export { initializeWorld, sweepGenericWorld } from "./initialize-world.js";

// Content addressing.
export { contentHash } from "./hash.js";
