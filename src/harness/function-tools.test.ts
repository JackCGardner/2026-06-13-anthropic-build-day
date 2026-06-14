// Keyless proof that the harness function tools actuate the world: each named
// tool the live agent calls (get_ticket, lookup_order, lookup_customer,
// read_policy, issue_refund, escalate_to_human) composes its HTTP call, runs it
// through the run's bash tool, and reaches the real egress gateway, which
// dispatches into the matching kernel against the fixture's scoped world. The
// model is never called: the tools are exercised directly through their SDK
// handlers over a real in-process gateway, so this runs with no credential and
// no network beyond the loopback gateway.
//
// The chain proven for a state-changing tool (issue_refund, escalate_to_human)
// is the same one the scripted bash path proves:
//   tool handler -> bash tool (shell) -> egress (gateway) -> tool_dispatch
//   (kernel) -> state_mutation -> tool_dispatch end -> egress end
// so the kernels stay the single source of truth and issue_refund still hits the
// Stripe kernel, gated only by its mechanical invariants. The read tools prove
// they land on the right kernel and return its wire-faithful body.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

import type {
  EgressRequest,
  Fixture,
  HarnessVersion,
  ToolResponse,
  TraceEvent,
  WorldRunnerHandle,
  WorldState,
} from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { seedWorld, type KernelToolId } from "@/world/seed.js";
import { createEgressGateway, type EgressGateway } from "@/world/gateway.js";
import {
  createLocalBashSubstrate,
  LocalBashSubstrate,
} from "@/world/bash-local.js";
import { createBashTool, type BashTool } from "@/world/bash-tool.js";
import { buildFunctionTools, type BuiltFunctionTool } from "./function-tools.js";
import { loadPinnedRefundSpec } from "./index.js";

// A single in-process trace writer assigning seq and ts exactly as the World
// Runner does, so the bash tool's shell hops and the gateway's egress hops merge
// into one total order under one run.
class TestTrace {
  private seq = 0;
  readonly events: TraceEvent[] = [];

  emit(event: Omit<TraceEvent, "v" | "seq" | "ts">): TraceEvent {
    const full: TraceEvent = {
      v: 1,
      seq: this.seq++,
      ts: new Date(0).toISOString(),
      ...event,
    };
    this.events.push(full);
    return full;
  }

  emitForRun(
    runId: string,
    event: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">,
  ): TraceEvent {
    return this.emit({ run_id: runId, ...event });
  }
}

