// The bash-path sweep: the same keyless thesis proof as `npm run sweep`, but
// every tool call the scripted harness makes travels the real egress path. For
// each fixture the harness's structured EgressRequest is turned into a real shell
// command (curl) run inside the local bash substrate; the substrate's proxy and
// base-URL env route that command's outbound HTTP to a standalone egress gateway
// process bound to the fixture; the gateway dispatches into the scoped kernels,
// moves the hidden money, and serves a wire-faithful response the harness reads.
//
// The point is fidelity: the dashboard numbers ($5,140 -> $0, technical pass flat
// at 100%) must survive the real shell + HTTP + process-boundary path, not just
// the in-process dispatch the unit sweep uses. If they hold here, the egress seam
// is faithful end to end and the live Agent SDK harness can replace the scripted
// one without moving a single number.
//
// Usage:
//   npm run sweep:bash
//   tsx scripts/sweep-bash.ts
//   tsx scripts/sweep-bash.ts --traces ./out/traces-bash

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createJudge, deterministicCxScorer } from "@/engine";
import type {
  RunScore,
  TraceEvent,
  HarnessVersion,
  Fixture,
  Harness,
  WorldRunnerHandle,
  EgressRequest,
  ToolResponse,
} from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { scriptedHarnessV1, scriptedHarnessV2 } from "@/world/index.js";
import { createLocalBashSubstrate } from "@/world/bash-local.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GATEWAY_SERVER = join(HERE, "gateway-server.ts");
// Invoke the tsx binary directly rather than through `npx`, so stdio is wired
// straight to the gateway process (the READY handshake and the CLOSE signal cross
// without an npm exec wrapper buffering or swallowing them).
const TSX_BIN = resolve(process.cwd(), "node_modules", ".bin", "tsx");

// ---------------------------------------------------------------------------
// One bound gateway process for one fixture. The parent talks to it over stdio:
// it prints READY <url> when listening and exits on the CLOSE signal. The gateway
// appends its egress trace hops to the JSONL trace file, which the parent reads
// back after the harness finishes.
// ---------------------------------------------------------------------------

interface GatewayProcess {
  url: string;
  traceFile: string;
  close(): void;
}

