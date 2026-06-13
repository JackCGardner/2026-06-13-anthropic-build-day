// Seeding the synthetic world from a fixture. The World Runner owns the hidden
// state and resets it per fixture from the pack's seeds, scoped per tool so no
// tool is omniscient. Two id spaces meet here: the scenario pack keys hidden
// state by dossier tool id (orders, customers, stripe_payments, zendesk_support,
// policy_store), while the kernels are registered by their short service id
// (orders, customers, stripe, zendesk, policy). This module is the single place
// that maps between them and normalizes the seeded charge shape into the exact
// fields the Stripe kernel reads, so the kernel stays a faithful state machine
// and the fixtures stay readable.

import type { Fixture, WorldState } from "@/engine";
import {
  STRIPE_TOOL_ID,
  ORDERS_TOOL_ID,
  CUSTOMERS_TOOL_ID,
  POLICY_TOOL_ID,
  ZENDESK_TOOL_ID,
} from "@/engine/kernels/index.js";
import { REFUND_POLICY_MARKDOWN } from "@/scenarios/refund/index.js";

// The kernel service ids the harness routes egress to. These are the keys the
// World Runner stores hidden state under and the keys KERNELS is registered by.
export const KERNEL_TOOL_IDS = [
  STRIPE_TOOL_ID,
  ORDERS_TOOL_ID,
  CUSTOMERS_TOOL_ID,
  POLICY_TOOL_ID,
  ZENDESK_TOOL_ID,
] as const;
export type KernelToolId = (typeof KERNEL_TOOL_IDS)[number];

// The dossier tool id each kernel service is seeded from. The pack authors keep
// the descriptive dossier ids; the runner resolves them to the short kernel ids.
const DOSSIER_ID_FOR_KERNEL: Record<KernelToolId, string> = {
  [STRIPE_TOOL_ID]: "stripe_payments",
  [ORDERS_TOOL_ID]: "orders",
  [CUSTOMERS_TOOL_ID]: "customers",
  [POLICY_TOOL_ID]: "policy_store",
  [ZENDESK_TOOL_ID]: "zendesk_support",
};

// The Stripe kernel reads a flat charge shape: `amount`, `refunded_amount`,
// `disputed`, `risk_level`, `risk_score`. The fixtures seed charges in a
// wire-faithful shape with `amount_refunded` and nested `outcome.*` keys. This
// translates one charge record into the kernel's read shape without losing any
// seeded fact.
function normalizeChargeRecord(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const refundedAmount =
    typeof raw["refunded_amount"] === "number"
      ? raw["refunded_amount"]
      : typeof raw["amount_refunded"] === "number"
        ? raw["amount_refunded"]
        : 0;
  const riskLevel =
    typeof raw["risk_level"] === "string"
      ? raw["risk_level"]
      : typeof raw["outcome.risk_level"] === "string"
        ? (raw["outcome.risk_level"] as string)
        : "normal";
  const riskScore =
    typeof raw["risk_score"] === "number"
      ? raw["risk_score"]
      : typeof raw["outcome.risk_score"] === "number"
        ? (raw["outcome.risk_score"] as number)
        : 0;
  return {
    ...raw,
    refunded_amount: refundedAmount,
    risk_level: riskLevel,
    risk_score: riskScore,
  };
}

// Build a fresh, scoped WorldState for one (fixture, kernel tool). Records are
// copied so a run never mutates the pack's seed objects. The Stripe slice gets
// the hidden monthly budget; every charge record is normalized to the kernel's
// read shape.
function buildState(
  fixture: Fixture,
  kernelId: KernelToolId,
  seed: string,
): WorldState {
  const dossierId = DOSSIER_ID_FOR_KERNEL[kernelId];
  const slice = fixture.hidden_state[dossierId];
  const records: Record<string, Record<string, unknown>> = {};

  if (slice) {
    for (const [key, value] of Object.entries(slice.records)) {
      records[key] = key.startsWith("charge:")
        ? normalizeChargeRecord({ ...value })
        : { ...value };
    }
  }

  // The policy kernel reads "policy:refund"; seed it from the pack's markdown so
  // the policy tool stays a pure read with no embedded text.
  if (kernelId === POLICY_TOOL_ID && records["policy:refund"] === undefined) {
    records["policy:refund"] = { body: REFUND_POLICY_MARKDOWN };
  }

  // The zendesk kernel resolves the visible ticket; seed it from the fixture so
  // the harness can read the same ticket it was handed and update it to solved.
  if (kernelId === ZENDESK_TOOL_ID && records[`ticket:${fixture.ticket.id}`] === undefined) {
    records[`ticket:${fixture.ticket.id}`] = {
      subject: fixture.ticket.subject,
      description: fixture.ticket.body,
      requester_email: fixture.ticket.customer_email,
      status: "open",
      public: true,
      comments: [],
    };
    records["ticket:index"] = { ids: [fixture.ticket.id] };
  }

  const budget = slice?.monthly_refund_budget_cents;

  return {
    fixture_id: fixture.id,
    tool_id: kernelId,
    seed,
    version: 0,
    records,
    idempotency: {},
    counters: {},
    monthly_refund_budget_cents: typeof budget === "number" ? budget : 0,
  };
}

// The full per-fixture world: one scoped WorldState per kernel tool, keyed by
// kernel id. The runner dispatches an EgressRequest to KERNELS[tool_id] against
// the matching slice here.
export function seedWorld(
  fixture: Fixture,
  seed: string,
): Record<KernelToolId, WorldState> {
  const world = {} as Record<KernelToolId, WorldState>;
  for (const kernelId of KERNEL_TOOL_IDS) {
    world[kernelId] = buildState(fixture, kernelId, seed);
  }
  return world;
}
