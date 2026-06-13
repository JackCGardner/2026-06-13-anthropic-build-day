// The orders kernel: the system of record for what was bought, when, how it was
// paid, and whether it is flagged. It owns three of the five ground-truth signals
// (purchase_date, original_payment_method, fraud_flag) and the stripe_charge_id
// that ties an order to its payment. It is a read API: it returns facts and
// enforces no money policy. An orders service does not refuse to tell you a date
// because the date is too old; that is the entire point. The only thing it
// enforces is order_exists.

import type { EgressRequest, ToolResponse } from "../contracts/index.js";
import {
  ScopedStore,
  errorResponse,
  jsonResponse,
  lastPathSegment,
} from "./shared.js";

const ORDER_PATH = /^\/orders\/[^/]+\/?$/;

export function ordersKernel(
  req: EgressRequest,
  store: ScopedStore,
): ToolResponse {
  if (req.method === "GET" && ORDER_PATH.test(req.path)) {
    return getOrder(req, store);
  }
  return errorResponse(404, "not_found", `No route for ${req.method} ${req.path}.`);
}

function getOrder(req: EgressRequest, store: ScopedStore): ToolResponse {
  const orderId = lastPathSegment(req.path);
  const order = store.get(`order:${orderId}`);
  // ENFORCED order_exists.
  if (order === undefined) {
    return errorResponse(404, "not_found", `No such order: '${orderId}'.`);
  }
  // Return the seeded facts verbatim, with the id echoed. No filtering, no
  // policy: the harness must choose to read and act on these fields itself.
  return jsonResponse(200, { id: orderId, ...order }, []);
}