function startGateway(
  fixtureId: string,
  runId: string,
  version: HarnessVersion,
  tag: string,
  dir: string,
): Promise<GatewayProcess> {
  const traceFile = join(dir, `gateway_${runId}_${fixtureId}.jsonl`);
  writeFileSync(traceFile, "", "utf8");

  const child: ChildProcessWithoutNullStreams = spawn(
    TSX_BIN,
    [GATEWAY_SERVER],
    {
      env: {
        ...process.env,
        GATEWAY_FIXTURE_ID: fixtureId,
        GATEWAY_RUN_ID: runId,
        GATEWAY_VERSION: version,
        GATEWAY_TAG: tag,
        GATEWAY_TRACE_FILE: traceFile,
      },
    },
  );

  return new Promise<GatewayProcess>((resolveReady, rejectReady) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const onData = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString();
      const match = stdoutBuf.match(/READY (\S+)/);
      if (match) {
        child.stdout.off("data", onData);
        resolveReady({
          url: match[1]!,
          traceFile,
          close(): void {
            // Signal CLOSE and end stdin so the gateway tears down promptly even
            // if the signal write races the child's stdin reader.
            child.stdin.write("CLOSE\n");
            child.stdin.end();
          },
        });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (c: Buffer) => {
      stderrBuf += c.toString();
    });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        rejectReady(
          new Error(`gateway process exited ${code}: ${stderrBuf || stdoutBuf}`),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Turning a structured EgressRequest into a real shell command. The path already
// matches the kernel's route, so the command hits the gateway base URL directly
// (path resolution); the binding tag rides the tag header. Form-encoded bodies
// (Stripe) and JSON bodies (internal services) are serialized as their real APIs
// expect, so the gateway and kernels parse exactly what they would in production.
// ---------------------------------------------------------------------------

function egressToCurl(req: EgressRequest): string {
  const query = Object.entries(req.query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const pathWithQuery = query.length > 0 ? `${req.path}?${query}` : req.path;

  const parts: string[] = [
    "curl",
    "-s",
    "--max-time",
    "20",
    "-X",
    req.method,
    `"$GATEWAY_BASE_URL${pathWithQuery}"`,
    // The status code is appended after a sentinel so the parent can split the
    // wire body from the HTTP status in one synchronous round-trip.
    "-w",
    `'\\n__STATUS__%{http_code}'`,
    "-H",
    `'x-synth-sandbox-tag: '"$SYNTH_SANDBOX_TAG"`,
  ];

  const contentType = headerValue(req.headers, "content-type");
  const body = serializeBody(req.body, contentType);
  if (body !== undefined) {
    const ct = contentType ?? "application/json";
    parts.push("-H", `'content-type: ${ct}'`);
    parts.push("--data", singleQuote(body));
  }

  return parts.join(" ");
}

// Serialize the request body the way the target API reads it: a form-encoded
// string for Stripe, a JSON string for the internal services, or nothing for a
// bodyless GET. A body that is already a string is passed through verbatim.
function serializeBody(
  body: unknown,
  contentType: string | undefined,
): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.entries(body as Record<string, unknown>)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// The synchronous dispatch over the real egress path. The harness's dispatch is
// synchronous by contract, and the gateway runs in its own process, so a blocking
// curl is faithful here: the parent waits while the gateway services the request
// on its own event loop. The wire response (status + JSON body) is rebuilt into
// the ToolResponse the harness reads. The egress/state_mutation trace hops are
// written by the gateway process and merged afterward.
// ---------------------------------------------------------------------------

function dispatchOverBash(
  gatewayUrl: string,
  tag: string,
  workdir: string,
  req: EgressRequest,
): ToolResponse {
  const command = egressToCurl(req);
  const result = spawnSync("bash", ["-lc", command], {
    cwd: workdir,
    env: {
      ...process.env,
      GATEWAY_BASE_URL: gatewayUrl,
      SYNTH_SANDBOX_TAG: tag,
      // Hit the gateway base URL directly; no proxy indirection is needed since
      // the path already routes to the right kernel.
      NO_PROXY: "*",
      no_proxy: "*",
    },
    encoding: "utf8",
  });

  const raw = result.stdout ?? "";
  const { body, status } = splitWireResponse(raw);
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
    // The state_mutations channel is the gateway's to emit; the harness never
    // sees it on the wire, so the reconstructed response carries none.
    state_mutations: [],
  };
}

// Split the curl output into the wire body and the HTTP status the -w sentinel
// appended. A malformed response surfaces as a 502 with the raw text, which the
// judge treats as a tool error rather than silently passing.
function splitWireResponse(raw: string): { body: unknown; status: number } {
  const idx = raw.lastIndexOf("__STATUS__");
  if (idx === -1) {
    return { body: raw.length > 0 ? raw : null, status: 502 };
  }
  const bodyText = raw.slice(0, idx);
  const status = Number.parseInt(raw.slice(idx + "__STATUS__".length).trim(), 10);
  let body: unknown = bodyText;
  try {
    body = bodyText.length > 0 ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }
  return { body, status: Number.isFinite(status) ? status : 502 };
}

// ---------------------------------------------------------------------------
// Driving one fixture over the bash path. A WorldRunnerHandle is assembled whose
// emit collects the harness's own events and whose dispatch issues the real
// command. After the harness finishes, the gateway's trace lines are read back
// and merged with the harness events into one per-fixture trace the judge scores.
// ---------------------------------------------------------------------------

async function runFixtureOverBash(
  harness: Harness,
  fixture: Fixture,
  runId: string,
  dir: string,
): Promise<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }> {
  const tag = `tag_${runId}_${fixture.id}`;
  const gateway = await startGateway(fixture.id, runId, harness.version, tag, dir);
  const substrate = await createLocalBashSubstrate({
    binding: { gatewayBaseUrl: gateway.url, sandboxTag: tag },
  });

  const harnessEvents: TraceEvent[] = [];
  let seq = 0;
  const emit = (
    event: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">,
  ): TraceEvent => {
    const full: TraceEvent = {
      v: 1,
      run_id: runId,
      seq: seq++,
      ts: new Date(0).toISOString(),
      ...event,
    };
    harnessEvents.push(full);
    return full;
  };

  const handle: WorldRunnerHandle = {
    runId,
    fixtureId: fixture.id,
    harnessVersion: harness.version,
    emit,
    bash: { async runCommand() { return { exitCode: 0, stdout: "", stderr: "" }; } },
    dispatch: (req) =>
      dispatchOverBash(gateway.url, tag, substrate.workingDirectory, req),
  };

  // The runner's run-begin/run-end frames are emitted here so the trace shape
  // matches the in-process sweep the judge already reads.
  emit({
    fixture_id: fixture.id,
    harness_version: harness.version,
    parent_seq: null,
    actor: "world",
    kind: "run",
    span: { id: "run", phase: "begin" },
    payload: { harness_version: harness.version, fixture_id: fixture.id, model: "scripted-bash" },
  });

  let errored = false;
  try {
    await harness.run(fixture, handle);
  } catch {
    errored = true;
  }

  const harnessClosed = harnessEvents.some(
    (e) => e.kind === "run" && e.span.phase === "end",
  );
  if (!harnessClosed) {
    emit({
      fixture_id: fixture.id,
      harness_version: harness.version,
      parent_seq: 0,
      actor: "world",
      kind: "run",
      span: { id: "run", phase: "end" },
      payload: { terminal_decision: errored ? "errored" : "blocked", duration_ms: 0 },
    });
  }

  gateway.close();
  await substrate.dispose();

  // Merge the gateway-written egress hops with the harness events into one trace.
  // The judge scans by kind/phase/payload and does not depend on cross-stream
  // parent_seq, so a single re-sequenced concatenation is a faithful per-fixture
  // trace: the harness frames plus the egress/dispatch/state_mutation hops the
  // real HTTP path produced.
  const gatewayEvents = readGatewayEvents(gateway.traceFile);
  const merged = mergeTrace(harnessEvents, gatewayEvents);

  return { fixtureId: fixture.id, fixture, events: merged };
}

function readGatewayEvents(traceFile: string): TraceEvent[] {
  if (!existsSync(traceFile)) return [];
  const text = readFileSync(traceFile, "utf8");
  const events: TraceEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    events.push(JSON.parse(line) as TraceEvent);
  }
  return events;
}

// Merge the harness frames and the gateway hops into one trace with a single
// monotonic seq. The harness frames keep their relative order (run begin first,
// run end last); the gateway hops are spliced in before the run-end so the trace
// reads top to bottom as run -> turns/invocations + egress chains -> run end.
function mergeTrace(
  harnessEvents: TraceEvent[],
  gatewayEvents: TraceEvent[],
): TraceEvent[] {
  const runEndIndex = harnessEvents.findIndex(
    (e) => e.kind === "run" && e.span.phase === "end",
  );
  const head =
    runEndIndex === -1 ? harnessEvents : harnessEvents.slice(0, runEndIndex);
  const tail = runEndIndex === -1 ? [] : harnessEvents.slice(runEndIndex);

  const ordered = [...head, ...gatewayEvents, ...tail];
  return ordered.map((e, i) => ({ ...e, seq: i }));
}

// ---------------------------------------------------------------------------
// Sweep, judge, and the dashboard. Identical scoring to the in-process sweep, so
// any divergence in the numbers is a fidelity bug in the egress path, not the
// judge.
// ---------------------------------------------------------------------------

interface BashRunResult {
  runId: string;
  harnessVersion: HarnessVersion;
  fixtures: Array<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }>;
}

