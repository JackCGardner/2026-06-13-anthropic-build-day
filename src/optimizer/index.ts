// The optimizer: the loop that improves a structured harness spec from judge
// feedback. proposeEdits proposes candidate edits across the full spec surface
// from the run's failure tags and trace; optimize runs the harness, judges it,
// evaluates each candidate by re-running and re-judging, and keeps a candidate
// only when the train Trust Score rises and technical pass holds at 100%. The
// proposer is a seam: a deterministic reference proposer drives the keyless loop,
// and an LLM proposer drops in behind the same interface when a credential is
// present. The held-out Trust Score is the headline metric.

export {
  optimize,
  interpreterHarnessFactory,
} from "./optimize.js";
export type {
  OptimizeOptions,
  OptimizerResult,
  OptimizerRound,
  CandidateOutcome,
  HarnessFactory,
} from "./optimize.js";

export {
  createDeterministicProposer,
} from "./proposer.js";
export type { EditProposer, CandidateEdit } from "./proposer.js";

export { createLlmProposer } from "./llm-proposer.js";
export type { LlmProposerOptions } from "./llm-proposer.js";
