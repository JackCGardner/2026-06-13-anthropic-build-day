// A standalone egress gateway process for one fixture. The bash-path sweep
// spawns one of these per fixture so the parent can drive the synthetic world
// over real HTTP: the parent runs a real shell command (curl) that reaches this
// process, which dispatches into the scoped kernels and serves a wire-faithful
// response, exactly as a live sandbox's outbound call would hit the gateway.
//
// Running the gateway in its own process is what makes the parent's synchronous
// dispatch faithful: the parent can block on a synchronous curl while this
// process services the request on its own event loop. The gateway is the single
// writer of the egress trace hops; it appends each one as a JSONL line to the
// trace file given in the environment, and the parent folds those lines into the
// per-fixture trace alongside the harness's own events.
//
// Protocol with the parent (all over stdio and the environment):
//   env GATEWAY_FIXTURE_ID   the fixture to seed and bind
//   env GATEWAY_RUN_ID       the run id stamped on every trace event
//   env GATEWAY_VERSION      the harness version (v1 | v2) stamped on events
//   env GATEWAY_TAG          the sandbox binding tag the parent's commands carry
//   env GATEWAY_TRACE_FILE   the JSONL file this process appends trace events to
//   stdout "READY <url>"     printed once the server is listening
//   stdin  "CLOSE"           tells the process to flush and exit cleanly

import { appendFileSync } from "node:fs";

import type { TraceEvent, HarnessVersion } from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { seedWorld } from "@/world/seed.js";
import { createEgressGateway } from "@/world/gateway.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`gateway-server: missing required env ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const fixtureId = requireEnv("GATEWAY_FIXTURE_ID");
  const runId = requireEnv("GATEWAY_RUN_ID");
  const version = requireEnv("GATEWAY_VERSION") as HarnessVersion;
  const tag = requireEnv("GATEWAY_TAG");
  const traceFile = requireEnv("GATEWAY_TRACE_FILE");

  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) {
    throw new Error(`gateway-server: unknown fixture ${fixtureId}`);
  }

  // Seed the fixture's scoped world once. The kernels mutate it in place across
  // the fixture's calls, so the hidden budget the parent's refunds drain persists
  // between requests, exactly as the in-process runner's world does.
  const world = seedWorld(fixture, `${runId}:${fixture.id}`);

  // The single trace writer for this process: assign a monotonic seq and ts, then
  // append the event as a JSONL line the parent reads back. The parent re-seqs the
  // merged stream, so the seq here only needs to keep this process's hops ordered.
  let seq = 0;
  const trace = (
    event: Omit<TraceEvent, "v" | "seq" | "ts">,
  ): TraceEvent => {
    const full: TraceEvent = {
      v: 1,
      seq: seq++,
      ts: new Date(0).toISOString(),
      ...event,
    };
    appendFileSync(traceFile, JSON.stringify(full) + "\n", "utf8");
    return full;
  };

  const gateway = await createEgressGateway({
    resolveWorld: (id) => (id === fixture.id ? world : undefined),
    trace,
  });
  gateway.bind(tag, fixture.id, runId, version);

  process.stdout.write(`READY ${gateway.url}\n`);

  // Wait for the parent to signal CLOSE, then tear the server down. Exiting on the
  // parent's signal keeps the process lifetime bound to exactly one fixture.
  await new Promise<void>((resolveClose) => {
    let buffer = "";
    process.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.includes("CLOSE")) {
        resolveClose();
      }
    });
    process.stdin.on("end", () => resolveClose());
  });

  await gateway.close();
}

main().catch((error: unknown) => {
  process.stderr.write(String(error) + "\n");
  process.exit(1);
});
