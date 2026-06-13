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
