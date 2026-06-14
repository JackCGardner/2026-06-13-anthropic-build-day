// The Loan Decisioning scenario pack: brief, the loan-specific applicant /
// ground-truth schema, the seeded population generator, the synthetic tool
// dossiers (instantiated through the generic kernel, no hand-coded loan
// kernels), the lending guidelines document, and the typed loader that assembles
// and validates the whole pack. This is the second pack alongside refund, proving
// the framework generalizes to a harder, multi-objective problem.

export { LOAN_PACK_ID, LOAN_BRIEF } from "./brief.js";
export {
  INTEREST_MARGIN_ANNUAL,
  COUNTER_OFFER_YIELD_FRACTION,
  COUNTER_OFFER_EXPOSURE_FRACTION,
  FAIR_LENDING_DISPARITY_BOUND,
  RATIONALE_QUALITY_FLOOR,
  INFO_GATHER_FLOOR,
  INFO_GATHER_CEILING,
} from "./brief.js";
export { LOAN_DOSSIERS } from "./dossiers.js";
export { LENDING_GUIDELINES_MARKDOWN } from "./guidelines.js";
export { generatePopulation, LOAN_POPULATION_SIZE } from "./population.js";
export {
  loadLoanPack,
  DEFAULT_EVAL_SAMPLE_SIZE,
  type LoadLoanPackOptions,
} from "./loader.js";
export {
  LoanScenarioPackSchema,
  LoanDecisionSchema,
  ApplicantSchema,
  LoanApplicationSchema,
  LoanGroundTruthSchema,
  ProtectedClassSchema,
  TrueOutcomeSchema,
  TrueRiskTierSchema,
  LoanSplitsSchema,
  PopulationStatsSchema,
  type LoanScenarioPack,
  type LoanDecision,
  type Applicant,
  type LoanApplication,
  type LoanGroundTruth,
  type ProtectedClass,
  type TrueOutcome,
  type TrueRiskTier,
  type LoanSplits,
  type PopulationStats,
} from "./schema.js";
