// Deterministic State Kernels: one per synthetic tool (stripe, orders,
// customers, policy, zendesk). Each enforces only its dossier's enforced
// invariants and mutates a scoped slice of hidden world state through a
// ScopedStore. No model call sits in any request path; ids are seeded and
// monotonic, so the same request against the same state always yields the same
// ToolResponse and the same state_mutations.
//
// Every kernel here is exposed as a ToolKernel from the frozen seams contract:
// a pure-ish (EgressRequest, WorldState) => ToolResponse. The inner kernel
// functions take a ScopedStore so state access and mutation logging stay in one
// place; the adapter below constructs the store, runs the kernel, and returns
// the typed response with its echoed deltas. The store mutates the WorldState
// object in place (bumping `version` on every delta), which is what the World
// Runner reads back after dispatch.

import type {
  EgressRequest,
  ToolKernel,
  ToolResponse,
  WorldState,
} from "../contracts/index.js";
import { ScopedStore } from "./shared.js";
import { stripeKernel } from "./stripe.js";
import { ordersKernel } from "./orders.js";
import { customersKernel } from "./customers.js";
import { policyKernel } from "./policy.js";
import { zendeskKernel } from "./zendesk.js";

export { ScopedStore } from "./shared.js";
export {
  createGenericKernel,
  INVARIANT_REGISTRY,
} from "./generic-kernel.js";
export type {
  InvariantType,
  InvariantChecker,
  InvariantContext,
  InvariantViolation,
} from "./generic-kernel.js";
export { stripeKernel } from "./stripe.js";
export { ordersKernel } from "./orders.js";
export { customersKernel } from "./customers.js";
export { policyKernel } from "./policy.js";
export { zendeskKernel } from "./zendesk.js";

// The canonical tool ids for the refund scenario pack. These match the
// per-(fixture, tool) scoping the World Runner uses to route an EgressRequest to
// the right slice of hidden state.
export const STRIPE_TOOL_ID = "stripe" as const;
export const ORDERS_TOOL_ID = "orders" as const;
export const CUSTOMERS_TOOL_ID = "customers" as const;
export const POLICY_TOOL_ID = "policy" as const;
export const ZENDESK_TOOL_ID = "zendesk" as const;

// The inner kernel signature: a function over the scoped store and the request.
type InnerKernel = (req: EgressRequest, store: ScopedStore) => ToolResponse;

// Wrap an inner kernel as a ToolKernel: build the store over the passed-in
// WorldState (mutated in place), run the kernel, and hand back the response.
function asToolKernel(inner: InnerKernel): ToolKernel {
  return (req: EgressRequest, state: WorldState): ToolResponse => {
    const store = new ScopedStore(state);
    return inner(req, store);
  };
}

// The five kernels as ToolKernels, keyed by tool id. The World Runner picks the
// kernel by the resolved tool_id and dispatches the normalized EgressRequest.
export const KERNELS: Record<string, ToolKernel> = {
  [STRIPE_TOOL_ID]: asToolKernel(stripeKernel),
  [ORDERS_TOOL_ID]: asToolKernel(ordersKernel),
  [CUSTOMERS_TOOL_ID]: asToolKernel(customersKernel),
  [POLICY_TOOL_ID]: asToolKernel(policyKernel),
  [ZENDESK_TOOL_ID]: asToolKernel(zendeskKernel),
};

// A stable, ordered list of (tool_id, kernel) pairs for callers that prefer to
// iterate, e.g. when registering dispatch routes.
export const KERNEL_LIST: ReadonlyArray<{ tool_id: string; kernel: ToolKernel }> =
  [
    { tool_id: STRIPE_TOOL_ID, kernel: KERNELS[STRIPE_TOOL_ID]! },
    { tool_id: ORDERS_TOOL_ID, kernel: KERNELS[ORDERS_TOOL_ID]! },
    { tool_id: CUSTOMERS_TOOL_ID, kernel: KERNELS[CUSTOMERS_TOOL_ID]! },
    { tool_id: POLICY_TOOL_ID, kernel: KERNELS[POLICY_TOOL_ID]! },
    { tool_id: ZENDESK_TOOL_ID, kernel: KERNELS[ZENDESK_TOOL_ID]! },
  ];

// Resolve a kernel by tool id, or undefined for an unknown tool. The gateway
// rejects unknown tools loud rather than serving a default.
export function kernelFor(toolId: string): ToolKernel | undefined {
  return KERNELS[toolId];
}
