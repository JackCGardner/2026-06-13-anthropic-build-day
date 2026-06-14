// Derive a run's terminal decision from the trace it produced. The live harness
// drives the world through named tools whose money-moving and ticket-routing
// effects are recorded by the egress gateway, not by the harness itself, so the
// terminal disposition is read off the trace rather than asserted by the agent.
// This is the single owner of that derivation, shared by the live sweep and the
// optimizer's evaluate bridge so both classify a live run the same way.
//
// The ordering is deliberate: a refund that actually moved money outranks every
// other outcome, a ticket routed to a human (set pending with a note) is an
// escalation, a run that threw is errored, and an otherwise clean run that moved
// no money is a block. The money-moved and route-to-human signals match the same
// trace facts the Judge keys cash burned and the escalation dimension off, so the
// derived decision and the Judge's scoring stay consistent.

import type { TerminalDecision, TraceEvent } from "./contracts/trace.js";

// Read the terminal disposition off the merged harness + gateway trace. `errored`
// is supplied by the caller because a harness that threw before producing any
// world effect leaves no trace signal of its own.
export function deriveTerminalDecision(
  events: TraceEvent[],
  errored: boolean,
): Extract<TerminalDecision, "refunded" | "escalated" | "blocked" | "errored"> {
  if (traceShowsRefund(events)) return "refunded";
  if (traceShowsEscalation(events)) return "escalated";
  if (errored) return "errored";
  return "blocked";
}

// A refund moved money when the gateway wrote a successful refund egress or the
// Stripe kernel decremented the hidden monthly budget. Either is the ground-truth
// money-moved fact the Judge also keys cash burned off.
function traceShowsRefund(events: TraceEvent[]): boolean {
  for (const e of events) {
    if (e.kind === "egress" && e.span.phase === "end") {
      const p = e.payload as { url?: unknown; status?: unknown };
      if (
        typeof p.url === "string" &&
        p.url.includes("/v1/refunds") &&
        typeof p.status === "number" &&
        p.status >= 200 &&
        p.status < 300
      ) {
        return true;
      }
    }
    if (e.kind === "state_mutation") {
      const p = e.payload as { key?: unknown; before?: unknown; after?: unknown };
      if (
        typeof p.key === "string" &&
        p.key.includes("monthly_refund_budget_cents") &&
        typeof p.before === "number" &&
        typeof p.after === "number" &&
        p.after < p.before
      ) {
        return true;
      }
    }
  }
  return false;
}

// The run routed the ticket to a human when the Zendesk kernel actually mutated
// the ticket record (escalate_to_human sets it pending with a private note). The
// state_mutation on a "ticket:" key is the route-to-human signal, distinct from a
// read of the same ticket, which mutates nothing.
function traceShowsEscalation(events: TraceEvent[]): boolean {
  for (const e of events) {
    if (e.kind === "state_mutation") {
      const p = e.payload as { key?: unknown };
      if (typeof p.key === "string" && p.key.startsWith("ticket:")) {
        return true;
      }
    }
  }
  return false;
}
