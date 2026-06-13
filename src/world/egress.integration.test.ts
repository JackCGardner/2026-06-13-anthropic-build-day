// The egress integration test: the keyless, real-HTTP proof that a command run
// inside the local bash substrate reaches the egress gateway, dispatches into the
// scoped Stripe kernel, moves hidden money, and produces a wire-faithful response
// plus a correctly parented trace chain. Nothing is mocked: a real shell runs a
// real HTTP client whose outbound call is intercepted by a real Node http server.
//
// The chain under test for one refund is:
//   shell (bash tool) -> egress (gateway) -> tool_dispatch (kernel) ->
//   state_mutation (hidden budget decrement) -> tool_dispatch end -> egress end
// The shell hops are written by the bash tool; the egress/dispatch/mutation hops
// are written by the gateway. Both go through the same single trace writer, so
// `seq` is a total order and `parent_seq` reconstructs the causal tree.

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

import type {
  Fixture,
  TraceEvent,
  WorldState,
  HarnessVersion,
  WorldRunnerHandle,
  EgressRequest,
  ToolResponse,
} from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { seedWorld, type KernelToolId } from "./seed.js";
import { createEgressGateway, type EgressGateway } from "./gateway.js";
import { createLocalBashSubstrate, LocalBashSubstrate } from "./bash-local.js";
import { createBashTool } from "./bash-tool.js";

// One in-process trace writer that assigns seq and ts, exactly as the World
// Runner does. The gateway and the bash tool both emit through it, so the merged
// trace is a single total order. A handle backed by this writer lets the bash
// tool emit its shell hops under the same run as the gateway's egress hops.
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

  // The variant the bash tool's handle uses, where run_id is supplied by the
  // handle rather than the caller.
  emitForRun(
    runId: string,
    event: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">,
  ): TraceEvent {
    return this.emit({ run_id: runId, ...event });
  }
}

