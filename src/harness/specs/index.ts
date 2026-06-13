// The pinned harness specs and a typed loader. The specs are committed
// artifacts: the rule-silent v1 the under-specified brief produces and the
// tightened v2. The loader validates a spec against the frozen HarnessSpecSchema
// and returns the typed value, so a malformed spec fails loudly at load time
// rather than silently downstream in the live harness or the gates.

import { HarnessSpecSchema, type HarnessSpec } from "./types.js";
import { REFUND_HARNESS_SPEC_V1 } from "./refund-v1.js";
import { REFUND_HARNESS_SPEC_V2 } from "./refund-v2.js";

export type {
  HarnessSpec,
  ToolManifestEntry,
  SpecEnforcedConstraint,
} from "./types.js";
export { HarnessSpecSchema } from "./types.js";
export { REFUND_HARNESS_SPEC_V1 } from "./refund-v1.js";
export { REFUND_HARNESS_SPEC_V2 } from "./refund-v2.js";

// The pinned specs keyed by version, for callers that select by harness version.
export const PINNED_REFUND_SPECS: Record<"v1" | "v2", HarnessSpec> = {
  v1: REFUND_HARNESS_SPEC_V1,
  v2: REFUND_HARNESS_SPEC_V2,
};

// Validate a candidate spec against the frozen schema and return the typed
// value. Throws on any schema violation.
export function loadHarnessSpec(candidate: unknown): HarnessSpec {
  return HarnessSpecSchema.parse(candidate);
}

// Load a pinned refund spec by version, validating it on the way out.
export function loadPinnedRefundSpec(version: "v1" | "v2"): HarnessSpec {
  return loadHarnessSpec(PINNED_REFUND_SPECS[version]);
}
