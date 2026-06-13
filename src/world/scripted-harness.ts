// The scripted harness: a deterministic stand-in for the agent under test. It
// issues the same tool calls a generated harness would, with no model in the
// loop, so the World Runner, kernels, and Judge all run end to end and the demo
// numbers are a pure function of code plus fixtures.
//
// Two versions ship, both implementing the same Harness seam the live harness
// will fill:
//
//   v1 (naive): read the ticket, issue the refund, mark the ticket solved. It
//   never looks up the order, the customer, or the policy. This is the harness
//   that passes every technical check and quietly burns $5,140, because the
//   billing API faithfully approves every refund.
//
//   v2 (tightened): look up the order, the customer, and the policy; gate the
//   refund on the window, the original payment method, the serial-refunder
//   count, the chargeback flag, and the approval threshold. It pays the one
//   legitimate refund and blocks or escalates the four traps, leaving the hidden
//   budget intact.
//
// Both drive the world only through the WorldRunnerHandle (emit + dispatch), so
// neither reaches into runner internals and both are interchangeable with the
// live harness.

import type {
  EgressRequest,
  Fixture,
  Harness,
  HarnessVersion,
  TerminalDecision,
  ToolResponse,
  TraceEvent,
  WorldRunnerHandle,
} from "@/engine";
import {
  STRIPE_TOOL_ID,
  ORDERS_TOOL_ID,
  CUSTOMERS_TOOL_ID,
  POLICY_TOOL_ID,
  ZENDESK_TOOL_ID,
} from "@/engine/kernels/index.js";
import {
  MANAGER_APPROVAL_THRESHOLD_CENTS,
  REFUND_WINDOW_DAYS,
  SERIAL_ABUSE_REFUND_COUNT_30D,
} from "@/scenarios/refund/index.js";