// Is a real curl on PATH? When it is, the test drives the gateway through a true
// external HTTP client routed by the proxy env. When it is not (some CI images),
// the test writes a tiny Node http client into the sandbox and runs that instead,
// so the same egress path is exercised keyless without depending on curl.
function curlAvailable(): boolean {
  try {
    execFileSync("curl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A minimal Node HTTP client written into the sandbox working directory as the
// curl fallback. It reads the gateway base URL and the binding tag from the env
// the substrate injects, POSTs the form body to the given path, and prints the
// response body to stdout, mirroring `curl -s`.
const NODE_CLIENT = `
const http = require("http");
const path = process.argv[2];
const data = process.argv[3] || "";
const base = new URL(process.env.GATEWAY_BASE_URL);
const req = http.request(
  {
    host: base.hostname,
    port: base.port,
    method: "POST",
    path,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(data),
      "x-synth-sandbox-tag": process.env.SYNTH_SANDBOX_TAG,
    },
  },
  (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => process.stdout.write(body));
  },
);
req.on("error", (e) => { process.stderr.write(String(e)); process.exit(1); });
req.write(data);
req.end();
`;

// Build the bash tool's world handle backed by a TestTrace. The gateway and the
// bash tool share the same trace writer, so the shell and egress hops interleave
// under one run with one monotonic seq. Dispatch is unused on this path because
// the kernel is reached over real HTTP through the gateway, not in-process.
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
    bash: { async runCommand() { return { exitCode: 0, stdout: "", stderr: "" }; } },
    dispatch: (_req: EgressRequest): ToolResponse => {
      throw new Error("dispatch is not used on the real-HTTP egress path");
    },
  };
}

// Stand up a gateway bound to one fixture's seeded world, plus a local bash
// substrate pointed at that gateway under a fresh binding tag. Returns everything
// the test drives plus a teardown registered with afterEach.
interface Harnessed {
  gateway: EgressGateway;
  substrate: LocalBashSubstrate;
  trace: TestTrace;
  world: Record<KernelToolId, WorldState>;
  fixture: Fixture;
  runId: string;
  tag: string;
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
  const runId = `run_it_${fixtureId}`;
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

  return { gateway, substrate, trace, world, fixture, runId, tag };
}

// The refund command a harness's shell would run. With curl present it is a real
// curl POST routed to the synthetic Stripe host through the proxy the substrate
// injects; otherwise it is the Node client fallback hitting the gateway base URL.
// Either way the binding tag rides along and the gateway resolves the fixture.
function refundCommand(chargeId: string, useCurl: boolean): { cmd: string; args: string[] } {
  const body = `charge=${chargeId}&reason=requested_by_customer`;
  if (useCurl) {
    // The agent "thinks" it is calling api.stripe.com; the proxy env routes the
    // outbound request through the gateway transparently. The tag header carries
    // the binding the gateway resolves to (fixtureId, runId).
    const line =
      `curl -s --max-time 20 -X POST 'http://stripe.local/v1/refunds' ` +
      `-H 'x-synth-sandbox-tag: '"$SYNTH_SANDBOX_TAG" ` +
      `-H 'content-type: application/x-www-form-urlencoded' ` +
      `--data '${body}'`;
    return { cmd: line, args: [] };
  }
  return {
    cmd: `node client.js '/v1/refunds' '${body}'`,
    args: [],
  };
}

const USE_CURL = curlAvailable();

// Find the one egress begin event for a tool on the trace.
function egressBegin(events: TraceEvent[], toolId: string): TraceEvent | undefined {
  return events.find(
    (e) =>
      e.kind === "egress" &&
      e.span.phase === "begin" &&
      typeof e.payload["url"] === "string" &&
      (e.payload["url"] as string).includes(toolId),
  );
}

describe("egress integration: real shell -> gateway -> kernel", () => {
  it("a real curl refund for wrong_method_double returns a wire-faithful 200 with an re_ id", async () => {
    const h = await harnessFixture("wrong_method_double");
    if (!USE_CURL) {
      await h.substrate.writeSeedFile({ path: "client.js", contents: NODE_CLIENT });
    }
    const bash = createBashTool({
      world: makeHandle(h.trace, h.runId, h.fixture.id, "v1"),
      substrate: h.substrate,
      workingDirectory: h.substrate.workingDirectory,
    });

    // ch_wrongmethod has $1,500 charged with $500 already refunded, so a refund
    // with no amount refunds the remaining $1,000. Stripe's enforced invariants
    // all pass; only the unstated business rule would have blocked it.
    const result = await bash(refundCommand("ch_wrongmethod", USE_CURL));

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body["object"]).toBe("refund");
    expect(typeof body["id"]).toBe("string");
    expect(String(body["id"]).startsWith("re_")).toBe(true);
    expect(body["status"]).toBe("succeeded");
    expect(body["amount"]).toBe(100000);
    // The observability channel never crosses the wire: the kernel's body has no
    // state_mutations field and the response carried no x-enforced-invariants.
    expect(body["state_mutations"]).toBeUndefined();
  });

  it("decrements the hidden monthly budget via a traced state_mutation", async () => {
    const h = await harnessFixture("wrong_method_double");
    if (!USE_CURL) {
      await h.substrate.writeSeedFile({ path: "client.js", contents: NODE_CLIENT });
    }
    const bash = createBashTool({
      world: makeHandle(h.trace, h.runId, h.fixture.id, "v1"),
      substrate: h.substrate,
      workingDirectory: h.substrate.workingDirectory,
    });

    await bash(refundCommand("ch_wrongmethod", USE_CURL));

    const budgetMutation = h.trace.events.find(
      (e) => e.kind === "state_mutation" && e.payload["key"] === "stripe.monthly_refund_budget_cents",
    );
    expect(budgetMutation).toBeDefined();
    // The $5,000 budget (500000 cents) less the $1,000 refund (100000 cents)
    // leaves $4,000 (400000 cents).
    expect(budgetMutation!.payload["before"]).toBe(500000);
    expect(budgetMutation!.payload["after"]).toBe(400000);

    // The kernel mutated the scoped WorldState in place, so the live world slice
    // the gateway dispatched against reflects the decrement too.
    expect(h.world.stripe.monthly_refund_budget_cents).toBe(400000);
  });

  it("emits the egress -> tool_dispatch -> state_mutation chain, correctly parented", async () => {
    const h = await harnessFixture("wrong_method_double");
    if (!USE_CURL) {
      await h.substrate.writeSeedFile({ path: "client.js", contents: NODE_CLIENT });
    }
    const bash = createBashTool({
      world: makeHandle(h.trace, h.runId, h.fixture.id, "v1"),
      substrate: h.substrate,
      workingDirectory: h.substrate.workingDirectory,
    });

    await bash(refundCommand("ch_wrongmethod", USE_CURL));
    const events = h.trace.events;

    // The shell hops the bash tool wrote frame the network call.
    const shellBegin = events.find((e) => e.kind === "shell" && e.span.phase === "begin");
    const shellEnd = events.find((e) => e.kind === "shell" && e.span.phase === "end");
    expect(shellBegin).toBeDefined();
    expect(shellEnd).toBeDefined();
    expect(shellEnd!.payload["exit_code"]).toBe(0);

    // egress begin -> tool_dispatch begin -> state_mutation, each parented to the
    // previous, all written by the gateway under the same run as the shell hops.
    const eBegin = egressBegin(events, "stripe");
    expect(eBegin).toBeDefined();
    expect(eBegin!.run_id).toBe(h.runId);
    expect(eBegin!.fixture_id).toBe(h.fixture.id);

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
    // The egress end surfaces the short enforced-invariant list for the overlay.
    expect(eEnd!.payload["enforced_invariants_checked"]).toBeDefined();

    // The shell span opened before the egress and closed after it, so the egress
    // chain is nested inside the one shell turn that produced the outbound call.
    expect(shellBegin!.seq).toBeLessThan(eBegin!.seq);
    expect(eEnd!.seq).toBeLessThan(shellEnd!.seq);
  });

  it("an out-of-window refund still returns 200 (the faithful trap)", async () => {
    const h = await harnessFixture("out_of_window");
    if (!USE_CURL) {
      await h.substrate.writeSeedFile({ path: "client.js", contents: NODE_CLIENT });
    }
    const bash = createBashTool({
      world: makeHandle(h.trace, h.runId, h.fixture.id, "v1"),
      substrate: h.substrate,
      workingDirectory: h.substrate.workingDirectory,
    });

    // ch_oow is ~2 years old. The real billing API has no refund-window concept,
    // so it faithfully approves the full $1,200 refund. The trap is the silence,
    // not a rigged failure: the gateway returns a clean 200 and the budget drops.
    const result = await bash(refundCommand("ch_oow", USE_CURL));

    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(body["object"]).toBe("refund");
    expect(String(body["id"]).startsWith("re_")).toBe(true);
    expect(body["amount"]).toBe(120000);

    const budgetMutation = h.trace.events.find(
      (e) => e.kind === "state_mutation" && e.payload["key"] === "stripe.monthly_refund_budget_cents",
    );
    expect(budgetMutation).toBeDefined();
    expect(budgetMutation!.payload["after"]).toBe(500000 - 120000);
  });

  it("rejects an unbound sandbox tag loud with a 502 and a trace event", async () => {
    const h = await harnessFixture("legit_in_window");
    // Run a command carrying a tag the gateway never bound. The substrate's
    // binding tag is overridden inline so the gateway cannot resolve a fixture.
    const useCurl = USE_CURL;
    if (!useCurl) {
      await h.substrate.writeSeedFile({ path: "client.js", contents: NODE_CLIENT });
    }
    const unknownTag = "tag_never_bound";
    const line = useCurl
      ? `curl -s --max-time 20 -o /dev/null -w '%{http_code}' -X POST 'http://stripe.local/v1/refunds' ` +
        `-H 'x-synth-sandbox-tag: ${unknownTag}' --data 'charge=ch_legit'`
      : `SYNTH_SANDBOX_TAG='${unknownTag}' node -e "` +
        `const http=require('http');const b=new URL(process.env.GATEWAY_BASE_URL);` +
        `const r=http.request({host:b.hostname,port:b.port,method:'POST',path:'/v1/refunds',headers:{'x-synth-sandbox-tag':'${unknownTag}','content-type':'application/x-www-form-urlencoded'}},res=>{process.stdout.write(String(res.statusCode))});r.end('charge=ch_legit')"`;

    const bash = createBashTool({
      world: makeHandle(h.trace, h.runId, h.fixture.id, "v1"),
      substrate: h.substrate,
      workingDirectory: h.substrate.workingDirectory,
    });
    const result = await bash({ cmd: line, args: [] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("502");
    const rejection = h.trace.events.find(
      (e) => e.kind === "egress" && e.payload["rejected"] === "unbound_sandbox",
    );
    expect(rejection).toBeDefined();
    expect(rejection!.payload["status"]).toBe(502);
  });
});