// Is curl on PATH? The function tools compose curl command lines, so this path
// needs a real curl to drive them end to end. When curl is absent (some CI
// images) the suite is skipped rather than rewriting the tools' transport.
function curlAvailable(): boolean {
  try {
    execFileSync("curl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_CURL = curlAvailable();

function makeHandle(
  trace: TestTrace,
  runId: string,
  fixtureId: string,
  version: HarnessVersion,
): WorldRunnerHandle {
  return {
    runId,
    fixtureId,
    harnessVersion: version,
    emit: (e) => trace.emitForRun(runId, e),
    bash: {
      async runCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    dispatch: (_req: EgressRequest): ToolResponse => {
      throw new Error("dispatch is not used on the real-HTTP egress path");
    },
  };
}

// Stand up a gateway bound to one fixture's seeded world plus a local bash
// substrate pointed at it, then build the function tools over a bash tool that
// shares the gateway's trace writer. Returns the tools keyed by name plus the
// trace and world so a test can assert on hops and on the live state slice.
interface Harnessed {
  gateway: EgressGateway;
  substrate: LocalBashSubstrate;
  trace: TestTrace;
  world: Record<KernelToolId, WorldState>;
  fixture: Fixture;
  runId: string;
  tools: Map<string, BuiltFunctionTool>;
  bash: BashTool;
}

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (teardowns.length > 0) {
    const fn = teardowns.pop();
    if (fn) await fn();
  }
});

async function harnessFixture(fixtureId: string): Promise<Harnessed> {
  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) {
    throw new Error(`fixture not found: ${fixtureId}`);
  }
  const runId = `run_ft_${fixtureId}`;
  const tag = `tag_${fixtureId}_${Math.random().toString(36).slice(2)}`;
  const world = seedWorld(fixture, `${runId}:${fixture.id}`);
  const trace = new TestTrace();

  const gateway = await createEgressGateway({
    resolveWorld: (id) => (id === fixture.id ? world : undefined),
    trace: (event) => trace.emit(event),
  });
  gateway.bind(tag, fixture.id, runId, "v1");

  const substrate = await createLocalBashSubstrate({
    binding: { gatewayBaseUrl: gateway.url, sandboxTag: tag },
  });

  teardowns.push(async () => {
    await substrate.dispose();
    await gateway.close();
  });

  const bash = createBashTool({
    world: makeHandle(trace, runId, fixture.id, "v1"),
    substrate,
    workingDirectory: substrate.workingDirectory,
  });

  const spec = loadPinnedRefundSpec("v1");
  const built = buildFunctionTools(spec, fixture, bash);
  const tools = new Map(
    built.map((b) => [b.tool.name, b] as [string, BuiltFunctionTool]),
  );

  return { gateway, substrate, trace, world, fixture, runId, tools, bash };
}

// Invoke one built function tool's SDK handler with the given args and return the
// single text block the handler produced, mirroring what the model would read.
async function callTool(
  built: BuiltFunctionTool,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const handler = built.tool.handler as (
    input: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  const result = await handler(args, undefined);
  const block = result.content.find((c) => c.type === "text");
  return { text: block?.text ?? "", isError: result.isError === true };
}

// The egress begin event for a tool, identified by the resolved kernel id the
// gateway stamps into the request url.
function egressBeginFor(events: TraceEvent[], kernelId: string): TraceEvent | undefined {
  return events.find(
    (e) =>
      e.kind === "egress" &&
      e.span.phase === "begin" &&
      typeof e.payload["url"] === "string" &&
      (e.payload["url"] as string).includes(kernelId),
  );
}

// The tool_dispatch begin parented to a given egress begin, proving the gateway
// routed the call into that kernel.
function dispatchBeginUnder(
  events: TraceEvent[],
  egressSeq: number,
): TraceEvent | undefined {
  return events.find(
    (e) =>
      e.kind === "tool_dispatch" &&
      e.span.phase === "begin" &&
      e.parent_seq === egressSeq,
  );
}

const suite = HAS_CURL ? describe : describe.skip;

suite("function tools actuate the world through the real gateway", () => {
  it("builds one tool per manifest entry the world can serve", async () => {
    const h = await harnessFixture("wrong_method_double");
    expect([...h.tools.keys()].sort()).toEqual(
      [
        "escalate_to_human",
        "get_ticket",
        "issue_refund",
        "lookup_customer",
        "lookup_order",
        "read_policy",
      ].sort(),
    );
  });

  it("get_ticket dispatches into the zendesk kernel and returns the ticket", async () => {
    const h = await harnessFixture("wrong_method_double");
    const out = await callTool(h.tools.get("get_ticket")!, {});

    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text) as Record<string, unknown>;
    const ticket = body["ticket"] as Record<string, unknown> | undefined;
    expect((ticket ?? body)["subject"]).toBe("Please refund to my new card");

    const eBegin = egressBeginFor(h.trace.events, "zendesk");
    expect(eBegin).toBeDefined();
    const dispatch = dispatchBeginUnder(h.trace.events, eBegin!.seq);
    expect(dispatch?.actor).toBe("tool:zendesk");
  });

  it("lookup_order dispatches into the orders kernel and returns the order facts", async () => {
    const h = await harnessFixture("wrong_method_double");
    const out = await callTool(h.tools.get("lookup_order")!, {
      order_id: "ord_1005",
    });

    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text) as Record<string, unknown>;
    const order = (body["order"] as Record<string, unknown>) ?? body;
    expect(order["stripe_charge_id"]).toBe("ch_wrongmethod");

    const eBegin = egressBeginFor(h.trace.events, "orders");
    expect(eBegin).toBeDefined();
    const dispatch = dispatchBeginUnder(h.trace.events, eBegin!.seq);
    expect(dispatch?.actor).toBe("tool:orders");
  });

  it("lookup_customer dispatches into the customers kernel", async () => {
    const h = await harnessFixture("wrong_method_double");
    const out = await callTool(h.tools.get("lookup_customer")!, {
      email: "eve@example.com",
    });

    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text) as Record<string, unknown>;
    const customer = (body["customer"] as Record<string, unknown>) ?? body;
    expect(customer["email"]).toBe("eve@example.com");

    const eBegin = egressBeginFor(h.trace.events, "customers");
    expect(eBegin).toBeDefined();
    const dispatch = dispatchBeginUnder(h.trace.events, eBegin!.seq);
    expect(dispatch?.actor).toBe("tool:customers");
  });

  it("read_policy dispatches into the policy kernel and returns the policy body", async () => {
    const h = await harnessFixture("wrong_method_double");
    const out = await callTool(h.tools.get("read_policy")!, {});

    expect(out.isError).toBe(false);
    expect(out.text.length).toBeGreaterThan(0);

    const eBegin = egressBeginFor(h.trace.events, "policy");
    expect(eBegin).toBeDefined();
    const dispatch = dispatchBeginUnder(h.trace.events, eBegin!.seq);
    expect(dispatch?.actor).toBe("tool:policy");
  });

  it("issue_refund hits the Stripe kernel and moves the hidden budget via a traced state_mutation", async () => {
    const h = await harnessFixture("wrong_method_double");
    const out = await callTool(h.tools.get("issue_refund")!, {
      charge: "ch_wrongmethod",
      reason: "requested_by_customer",
    });

    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text) as Record<string, unknown>;
    expect(body["object"]).toBe("refund");
    expect(body["status"]).toBe("succeeded");
    // $1,500 charged, $500 already refunded: a no-amount refund moves the
    // remaining $1,000.
    expect(body["amount"]).toBe(100000);

    // The Stripe kernel decremented the hidden monthly budget, recorded as a
    // state_mutation parented to the stripe tool_dispatch.
    const eBegin = egressBeginFor(h.trace.events, "stripe");
    expect(eBegin).toBeDefined();
    const dispatch = dispatchBeginUnder(h.trace.events, eBegin!.seq);
    expect(dispatch?.actor).toBe("tool:stripe");

    const mutation = h.trace.events.find(
      (e) =>
        e.kind === "state_mutation" &&
        e.payload["key"] === "stripe.monthly_refund_budget_cents" &&
        e.parent_seq === dispatch!.seq,
    );
    expect(mutation).toBeDefined();
    expect(mutation!.payload["before"]).toBe(500000);
    expect(mutation!.payload["after"]).toBe(400000);

    // The kernel mutated the live world slice in place, so the gateway's scoped
    // state reflects the decrement: the kernel is the single source of truth.
    expect(h.world.stripe.monthly_refund_budget_cents).toBe(400000);
  });

  it("escalate_to_human hits the zendesk kernel and mutates the ticket via a traced state_mutation", async () => {
    const h = await harnessFixture("wrong_method_double");
    const out = await callTool(h.tools.get("escalate_to_human")!, {
      reason: "Refund requested to a non-original payment method; needs review.",
    });

    expect(out.isError).toBe(false);

    const eBegin = egressBeginFor(h.trace.events, "zendesk");
    expect(eBegin).toBeDefined();
    const dispatch = dispatchBeginUnder(h.trace.events, eBegin!.seq);
    expect(dispatch?.actor).toBe("tool:zendesk");

    const mutation = h.trace.events.find(
      (e) =>
        e.kind === "state_mutation" &&
        e.span.phase === "point" &&
        e.actor === "tool:zendesk" &&
        e.parent_seq === dispatch!.seq,
    );
    expect(mutation).toBeDefined();
  });

  it("records the real command on the shell hop, never an empty command", async () => {
    const h = await harnessFixture("wrong_method_double");
    await callTool(h.tools.get("lookup_order")!, { order_id: "ord_1005" });

    const shellBegin = h.trace.events.find(
      (e) => e.kind === "shell" && e.span.phase === "begin",
    );
    expect(shellBegin).toBeDefined();
    const command = shellBegin!.payload["command"];
    expect(typeof command).toBe("string");
    expect(String(command).trim().length).toBeGreaterThan(0);
    expect(String(command)).toContain("orders.local/orders/ord_1005");

    // The tool_invocation begin records the same command the bash tool ran, so
    // the trace never carries the empty-command artifact the live run hit.
    const invocationBegin = h.trace.events.find(
      (e) =>
        e.kind === "tool_invocation" &&
        e.span.phase === "begin" &&
        e.payload["tool_name"] === "bash",
    );
    expect(invocationBegin).toBeDefined();
    const input = invocationBegin!.payload["input"] as Record<string, unknown>;
    expect(String(input["command"]).trim().length).toBeGreaterThan(0);
  });
});