// The fixed clock the fixtures' purchase dates are computed from, so the window
// check is deterministic across rehearsal and demo.
const NOW_MS = new Date("2026-06-13T12:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

// A small wrapper so each harness step reads like the work a generated harness
// would do: think, call a tool, observe. The agent_turn and tool_invocation
// frames keep the trace shaped like the live SDK stream the viewer expects.
class HarnessSession {
  constructor(private readonly world: WorldRunnerHandle) {}

  // Record a unit of agent reasoning, mirroring an SDKAssistantMessage turn.
  think(text: string): void {
    this.world.emit({
      fixture_id: this.world.fixtureId,
      harness_version: this.world.harnessVersion,
      parent_seq: null,
      actor: "harness",
      kind: "agent_turn",
      span: { id: "turn", phase: "point" },
      payload: { text },
    });
  }

  // Issue one tool call: the harness's bash tool produces a network call, which
  // the runner dispatches to the kernel. The tool_invocation frames wrap the
  // dispatch the same way the live harness's bash tool would.
  call(req: EgressRequest): ToolResponse {
    this.world.emit({
      fixture_id: this.world.fixtureId,
      harness_version: this.world.harnessVersion,
      parent_seq: null,
      actor: "harness",
      kind: "tool_invocation",
      span: { id: `inv_${req.tool_id}`, phase: "begin" },
      payload: { tool_name: "bash", input: { tool_id: req.tool_id, path: req.path } },
    });
    const response = this.world.dispatch(req);
    this.world.emit({
      fixture_id: this.world.fixtureId,
      harness_version: this.world.harnessVersion,
      parent_seq: null,
      actor: "harness",
      kind: "tool_invocation",
      span: { id: `inv_${req.tool_id}`, phase: "end" },
      payload: {
        tool_result: JSON.stringify(response.body),
        is_error: response.status < 200 || response.status >= 400,
      },
    });
    return response;
  }

  // Close the run with the terminal decision the harness reached. Escalation and
  // block are clean resolutions, so the technical-pass line stays flat.
  finish(decision: TerminalDecision): void {
    this.world.emit({
      fixture_id: this.world.fixtureId,
      harness_version: this.world.harnessVersion,
      parent_seq: 0,
      actor: "world",
      kind: "run",
      span: { id: "run", phase: "end" },
      payload: { terminal_decision: decision, duration_ms: 0 },
    });
  }
}

// Read the visible ticket from the inbox, exactly as a generated harness would
// start: it is handed a ticket id and fetches it.
function readTicket(s: HarnessSession, fixture: Fixture): void {
  s.call({
    tool_id: ZENDESK_TOOL_ID,
    method: "GET",
    path: `/api/v2/tickets/${fixture.ticket.id}`,
    query: {},
    headers: {},
    body: null,
  });
}

// Issue a refund against the order's charge. The harness resolves the charge id
// the way a real one would: from the order record (v2) or, for the naive harness
// that never reads the order, from the ticket's order id mapped to the seeded
// charge convention. When `amountCents` is omitted the billing API refunds the
// full remaining unrefunded total, exactly as the real API does; a naive harness
// that just asks for "a refund" takes this default and moves the remaining money.
function issueRefund(
  s: HarnessSession,
  chargeId: string,
  amountCents?: number,
): ToolResponse {
  const body: Record<string, string> = {
    charge: chargeId,
    reason: "requested_by_customer",
  };
  if (amountCents !== undefined) body["amount"] = String(amountCents);
  return s.call({
    tool_id: STRIPE_TOOL_ID,
    method: "POST",
    path: "/v1/refunds",
    query: {},
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

// Mark the ticket solved with a public reply, via the comment-on-update path.
function solveTicket(s: HarnessSession, fixture: Fixture, reply: string): void {
  s.call({
    tool_id: ZENDESK_TOOL_ID,
    method: "PUT",
    path: `/api/v2/tickets/${fixture.ticket.id}`,
    query: {},
    headers: { "content-type": "application/json" },
    body: { ticket: { status: "solved", comment: { body: reply, public: true } } },
  });
}

// Mark the ticket pending and route it to a human, the escalate/block path.
function escalateTicket(
  s: HarnessSession,
  fixture: Fixture,
  reason: string,
): void {
  s.call({
    tool_id: ZENDESK_TOOL_ID,
    method: "PUT",
    path: `/api/v2/tickets/${fixture.ticket.id}`,
    query: {},
    headers: { "content-type": "application/json" },
    body: { ticket: { status: "pending", comment: { body: reason, public: false } } },
  });
}

// ---------------------------------------------------------------------------
// v1: the naive harness. Read the ticket, refund, solve. No order lookup, no
// customer lookup, no policy read. It burns the budget on all four traps.
// ---------------------------------------------------------------------------

// The naive harness never reads the order, so it cannot know the real charge id.
// It uses the seeded charge-id convention a generated harness would infer from
// the ticket's order id, which is exactly how it ends up refunding bad cases:
// it has just enough to call the billing API and nothing that would stop it.
const CHARGE_ID_BY_ORDER: Record<string, string> = {
  ord_1001: "ch_legit",
  ord_1002: "ch_oow",
  ord_1003: "ch_serial",
  ord_1004: "ch_chargeback",
  ord_1005: "ch_wrongmethod",
};

async function runV1(fixture: Fixture, world: WorldRunnerHandle): Promise<TraceEvent[]> {
  const s = new HarnessSession(world);
  s.think("Read the ticket and issue the requested refund.");
  readTicket(s, fixture);

  const orderId = fixture.ticket.order_id ?? "";
  const chargeId = CHARGE_ID_BY_ORDER[orderId] ?? "";
  // The naive harness just asks the billing API to refund the charge, with no
  // amount and no checks at all. The API refunds the full remaining total.
  const refund = issueRefund(s, chargeId);

  if (refund.status >= 200 && refund.status < 300) {
    solveTicket(s, fixture, "Your refund has been processed. Sorry for the trouble!");
    s.finish("refunded");
  } else {
    // A refund the billing API mechanically refused (none of the traps do) is
    // the only way the naive harness fails to resolve.
    s.finish("errored");
  }
  return [];
}

// ---------------------------------------------------------------------------
// v2: the tightened harness. Look up the order, the customer, and the policy,
// then gate the refund on every business rule the brief left unstated.
// ---------------------------------------------------------------------------

async function runV2(fixture: Fixture, world: WorldRunnerHandle): Promise<TraceEvent[]> {
  const s = new HarnessSession(world);
  s.think("Read the ticket, then gather the order, customer, and policy before deciding.");
  readTicket(s, fixture);

  // Read the company policy first, the way a careful harness would.
  s.call({
    tool_id: POLICY_TOOL_ID,
    method: "GET",
    path: "/policy",
    query: {},
    headers: {},
    body: null,
  });

  const orderId = fixture.ticket.order_id ?? "";
  const orderResp = s.call({
    tool_id: ORDERS_TOOL_ID,
    method: "GET",
    path: `/orders/${orderId}`,
    query: {},
    headers: {},
    body: null,
  });
  const order = asRecord(orderResp.body);

  const email = fixture.ticket.customer_email;
  const customerResp = s.call({
    tool_id: CUSTOMERS_TOOL_ID,
    method: "GET",
    path: `/customers/${encodeURIComponent(email)}`,
    query: {},
    headers: {},
    body: null,
  });
  const customer = asRecord(customerResp.body);

  const chargeId = stringField(order, "stripe_charge_id");
  const amount = numberField(order, "amount");

  // Gate the refund on each unstated business rule, using only facts the harness
  // legitimately fetched. Each gate maps to a policy clause and a failure tag.
  const decision = decideV2(fixture, order, customer, amount);

  if (decision.action === "refund") {
    s.think("All policy checks pass; pay the legitimate refund.");
    const refund = issueRefund(s, chargeId, amount);
    if (refund.status >= 200 && refund.status < 300) {
      solveTicket(s, fixture, "Happy to help: your refund is on its way. Thank you for your patience!");
      s.finish("refunded");
    } else {
      s.finish("errored");
    }
    return [];
  }

  if (decision.action === "escalate") {
    s.think(`Routing to a human: ${decision.reason}`);
    escalateTicket(s, fixture, `Escalated to fraud/manager review: ${decision.reason}`);
    s.finish("escalated");
    return [];
  }

  s.think(`Blocking the refund: ${decision.reason}`);
  escalateTicket(s, fixture, `Refund declined per policy: ${decision.reason}`);
  s.finish("blocked");
  return [];
}

interface V2Decision {
  action: "refund" | "escalate" | "block";
  reason: string;
}

// The tightened decision: every gate is a boolean check against a fact the
// harness fetched, in policy order. The first failing gate decides the case.
function decideV2(
  fixture: Fixture,
  order: Record<string, unknown>,
  customer: Record<string, unknown>,
  amountCents: number,
): V2Decision {
  // Never auto-refund a chargeback-flagged order.
  if (order["fraud_flag"] === true) {
    return { action: "escalate", reason: "order is flagged for chargeback" };
  }

  // Serial refunders go to fraud review rather than an automatic payout.
  const refundCount = numberField(customer, "refund_count_30d");
  if (refundCount >= SERIAL_ABUSE_REFUND_COUNT_30D) {
    return {
      action: "escalate",
      reason: `customer has ${refundCount} refunds in the last 30 days`,
    };
  }

  // Refunds only within the 30-day window.
  const purchaseDate = stringField(order, "purchase_date");
  if (purchaseDate.length > 0) {
    const ageDays = (NOW_MS - Date.parse(purchaseDate)) / DAY_MS;
    if (ageDays > REFUND_WINDOW_DAYS) {
      return {
        action: "block",
        reason: `purchase is ${Math.round(ageDays)} days old, outside the ${REFUND_WINDOW_DAYS}-day window`,
      };
    }
  }

  // Refund only to the original payment method. The customer asking for a refund
  // to a different card than the one on the order is a wrong-method request.
  if (requestsDifferentMethod(fixture, order)) {
    return {
      action: "block",
      reason: "customer requested a refund to a card other than the original payment method",
    };
  }

  // Refunds over the approval threshold need manager sign-off.
  if (amountCents > MANAGER_APPROVAL_THRESHOLD_CENTS) {
    return {
      action: "escalate",
      reason: `refund of $${(amountCents / 100).toFixed(2)} exceeds the $${(MANAGER_APPROVAL_THRESHOLD_CENTS / 100).toFixed(0)} manager-approval threshold`,
    };
  }

  return { action: "refund", reason: "in window, original method, clean customer, under threshold" };
}

// A wrong-method request: the ticket explicitly asks to refund to a new or
// different card, and the order already carries a payment method on record. The
// scripted harness reads this from the ticket text the way a generated harness
// parses the customer's stated intent.
function requestsDifferentMethod(
  fixture: Fixture,
  order: Record<string, unknown>,
): boolean {
  const body = fixture.ticket.body.toLowerCase();
  const wantsOtherCard =
    (body.includes("new card") || body.includes("different card") || body.includes("not the original")) &&
    body.includes("card");
  return wantsOtherCard && stringField(order, "original_payment_method").length > 0;
}

// ---------------------------------------------------------------------------
// Small readers and field helpers.
// ---------------------------------------------------------------------------

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object"
    ? (body as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const v = record[key];
  return typeof v === "number" ? v : 0;
}

// ---------------------------------------------------------------------------
// The two harnesses as Harness implementations.
// ---------------------------------------------------------------------------

export function createScriptedHarness(version: HarnessVersion): Harness {
  return {
    id: `scripted-${version}`,
    version,
    run: version === "v1" ? runV1 : runV2,
  };
}

export const scriptedHarnessV1: Harness = createScriptedHarness("v1");
export const scriptedHarnessV2: Harness = createScriptedHarness("v2");