async function sweepOverBash(
  runId: string,
  harness: Harness,
  fixtures: Fixture[],
  dir: string,
): Promise<BashRunResult> {
  const results: BashRunResult["fixtures"] = [];
  for (const fixture of fixtures) {
    results.push(await runFixtureOverBash(harness, fixture, runId, dir));
  }
  return { runId, harnessVersion: harness.version, fixtures: results };
}

async function judgeRun(run: BashRunResult): Promise<RunScore> {
  const judge = createJudge(deterministicCxScorer);
  const pack = loadRefundPack();
  return judge.scoreRun({
    runId: run.runId,
    harnessVersion: run.harnessVersion,
    rubric: pack.rubric,
    fixtures: run.fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      fixture: f.fixture,
      events: f.events,
    })),
  });
}

function writeTraces(baseDir: string, run: BashRunResult): void {
  const runDir = join(baseDir, run.runId);
  mkdirSync(runDir, { recursive: true });
  for (const f of run.fixtures) {
    const lines = f.events.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(join(runDir, `${f.fixtureId}.jsonl`), lines + "\n", "utf8");
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}
function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printDashboard(v1: RunScore, v2: RunScore): void {
  const rows: Array<[string, string, string]> = [
    ["Metric", "v1 (naive)", "v2 (tightened)"],
    ["Technical pass", pct(v1.technical_pass_rate), pct(v2.technical_pass_rate)],
    ["Cash Burned", dollars(v1.cash_burned_cents), dollars(v2.cash_burned_cents)],
    ["Trust Score", v1.trust_score.toFixed(0), v2.trust_score.toFixed(0)],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length)) + 2;
  const w1 = Math.max(...rows.map((r) => r[1].length)) + 2;
  const w2 = Math.max(...rows.map((r) => r[2].length)) + 2;

  console.log("");
  console.log("  Synthetic Harness Lab: Refund Trap sweep (keyless, real shell + HTTP)");
  console.log("  " + "-".repeat(w0 + w1 + w2));
  for (const [i, row] of rows.entries()) {
    console.log("  " + pad(row[0], w0) + pad(row[1], w1) + pad(row[2], w2));
    if (i === 0) console.log("  " + "-".repeat(w0 + w1 + w2));
  }
  console.log("");
  console.log(
    `  Technical pass held flat at ${pct(v1.technical_pass_rate)} while Cash Burned went ` +
      `${dollars(v1.cash_burned_cents)} -> ${dollars(v2.cash_burned_cents)} and Trust ` +
      `${v1.trust_score.toFixed(0)} -> ${v2.trust_score.toFixed(0)}, all over the real egress path.`,
  );
  console.log("");
  console.log("  v1 per-fixture verdicts (bash path):");
  for (const verdict of v1.fixture_verdicts) {
    const tags = verdict.failure_tags.length > 0 ? verdict.failure_tags.join(", ") : "none";
    console.log(
      `    ${pad(verdict.fixture_id, 22)} ${pad(dollars(verdict.dollar_impact_cents), 12)} [${tags}]`,
    );
  }
  console.log("");
}

function parseTracesDir(argv: string[]): string {
  const idx = argv.indexOf("--traces");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    return resolve(argv[idx + 1]!);
  }
  return resolve(process.cwd(), "traces-bash");
}

async function main(): Promise<void> {
  const tracesDir = parseTracesDir(process.argv.slice(2));
  const pack = loadRefundPack();
  const workDir = mkdtempSync(join(tmpdir(), "synth-sweep-bash-"));

  const v1Run = await sweepOverBash("run_v1_bash", scriptedHarnessV1, pack.fixtures, workDir);
  writeTraces(tracesDir, v1Run);
  const v1Score = await judgeRun(v1Run);

  const v2Run = await sweepOverBash("run_v2_bash", scriptedHarnessV2, pack.fixtures, workDir);
  writeTraces(tracesDir, v2Run);
  const v2Score = await judgeRun(v2Run);

  printDashboard(v1Score, v2Score);
  console.log(`  Traces written to ${tracesDir}/run_v1_bash and ${tracesDir}/run_v2_bash`);
  console.log("");
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function singleQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
