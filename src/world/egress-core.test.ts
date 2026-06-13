// Keyless proof for the shared egress core. The local Node gateway and the
// deployed forwardURL route both drive handleEgress; this test drives it directly
// against a seeded Stripe world, with no transport, no server, and no network. It
// is the port of the gateway integration assertions onto the shared core: a
// refund dispatched through handleEgress must produce the SAME wire-faithful 200,
// the SAME hidden-budget state_mutation, and the SAME correctly parented trace
// chain the real-HTTP integration test observes.

import { describe, it, expect } from "vitest";

import type { TraceEvent, WorldState } from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { seedWorld, type KernelToolId } from "./seed.js";
import {
  handleEgress,
  decodeBody,
  type NormalizedRequest,
  type SandboxBinding,
} from "./egress-core.js";

// One in-process trace writer assigning seq and ts, exactly as the World Runner
// does. The core emits every hop through this single writer, so seq is a total
// order and parent_seq reconstructs the causal tree.
function makeTrace(): {
  events: TraceEvent[];
  write: (event: Omit<TraceEvent, "v" | "seq" | "ts">) => TraceEvent;
} {
  const events: TraceEvent[] = [];
  let seq = 0;
  const write = (event: Omit<TraceEvent, "v" | "seq" | "ts">): TraceEvent => {
    const full: TraceEvent = {
      v: 1,
      seq: seq++,
      ts: new Date(0).toISOString(),
      ...event,
    };
    events.push(full);
    return full;
  };
  return { events, write };
}

// Seed the wrong_method_double fixture's world: ch_wrongmethod has $1,500 charged
// with $500 already refunded against a hidden $5,000 monthly budget, mirroring the
// real-HTTP integration test so the numbers line up exactly.
function seedRefundWorld(fixtureId: string): {
  world: Record<KernelToolId, WorldState>;
  binding: SandboxBinding;
} {
  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) {
    throw new Error(`fixture not found: ${fixtureId}`);
  }
  const runId = `run_core_${fixtureId}`;
  const world = seedWorld(fixture, `${runId}:${fixtureId}`);
  return {
    world,
    binding: { fixtureId, runId, harnessVersion: "v1" },
  };
}

// The refund request a harness's shell would have produced, normalized to the
// shape the core consumes: a form-encoded POST to the synthetic Stripe host. The
// host resolves to the Stripe kernel; the path matches /v1/refunds.
function refundRequest(chargeId: string): NormalizedRequest {
  const raw = `charge=${chargeId}&reason=requested_by_customer`;
  return {
    host: "api.stripe.com",
    method: "POST",
    path: "/v1/refunds",
    query: {},
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: decodeBody(raw, "application/x-www-form-urlencoded"),
  };
}

