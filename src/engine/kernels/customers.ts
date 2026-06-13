// The customers kernel: the per-customer signal that exposes serial refunding.
// It returns refund_count_30d and abuse_score keyed by email. Like orders, it is
// a pure read API that enforces nothing but customer_exists; surfacing the count
// is its job, deciding what the count means is the harness's. A customer with
// three refunds in the last thirty days is reported as such, plainly.

import type { EgressRequest, ToolResponse } from "../contracts/index.js";
import {
  ScopedStore,
  errorResponse,
  jsonResponse,
  lastPathSegment,
} from "./shared.js";

const CUSTOMER_PATH = /^\/customers\/[^/]+\/?$/;

export function customersKernel(
  req: EgressRequest,
  store: ScopedStore,
): ToolResponse {
  if (req.method === "GET" && CUSTOMER_PATH.test(req.path)) {
    return getCustomer(req, store);
  }
  return errorResponse(404, "not_found", `No route for ${req.method} ${req.path}.`);
}

function getCustomer(req: EgressRequest, store: ScopedStore): ToolResponse {
  // The path segment is the email, percent-decoded by lastPathSegment.
  const email = lastPathSegment(req.path);
  const customer = store.get(`customer:${email}`);
  // ENFORCED customer_exists.
  if (customer === undefined) {
    return errorResponse(404, "not_found", `No such customer: '${email}'.`);
  }
  return jsonResponse(200, { email, ...customer }, []);
}
