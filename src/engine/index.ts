// The engine: trace contracts, the judge, and the deterministic kernels that
// run the synthetic world. Concrete modules are added by their owning agents.
export * from "./contracts/index.js";
export * from "./judge.js";
export * from "./terminal-decision.js";

// The loan multi-objective judge is the second pack's scorer. It depends on the
// loan pack's applicant/ground-truth types, which themselves import shared types
// from this index, so it is exported from its own module path
// (@/engine/loan-judge.js) rather than re-exported here to keep the engine
// barrel free of a scenario import cycle.
