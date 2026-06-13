// The policy kernel: the rule that was never a product. The refund policy lives
// as readable text plus structured clauses in this tool's slice of state. It is
// the company's intent in plain form: refunds within thirty days, original
// method only, manager approval over five hundred dollars, fraud review for
// serial refunders, never auto-refund a chargeback-flagged order. The kernel
// returns the policy faithfully; the harness simply has to choose to read it and
// gate on it. The naive harness never does.

import type { EgressRequest, ToolResponse } from "../contracts/index.js";
import { ScopedStore, errorResponse, jsonResponse } from "./shared.js";

const POLICY_PATH = /^\/policy\/?$/;

export function policyKernel(
  req: EgressRequest,
  store: ScopedStore,
): ToolResponse {
  if (req.method === "GET" && POLICY_PATH.test(req.path)) {
    return getPolicy(store);
  }
  return errorResponse(404, "not_found", `No route for ${req.method} ${req.path}.`);
}

function getPolicy(store: ScopedStore): ToolResponse {
  // The policy record holds the markdown text and the structured clauses; both
  // are seeded into state so the tool stays a pure read with no embedded rules.
  const policy = store.get("policy:refund");
  if (policy === undefined) {
    return errorResponse(404, "not_found", "No refund policy configured.");
  }
  return jsonResponse(200, policy, []);
}