describe("shared egress core: handleEgress dispatches a refund into the Stripe kernel", () => {
  it("returns a wire-faithful 200 with an re_ id and no observability channel", () => {
    const { world, binding } = seedRefundWorld("wrong_method_double");
    const trace = makeTrace();

    const wire = handleEgress({
      binding,
      sandboxId: "tag_run_core",
      request: refundRequest("ch_wrongmethod"),
      trace: trace.write,
      resolveWorld: (id) => (id === binding.fixtureId ? world : undefined),
    });

    expect(wire.status).toBe(200);
    const body = wire.body as Record<string, unknown>;
    expect(body["object"]).toBe("refund");
    expect(String(body["id"]).startsWith("re_")).toBe(true);
    expect(body["status"]).toBe("succeeded");
    // $1,500 charged less $500 already refunded = $1,000 remaining.
    expect(body["amount"]).toBe(100000);
    // The observability channel never crosses the wire.
    expect(body["state_mutations"]).toBeUndefined();
    expect(wire.headers["x-enforced-invariants"]).toBeUndefined();
  });

  it("decrements the hidden monthly budget via a traced state_mutation, mutating the live slice", () => {
    const { world, binding } = seedRefundWorld("wrong_method_double");
    const trace = makeTrace();

    handleEgress({
      binding,
      sandboxId: "tag_run_core",
      request: refundRequest("ch_wrongmethod"),
      trace: trace.write,
      resolveWorld: (id) => (id === binding.fixtureId ? world : undefined),
    });

    const budgetMutation = trace.events.find(
      (e) =>
        e.kind === "state_mutation" &&
        e.payload["key"] === "stripe.monthly_refund_budget_cents",
    );
    expect(budgetMutation).toBeDefined();
    // $5,000 budget (500000) less the $1,000 refund (100000) leaves $4,000 (400000).
    expect(budgetMutation!.payload["before"]).toBe(500000);
    expect(budgetMutation!.payload["after"]).toBe(400000);
    // The kernel mutated the scoped WorldState in place.
    expect(world.stripe.monthly_refund_budget_cents).toBe(400000);
  });

  it("emits egress -> tool_dispatch -> state_mutation -> tool_dispatch end -> egress end, correctly parented", () => {
    const { world, binding } = seedRefundWorld("wrong_method_double");
    const trace = makeTrace();

    handleEgress({
      binding,
      sandboxId: "tag_run_core",
      request: refundRequest("ch_wrongmethod"),
      trace: trace.write,
      resolveWorld: (id) => (id === binding.fixtureId ? world : undefined),
    });
    const events = trace.events;

    const eBegin = events.find(
      (e) => e.kind === "egress" && e.span.phase === "begin",
    );
    expect(eBegin).toBeDefined();
    expect(eBegin!.run_id).toBe(binding.runId);
    expect(eBegin!.fixture_id).toBe(binding.fixtureId);

    const dispatchBegin = events.find(
      (e) =>
        e.kind === "tool_dispatch" &&
        e.span.phase === "begin" &&
        e.parent_seq === eBegin!.seq,
    );
    expect(dispatchBegin).toBeDefined();
    expect(dispatchBegin!.actor).toBe("tool:stripe");

    const mutation = events.find(
      (e) =>
        e.kind === "state_mutation" &&
        e.payload["key"] === "stripe.monthly_refund_budget_cents" &&
        e.parent_seq === dispatchBegin!.seq,
    );
    expect(mutation).toBeDefined();

    const dispatchEnd = events.find(
      (e) =>
        e.kind === "tool_dispatch" &&
        e.span.phase === "end" &&
        e.parent_seq === dispatchBegin!.seq,
    );
    expect(dispatchEnd).toBeDefined();
    expect(dispatchEnd!.payload["status"]).toBe(200);

    const eEnd = events.find(
      (e) =>
        e.kind === "egress" &&
        e.span.phase === "end" &&
        e.parent_seq === eBegin!.seq,
    );
    expect(eEnd).toBeDefined();
    expect(eEnd!.payload["status"]).toBe(200);
    expect(eEnd!.payload["enforced_invariants_checked"]).toBeDefined();
  });

  it("rejects an unbound identity loud with a 502 and a trace event", () => {
    const { world } = seedRefundWorld("wrong_method_double");
    const trace = makeTrace();

    const wire = handleEgress({
      binding: undefined,
      sandboxId: "tag_never_bound",
      request: refundRequest("ch_wrongmethod"),
      trace: trace.write,
      resolveWorld: (id) => (id === "wrong_method_double" ? world : undefined),
    });

    expect(wire.status).toBe(502);
    const body = wire.body as { error: { code: string } };
    expect(body.error.code).toBe("unbound_sandbox");
    const rejection = trace.events.find(
      (e) => e.kind === "egress" && e.payload["rejected"] === "unbound_sandbox",
    );
    expect(rejection).toBeDefined();
    expect(rejection!.payload["status"]).toBe(502);
  });

  it("rejects an unknown tool (no host/path match) loud with a 502, parented to the run", () => {
    const { world, binding } = seedRefundWorld("wrong_method_double");
    const trace = makeTrace();

    const wire = handleEgress({
      binding,
      sandboxId: "tag_run_core",
      request: {
        host: "unknown.example",
        method: "GET",
        path: "/nope",
        query: {},
        headers: {},
        body: null,
      },
      trace: trace.write,
      resolveWorld: (id) => (id === binding.fixtureId ? world : undefined),
    });

    expect(wire.status).toBe(502);
    const body = wire.body as { error: { code: string } };
    expect(body.error.code).toBe("unknown_tool");
    const rejection = trace.events.find(
      (e) => e.kind === "egress" && e.payload["rejected"] === "unknown_tool",
    );
    expect(rejection).toBeDefined();
    expect(rejection!.fixture_id).toBe(binding.fixtureId);
  });
});
