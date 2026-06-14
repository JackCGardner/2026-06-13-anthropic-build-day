// The interpreter harness: a deterministic, keyless agent whose behavior is a
// pure function of a structured harness spec. It implements the same Harness seam
// the scripted and live harnesses fill and drives the world through the same
// runner, kernels, and trace, so the Judge scores its traces with no special
// casing. The live LLM harness is the real-world counterpart behind this seam;
// the interpreter is the substrate the optimizer is developed and CI-tested
// against without a model.
//
// The interpreter reads the spec's policy gates and nothing else to decide a
// case. With no gates it pays every refund, including the four traps, so the
// Cash Burned odometer climbs to $5,140. With the full gate set it performs the
// lookups the gates depend on, blocks or escalates the four traps, and still pays
// the one legitimate refund, leaving the hidden budget intact. Editing the spec
// therefore changes the interpreter's behavior, which is what makes the optimizer
// measurable: a proposed gate set is run through this interpreter and the Judge,
// and the keep-if-better rule selects on the resulting Trust Score.

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
import type {
  Gate,
  GateLookup,
  StructuredHarnessSpec,
} from "@/harness/structured-spec.js";

// The fixed clock the fixtures' purchase dates are computed from, matching the
// fixtures' anchor so the window check is deterministic across rehearsal and demo.
const NOW_MS = new Date("2026-06-13T12:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

// A thin session wrapper that emits the same agent_turn and tool_invocation
// frames the scripted harness emits, so the trace the interpreter writes is the
// same shape the Judge and the viewer already read. Every tool call flows through
// the runner's dispatch into the real kernels.
class InterpreterSession {
  constructor(private readonly world: WorldRunnerHandle) {}

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

  call(req: EgressRequest): ToolResponse {
    this.world.emit({
      fixture_id: this.world.fixtureId,
      harness_version: this.world.harnessVersion,
      parent_seq: null,
      actor: "harness",
      kind: "tool_invocation",
      span: { id: `inv_${req.tool_id}`, phase: "begin" },
      payload: {
        tool_name: "bash",
        input: { tool_id: req.tool_id, path: req.path },
      },
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

// The naive charge-id convention a generated harness infers from the ticket's
// order id when it never reads the order. This is how a gate-less interpreter
// still reaches the billing API on a trap case: it has just enough to call the
// refund endpoint and nothing that would stop it.
const CHARGE_ID_BY_ORDER: Record<string, string> = {
  ord_1001: "ch_legit",
  ord_1002: "ch_oow",
  ord_1003: "ch_serial",
  ord_1004: "ch_chargeback",
  ord_1005: "ch_wrongmethod",
};

// ---------------------------------------------------------------------------
// Tool calls. Each composes the EgressRequest the runner dispatches into the
// matching kernel, identical in shape to the scripted harness's calls.
// ---------------------------------------------------------------------------

function readTicket(s: InterpreterSession, fixture: Fixture): void {
  s.call({
    tool_id: ZENDESK_TOOL_ID,
    method: "GET",
    path: `/api/v2/tickets/${fixture.ticket.id}`,
    query: {},
    headers: {},
    body: null,
  });
}

function readPolicy(s: InterpreterSession): void {
  s.call({
    tool_id: POLICY_TOOL_ID,
    method: "GET",
    path: "/policy",
    query: {},
    headers: {},
    body: null,
  });
}

function lookupOrder(
  s: InterpreterSession,
  orderId: string,
): Record<string, unknown> {
  const resp = s.call({
    tool_id: ORDERS_TOOL_ID,
    method: "GET",
    path: `/orders/${orderId}`,
    query: {},
    headers: {},
    body: null,
  });
  return asRecord(resp.body);
}

function lookupCustomer(
  s: InterpreterSession,
  email: string,
): Record<string, unknown> {
  const resp = s.call({
    tool_id: CUSTOMERS_TOOL_ID,
    method: "GET",
    path: `/customers/${encodeURIComponent(email)}`,
    query: {},
    headers: {},
    body: null,
  });
  return asRecord(resp.body);
}

function issueRefund(
  s: InterpreterSession,
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

function solveTicket(
  s: InterpreterSession,
  fixture: Fixture,
  reply: string,
): void {
  s.call({
    tool_id: ZENDESK_TOOL_ID,
    method: "PUT",
    path: `/api/v2/tickets/${fixture.ticket.id}`,
    query: {},
    headers: { "content-type": "application/json" },
    body: { ticket: { status: "solved", comment: { body: reply, public: true } } },
  });
}

function routeToHuman(
  s: InterpreterSession,
  fixture: Fixture,
  note: string,
): void {
  s.call({
    tool_id: ZENDESK_TOOL_ID,
    method: "PUT",
    path: `/api/v2/tickets/${fixture.ticket.id}`,
    query: {},
    headers: { "content-type": "application/json" },
    body: { ticket: { status: "pending", comment: { body: note, public: false } } },
  });
}

// ---------------------------------------------------------------------------
// The decision: a pure function of the spec's gates and the facts they require.
// ---------------------------------------------------------------------------

interface Decision {
  action: "refund" | "escalate" | "block";
  reason: string;
}

// The facts the gates read, fetched once per run for whichever lookups the active
// gates depend on. A run with no gates fetches nothing, so a gate-less interpreter
// never reads the order or the customer, which is exactly the naive trace.
interface Facts {
  order: Record<string, unknown>;
  customer: Record<string, unknown>;
}

// Evaluate the spec's gates in order against the gathered facts. The first failing
// gate decides the case with its on_fail disposition; if every gate passes (or the
// spec has none), the action is to refund. The tool_rules ceiling, when present,
// is applied after the gates as a blanket escalation rail.
function decide(
  spec: StructuredHarnessSpec,
  fixture: Fixture,
  facts: Facts,
  amountCents: number,
): Decision {
  for (const gate of spec.policy_gates) {
    if (!gatePasses(gate, fixture, facts, amountCents)) {
      return { action: gate.on_fail, reason: gateReason(gate, facts, amountCents) };
    }
  }

  const ceiling = spec.tool_rules?.max_refund_amount_cents;
  if (ceiling !== undefined && amountCents > ceiling) {
    return {
      action: "escalate",
      reason: `refund of ${formatUsd(amountCents)} exceeds the configured ceiling of ${formatUsd(ceiling)}`,
    };
  }

  return { action: "refund", reason: "every active gate passed" };
}

// One gate's boolean predicate against the facts it required. A gate that reads a
// fact the harness did not fetch (because no active gate required that lookup)
// would see an empty record; the interpreter only evaluates gates whose lookups
// it performed, so this is always called with the fact present.
function gatePasses(
  gate: Gate,
  fixture: Fixture,
  facts: Facts,
  amountCents: number,
): boolean {
  switch (gate.check) {
    case "not_chargeback":
      return facts.order["fraud_flag"] !== true;
    case "refund_count_lt_3":
      return numberField(facts.customer, "refund_count_30d") < SERIAL_ABUSE_REFUND_COUNT_30D;
    case "within_window": {
      const purchaseDate = stringField(facts.order, "purchase_date");
      if (purchaseDate.length === 0) return true;
      const ageDays = (NOW_MS - Date.parse(purchaseDate)) / DAY_MS;
      return ageDays <= REFUND_WINDOW_DAYS;
    }
    case "original_method":
      return !requestsDifferentMethod(fixture, facts.order);
    case "amount_le_500_or_escalate":
      return amountCents <= MANAGER_APPROVAL_THRESHOLD_CENTS;
  }
}

function gateReason(gate: Gate, facts: Facts, amountCents: number): string {
  switch (gate.check) {
    case "not_chargeback":
      return "order is flagged for chargeback";
    case "refund_count_lt_3":
      return `customer has ${numberField(facts.customer, "refund_count_30d")} refunds in the last 30 days`;
    case "within_window": {
      const ageDays = (NOW_MS - Date.parse(stringField(facts.order, "purchase_date"))) / DAY_MS;
      return `purchase is ${Math.round(ageDays)} days old, outside the ${REFUND_WINDOW_DAYS}-day window`;
    }
    case "original_method":
      return "customer requested a refund to a card other than the original payment method";
    case "amount_le_500_or_escalate":
      return `refund of ${formatUsd(amountCents)} exceeds the ${formatUsd(MANAGER_APPROVAL_THRESHOLD_CENTS)} manager-approval threshold`;
  }
}

// A wrong-method request: the ticket explicitly asks to refund to a new or
// different card and the order carries a payment method on record. Read from the
// ticket text the way a harness parses the customer's stated intent.
function requestsDifferentMethod(
  fixture: Fixture,
  order: Record<string, unknown>,
): boolean {
  const body = fixture.ticket.body.toLowerCase();
  const wantsOtherCard =
    (body.includes("new card") ||
      body.includes("different card") ||
      body.includes("not the original")) &&
    body.includes("card");
  return wantsOtherCard && stringField(order, "original_payment_method").length > 0;
}

// ---------------------------------------------------------------------------
// The run loop, parameterized by the spec.
// ---------------------------------------------------------------------------

// The set of lookups the active gates require. The interpreter performs exactly
// these, so the trace records only the reads the spec's gates justify.
function requiredLookups(spec: StructuredHarnessSpec): Set<GateLookup> {
  const set = new Set<GateLookup>();
  for (const gate of spec.policy_gates) set.add(gate.requires_lookup);
  return set;
}

async function runSpec(
  spec: StructuredHarnessSpec,
  fixture: Fixture,
  world: WorldRunnerHandle,
): Promise<TraceEvent[]> {
  const s = new InterpreterSession(world);
  const lookups = requiredLookups(spec);

  if (spec.policy_gates.length === 0) {
    s.think("Read the ticket and issue the requested refund.");
  } else {
    s.think("Read the ticket, then gather the facts the policy gates require before deciding.");
  }
  readTicket(s, fixture);

  // Read the written policy when any gate depends on it, the way a careful
  // harness consults the policy document before acting.
  if (lookups.has("policy")) readPolicy(s);

  const orderId = fixture.ticket.order_id ?? "";

  // Gather only the facts the active gates require. A gate-less spec gathers
  // nothing and falls through to paying the refund on the inferred charge id.
  const facts: Facts = { order: {}, customer: {} };
  if (lookups.has("orders")) facts.order = lookupOrder(s, orderId);
  if (lookups.has("customers")) facts.customer = lookupCustomer(s, fixture.ticket.customer_email);

  // Resolve the charge id and amount. A harness that read the order takes them
  // from the record; a gate-less harness that never read it falls back to the
  // inferred charge convention and lets the billing API refund the full
  // remaining total (amount omitted), exactly the naive behavior.
  const chargeFromOrder = stringField(facts.order, "stripe_charge_id");
  const chargeId =
    chargeFromOrder.length > 0
      ? chargeFromOrder
      : CHARGE_ID_BY_ORDER[orderId] ?? "";
  const amountFromOrder = numberField(facts.order, "amount");
  const amountCents = amountFromOrder > 0 ? amountFromOrder : 0;

  const decision = decide(spec, fixture, facts, amountCents);

  if (decision.action === "refund") {
    s.think("All checks pass; pay the refund.");
    // When the order amount is known, refund exactly it; otherwise let the
    // billing API refund the full remaining total, the naive default.
    const refund = amountCents > 0 ? issueRefund(s, chargeId, amountCents) : issueRefund(s, chargeId);
    if (refund.status >= 200 && refund.status < 300) {
      solveTicket(s, fixture, "Your refund has been processed. Thank you for your patience!");
      s.finish("refunded");
    } else {
      s.finish("errored");
    }
    return [];
  }

  if (decision.action === "escalate") {
    s.think(`Routing to a human: ${decision.reason}`);
    routeToHuman(s, fixture, `Escalated for review: ${decision.reason}`);
    s.finish("escalated");
    return [];
  }

  s.think(`Blocking the refund: ${decision.reason}`);
  routeToHuman(s, fixture, `Refund declined per policy: ${decision.reason}`);
  s.finish("blocked");
  return [];
}

// ---------------------------------------------------------------------------
// Field helpers.
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

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// The interpreter as a Harness implementation.
// ---------------------------------------------------------------------------

// The Harness seam pins `version` to the v1/v2 label the trace and Judge read. A
// structured spec carries its own free-form version; the harness label reflects
// whether the spec gates at all (gated specs read like a tightened v2 run), which
// is the only distinction the trace's harness_version field needs to carry.
function harnessVersionFor(spec: StructuredHarnessSpec): HarnessVersion {
  return spec.policy_gates.length > 0 ? "v2" : "v1";
}

// Build a deterministic interpreter harness from a structured spec. Its behavior
// is a pure function of the spec, so editing the spec is the only way to change
// what it does. This is the seam the optimizer drives without a model.
export function createInterpreterHarness(spec: StructuredHarnessSpec): Harness {
  return {
    id: `interpreter-${spec.id}`,
    version: harnessVersionFor(spec),
    run: (fixture, world) => runSpec(spec, fixture, world),
  };
}
