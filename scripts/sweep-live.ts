// The live-path sweep: the same dashboard as `npm run sweep:bash`, but the agent
// under test is driven by a real model through the Claude Agent SDK instead of the
// scripted harness. Each fixture is run through the live harness, which exposes a
// single bash tool to the model over an in-process MCP server; every command the
// model runs executes on the same local bash substrate the bash sweep uses, and
// its outbound HTTP reaches a standalone egress gateway process bound to the
// fixture. The gateway dispatches into the scoped kernels, moves the hidden money,
// and writes the egress -> tool_dispatch -> state_mutation chain. The Judge scores
// the merged trace exactly as it scores the scripted runs.
//
// This is the only path that needs a model credential. If none is present the
// sweep prints a friendly pointer to the keyless scripted proofs and exits 0
// WITHOUT calling the API, so the file is safe to run in a keyless environment.
//
// Usage:
//   npm run sweep:live
//   tsx scripts/sweep-live.ts
//   tsx scripts/sweep-live.ts --traces ./out/traces-live
//   tsx scripts/sweep-live.ts --max-turns 24

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
} from "node:fs";
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
import { createLocalBashSubstrate } from "@/world/bash-local.js";
import {
  createLiveHarness,
  hasModelCredential,
  loadPinnedRefundSpec,
} from "@/harness/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GATEWAY_SERVER = join(HERE, "gateway-server.ts");
// Invoke the tsx binary directly rather than through `npx`, so stdio is wired
// straight to the gateway process (the READY handshake and the CLOSE signal cross
// without an npm exec wrapper buffering or swallowing them).
const TSX_BIN = resolve(process.cwd(), "node_modules", ".bin", "tsx");

// ---------------------------------------------------------------------------
// One bound gateway process for one fixture, identical to the bash sweep's
// orchestration: it prints READY <url> when listening and exits on the CLOSE
// signal, appending its egress trace hops to the JSONL trace file the parent
// reads back after the harness finishes.
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

  const child: ChildProcessWithoutNullStreams = spawn(TSX_BIN, [GATEWAY_SERVER], {
    env: {
      ...process.env,
      GATEWAY_FIXTURE_ID: fixtureId,
      GATEWAY_RUN_ID: runId,
      GATEWAY_VERSION: version,
      GATEWAY_TAG: tag,
      GATEWAY_TRACE_FILE: traceFile,
    },
  });

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
// Driving one fixture through the live model. A WorldRunnerHandle is assembled
// whose `bash` is the real local substrate bound to this fixture's gateway, so
// the live harness's bash tool runs the model's commands for real and their
// egress reaches the gateway. The handle's `dispatch` is present to satisfy the
// seam but is unused on the live path: the model only ever runs shell commands.
// After the harness finishes, the gateway's egress hops are read back and merged
// with the harness frames into one per-fixture trace the Judge scores.
// ---------------------------------------------------------------------------

async function runFixtureLive(
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

  // The live harness drives the world through `world.bash`; binding it to the
  // real substrate is what makes the model's commands execute and reach the
  // gateway. `dispatch` is a no-op fallback the live path never calls.
  const handle: WorldRunnerHandle = {
    runId,
    fixtureId: fixture.id,
    harnessVersion: harness.version,
    emit,
    bash: substrate,
    dispatch: (_req: EgressRequest): ToolResponse => ({
      status: 501,
      headers: { "content-type": "application/json" },
      body: { error: "structured dispatch is unused on the live path" },
      state_mutations: [],
    }),
  };

  // The run-begin/run-end frames are emitted here so the trace shape matches the
  // in-process and bash sweeps the Judge already reads.
  emit({
    fixture_id: fixture.id,
    harness_version: harness.version,
    parent_seq: null,
    actor: "world",
    kind: "run",
    span: { id: "run", phase: "begin" },
    payload: {
      harness_version: harness.version,
      fixture_id: fixture.id,
      model: "claude-opus-4-8",
    },
  });

  let errored = false;
  try {
    await harness.run(fixture, handle);
  } catch (error: unknown) {
    errored = true;
    console.error(`  fixture ${fixture.id} errored: ${String(error)}`);
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
      payload: {
        terminal_decision: errored ? "errored" : "blocked",
        duration_ms: 0,
      },
    });
  }

  gateway.close();
  await substrate.dispose();

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
// monotonic seq: the harness frames keep their relative order (run begin first,
// run end last) and the gateway hops are spliced in before the run-end, so the
// trace reads top to bottom as run -> turns/invocations + egress chains -> run end.
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
// Sweep, judge, and the dashboard. Identical scoring to the in-process and bash
// sweeps, so the live run is measured on the same Cash Burned and Trust axes.
// ---------------------------------------------------------------------------

interface LiveRunResult {
  runId: string;
  harnessVersion: HarnessVersion;
  fixtures: Array<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }>;
}

async function sweepLive(
  runId: string,
  harness: Harness,
  fixtures: Fixture[],
  dir: string,
): Promise<LiveRunResult> {
  const results: LiveRunResult["fixtures"] = [];
  for (const fixture of fixtures) {
    console.log(`  running ${harness.version} / ${fixture.id} ...`);
    results.push(await runFixtureLive(harness, fixture, runId, dir));
  }
  return { runId, harnessVersion: harness.version, fixtures: results };
}

async function judgeRun(run: LiveRunResult): Promise<RunScore> {
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

function writeTraces(baseDir: string, run: LiveRunResult): void {
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
  console.log("  Synthetic Harness Lab: Refund Trap sweep (live model, real shell + HTTP)");
  console.log("  " + "-".repeat(w0 + w1 + w2));
  for (const [i, row] of rows.entries()) {
    console.log("  " + pad(row[0], w0) + pad(row[1], w1) + pad(row[2], w2));
    if (i === 0) console.log("  " + "-".repeat(w0 + w1 + w2));
  }
  console.log("");
  console.log("  v1 per-fixture verdicts (live path):");
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
  return resolve(process.cwd(), "traces-live");
}

function parseMaxTurns(argv: string[]): number | undefined {
  const idx = argv.indexOf("--max-turns");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    const n = Number.parseInt(argv[idx + 1]!, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

// The friendly no-key exit. The live path is the only one that needs a model
// credential; without one this prints where the keyless proofs live and returns
// false so main() exits 0 without ever calling the API.
function guardCredential(): boolean {
  if (hasModelCredential()) {
    return true;
  }
  console.log("");
  console.log(
    "  Live harness needs ANTHROPIC_API_KEY or a Claude Code login. " +
      "The keyless scripted proof is: npm run sweep / npm run sweep:bash.",
  );
  console.log("");
  return false;
}

async function main(): Promise<void> {
  if (!guardCredential()) {
    return;
  }

  const argv = process.argv.slice(2);
  const tracesDir = parseTracesDir(argv);
  const maxTurns = parseMaxTurns(argv);
  const pack = loadRefundPack();
  const workDir = mkdtempSync(join(tmpdir(), "synth-sweep-live-"));

  // The live harnesses are built from the same pinned specs the gates validate:
  // v1 is rule-silent, v2 is the tightened spec. Construction is keyless; the
  // model is only called inside run(), already credential-guarded above.
  const liveV1 = createLiveHarness({
    spec: loadPinnedRefundSpec("v1"),
    version: "v1",
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  });
  const liveV2 = createLiveHarness({
    spec: loadPinnedRefundSpec("v2"),
    version: "v2",
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  });

  const v1Run = await sweepLive("run_v1_live", liveV1, pack.fixtures, workDir);
  writeTraces(tracesDir, v1Run);
  const v1Score = await judgeRun(v1Run);

  const v2Run = await sweepLive("run_v2_live", liveV2, pack.fixtures, workDir);
  writeTraces(tracesDir, v2Run);
  const v2Score = await judgeRun(v2Run);

  printDashboard(v1Score, v2Score);
  console.log(`  Traces written to ${tracesDir}/run_v1_live and ${tracesDir}/run_v2_live`);
  console.log("");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
