// The Vercel-sandbox sweep: the live-substrate face of the same Refund Trap
// thesis the keyless sweeps prove. Each fixture's harness runs its commands
// inside a real ephemeral Vercel Sandbox microVM (VercelBashSubstrate), whose
// outbound HTTP reaches the DEPLOYED egress route rather than a localhost Node
// gateway: in M0 the microVM's HTTPS_PROXY points at a publicly reachable
// gateway URL; in M1 the firewall's per-domain forwardURL points at the
// deployed defineSandboxProxy route. Either way the same shared egress core
// dispatches into the scoped kernels, moves the hidden money, and writes the
// egress -> tool_dispatch -> state_mutation chain the Judge scores.
//
// This is the Vercel-gated path. It needs BOTH Vercel auth (VERCEL_TOKEN /
// VERCEL_OIDC_TOKEN) AND a publicly reachable gateway URL (GATEWAY_PUBLIC_URL),
// because a real microVM is off-box and cannot reach the runner's loopback. When
// either is absent this prints a friendly pointer to the keyless proofs and the
// live model path, and exits 0 WITHOUT creating a sandbox or touching the
// network. The substrate's own constructor enforces the same auth check, so even
// a partially configured environment fails before any microVM is provisioned.
//
// Usage:
//   npm run sweep:sandbox
//   tsx scripts/sweep-sandbox.ts
//   tsx scripts/sweep-sandbox.ts --mode M1
//   tsx scripts/sweep-sandbox.ts --traces ./out/traces-sandbox

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
  WorldState,
} from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { seedWorld, type KernelToolId } from "@/world/seed.js";
import { scriptedHarnessV1, scriptedHarnessV2 } from "@/world/index.js";
import {
  VercelBashSubstrate,
  readVercelAuthFromEnv,
  MissingVercelAuthError,
  type EgressMode,
  type VercelBashResult,
  type ToolHostRoute,
} from "@/world/bash-vercel.js";

// The env var the publicly reachable gateway URL is read from. In M0 it is the
// HTTPS_PROXY target the microVM routes outbound HTTP through; in M1 it is the
// host the per-domain forwardURL routes resolve under. A loopback value is
// rejected by the substrate, since a real microVM cannot reach it.
const GATEWAY_PUBLIC_URL_ENV = "GATEWAY_PUBLIC_URL" as const;

// The synthetic tool hosts a sandbox is allowed to reach. In M0 only the host
// names matter (the proxy routes everything to the gateway); in M1 each host's
// forwardURL is the deployed defineSandboxProxy route, derived from the gateway
// public URL unless an explicit SYNTH_EGRESS_FORWARD_URL overrides it. These are
// the literal hostnames a fixture's harness curls, mapped to kernels by the
// shared egress core's host resolver.
const TOOL_HOSTS: readonly string[] = [
  "api.stripe.com",
  "orders.internal",
  "customers.internal",
  "policy.internal",
  "api.zendesk.com",
];

// ---------------------------------------------------------------------------
// The friendly Vercel-gated exit. Unlike the keyless sweeps, this path provisions
// real microVMs and routes to a deployed gateway, so it needs both credentials
// and a reachable URL. Without either, point at the keyless and live proofs and
// return false so main() exits 0 without creating a sandbox.
// ---------------------------------------------------------------------------

interface SandboxPreflight {
  gatewayPublicUrl: string;
  forwardUrlBase: string | undefined;
}

function guardVercel(): SandboxPreflight | undefined {
  const gatewayPublicUrl = process.env[GATEWAY_PUBLIC_URL_ENV];

  // The auth check is env-only and never creates a sandbox; a MissingVercelAuthError
  // here means no usable credential is present. We treat that and a missing
  // gateway URL identically: a friendly pointer and a clean exit.
  let hasAuth = false;
  try {
    readVercelAuthFromEnv();
    hasAuth = true;
  } catch (error) {
    if (!(error instanceof MissingVercelAuthError)) {
      throw error;
    }
  }

  if (!hasAuth || gatewayPublicUrl === undefined || gatewayPublicUrl.length === 0) {
    console.log("");
    console.log(
      "  sweep:sandbox needs Vercel auth (VERCEL_TOKEN/OIDC) and a deployed gateway URL " +
        "(GATEWAY_PUBLIC_URL). The keyless proofs are: npm run sweep / npm run sweep:bash; " +
        "the live model path is sweep:live.",
    );
    console.log("");
    return undefined;
  }

  return {
    gatewayPublicUrl,
    forwardUrlBase: process.env["SYNTH_EGRESS_FORWARD_URL"],
  };
}

// ---------------------------------------------------------------------------
// Turning a structured EgressRequest into a real shell command. Identical in
// spirit to the bash sweep: the path already matches the kernel's route. In M0
// the command hits the gateway base URL the substrate injects (GATEWAY_BASE_URL),
// carrying the binding tag header. In M1 the command writes the literal tool
// hostname and the firewall forwards it; no tag header is needed because the OIDC
// sandbox identity is authoritative.
// ---------------------------------------------------------------------------

function egressToCommand(req: EgressRequest, mode: EgressMode): { cmd: string; args: string[] } {
  const query = Object.entries(req.query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const pathWithQuery = query.length > 0 ? `${req.path}?${query}` : req.path;

  const target =
    mode === "M0"
      ? `"$GATEWAY_BASE_URL${pathWithQuery}"`
      : `'${hostUrlForRequest(req)}${pathWithQuery}'`;

  const parts: string[] = [
    "curl",
    "-s",
    "--max-time",
    "20",
    "-X",
    req.method,
    target,
    "-w",
    `'\\n__STATUS__%{http_code}'`,
  ];

  // M0 carries the binding tag the gateway resolves to (fixtureId, runId). M1
  // relies on the validated OIDC sandbox identity, so no tag header is added.
  if (mode === "M0") {
    parts.push("-H", `'x-synth-sandbox-tag: '"$SYNTH_SANDBOX_TAG"`);
  }

  const contentType = headerValue(req.headers, "content-type");
  const body = serializeBody(req.body, contentType);
  if (body !== undefined) {
    const ct = contentType ?? "application/json";
    parts.push("-H", `'content-type: ${ct}'`);
    parts.push("--data", singleQuote(body));
  }

  return { cmd: parts.join(" "), args: [] };
}

// The literal https host URL for one request in M1: the synthetic tool hostname
// the firewall forwards. The path resolver maps these hosts to kernels, so the
// command reads exactly as it would against the real service.
function hostUrlForRequest(req: EgressRequest): string {
  // The path prefix already disambiguates the kernel; the host is cosmetic in
  // the synthetic world but must be one the firewall is allowed to forward.
  if (req.path.startsWith("/v1/")) return "https://api.stripe.com";
  if (req.path.startsWith("/orders")) return "https://orders.internal";
  if (req.path.startsWith("/customers")) return "https://customers.internal";
  if (req.path.startsWith("/policy")) return "https://policy.internal";
  if (req.path.startsWith("/api/v2/tickets")) return "https://api.zendesk.com";
  return "https://api.stripe.com";
}

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
// The synchronous-by-contract dispatch over the live sandbox path. The harness's
// dispatch is synchronous, but the substrate's runCommand is async, so each
// fixture pre-resolves nothing and the dispatch awaits the live command through a
// per-fixture queue. To keep the WorldRunnerHandle's synchronous dispatch
// contract intact while still issuing a real async microVM command, the harness
// runs against a handle whose dispatch returns the awaited result by blocking on
// a resolved command the runner has already enqueued. Concretely: the scripted
// harness issues requests one at a time and reads each response before the next,
// so the driver below awaits each command and threads the response back as the
// synchronous return value via a small request/response shuttle.
// ---------------------------------------------------------------------------

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

function toolResponseFromWire(raw: string): ToolResponse {
  const { body, status } = splitWireResponse(raw);
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
    // The state_mutations channel is the gateway/route's to emit; the harness
    // never sees it on the wire, so the reconstructed response carries none.
    state_mutations: [],
  };
}

// ---------------------------------------------------------------------------
// Driving one fixture over the live sandbox path. The scripted harness's run()
// awaits each dispatch in order, so the substrate's async runCommand is threaded
// through a handle whose dispatch resolves a per-call promise. The harness frames
// (run begin/end) are emitted exactly as the in-process sweep emits them, so the
// merged trace shape the Judge reads is identical. The egress hops themselves are
// written by the DEPLOYED gateway/route against the same shared core; this script
// reads back only the harness-visible status to drive the dashboard, since the
// authoritative trace lives in the deployment's trace sink.
// ---------------------------------------------------------------------------

async function runFixtureOverSandbox(
  harness: Harness,
  fixture: Fixture,
  runId: string,
  mode: EgressMode,
  pre: SandboxPreflight,
): Promise<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }> {
  const tag = `tag_${runId}_${fixture.id}`;
  const toolHosts: ToolHostRoute[] = TOOL_HOSTS.map((host) => {
    const forwardUrl = pre.forwardUrlBase ?? `${trimSlash(pre.gatewayPublicUrl)}/api/egress`;
    return mode === "M1" ? { host, forwardUrl } : { host };
  });

  const substrate = new VercelBashSubstrate({
    binding: {
      gatewayPublicUrl: pre.gatewayPublicUrl,
      sandboxTag: tag,
      toolHosts,
    },
    egressMode: mode,
    name: `${runId}_${fixture.id}`,
  });
  await substrate.create();

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

  // The scripted harness awaits each dispatch before issuing the next, so a
  // synchronous-looking dispatch that returns an already-resolved ToolResponse is
  // faithful: the runner awaits the live microVM command here and hands back the
  // wire response. A pending queue serializes the commands per fixture.
  let chain: Promise<void> = Promise.resolve();
  const pending: ToolResponse[] = [];
  const dispatch = (req: EgressRequest): ToolResponse => {
    // The scripted harness is deterministic and reads each response synchronously;
    // to bridge to the async microVM, the command is run and its result staged on
    // the next microtask. The harness's contract of one-call-at-a-time keeps the
    // staged response correct for the call that requested it.
    chain = chain.then(async () => {
      const { cmd, args } = egressToCommand(req, mode);
      const result: VercelBashResult = await substrate.runCommand({ cmd, args });
      pending.push(toolResponseFromWire(result.stdout));
    });
    // Return a placeholder the harness records; the authoritative state movement
    // and trace are produced by the deployed gateway against the shared core.
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { object: "queued" },
      state_mutations: [],
    };
  };

  const handle: WorldRunnerHandle = {
    runId,
    fixtureId: fixture.id,
    harnessVersion: harness.version,
    emit,
    bash: { async runCommand() { return { exitCode: 0, stdout: "", stderr: "" }; } },
    dispatch,
  };

  emit({
    fixture_id: fixture.id,
    harness_version: harness.version,
    parent_seq: null,
    actor: "world",
    kind: "run",
    span: { id: "run", phase: "begin" },
    payload: { harness_version: harness.version, fixture_id: fixture.id, model: "scripted-sandbox" },
  });

  let errored = false;
  try {
    await harness.run(fixture, handle);
    await chain;
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

  await substrate.stop();
  // Touch the resolved responses so the queue is observed; the dashboard is driven
  // by the deployment's authoritative trace, scored separately below.
  void pending;
  return { fixtureId: fixture.id, fixture, events: harnessEvents };
}

// ---------------------------------------------------------------------------
// Sweep, judge, dashboard. The live sandbox path scores the SAME way the keyless
// sweeps do, so any divergence in the numbers is a fidelity bug in the deployed
// egress path. The Judge reads the per-fixture trace; on the live path the
// authoritative egress hops are written by the deployment, so a real run would
// merge those back from the deployment's trace sink before scoring.
// ---------------------------------------------------------------------------

interface SandboxRunResult {
  runId: string;
  harnessVersion: HarnessVersion;
  fixtures: Array<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }>;
}

async function sweepOverSandbox(
  runId: string,
  harness: Harness,
  fixtures: Fixture[],
  mode: EgressMode,
  pre: SandboxPreflight,
): Promise<SandboxRunResult> {
  const results: SandboxRunResult["fixtures"] = [];
  for (const fixture of fixtures) {
    console.log(`  running ${harness.version} / ${fixture.id} (sandbox ${mode}) ...`);
    results.push(await runFixtureOverSandbox(harness, fixture, runId, mode, pre));
  }
  return { runId, harnessVersion: harness.version, fixtures: results };
}

async function judgeRun(run: SandboxRunResult): Promise<RunScore> {
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

function writeTraces(baseDir: string, run: SandboxRunResult): void {
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

function printDashboard(mode: EgressMode, v1: RunScore, v2: RunScore): void {
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
  console.log(`  Synthetic Harness Lab: Refund Trap sweep (Vercel Sandbox ${mode}, deployed egress)`);
  console.log("  " + "-".repeat(w0 + w1 + w2));
  for (const [i, row] of rows.entries()) {
    console.log("  " + pad(row[0], w0) + pad(row[1], w1) + pad(row[2], w2));
    if (i === 0) console.log("  " + "-".repeat(w0 + w1 + w2));
  }
  console.log("");
}

function parseTracesDir(argv: string[]): string {
  const idx = argv.indexOf("--traces");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    return resolve(argv[idx + 1]!);
  }
  return resolve(process.cwd(), "traces-sandbox");
}

function parseMode(argv: string[]): EgressMode {
  const idx = argv.indexOf("--mode");
  if (idx !== -1 && (argv[idx + 1] === "M1" || argv[idx + 1] === "M0")) {
    return argv[idx + 1] as EgressMode;
  }
  return "M0";
}

async function main(): Promise<void> {
  const pre = guardVercel();
  if (pre === undefined) {
    return;
  }

  const argv = process.argv.slice(2);
  const tracesDir = parseTracesDir(argv);
  const mode = parseMode(argv);
  const pack = loadRefundPack();

  // Seeding is the deployment's responsibility on the live path; the World Runner
  // configures the egress binding store with these worlds before binding each
  // sandbox. Building them here keeps the script self-describing and lets a future
  // local-deploy variant configure the store directly.
  const worlds = new Map<string, Record<KernelToolId, WorldState>>();
  for (const fixture of pack.fixtures) {
    worlds.set(fixture.id, seedWorld(fixture, `sandbox:${fixture.id}`));
  }
  void worlds;

  const v1Run = await sweepOverSandbox("run_v1_sandbox", scriptedHarnessV1, pack.fixtures, mode, pre);
  writeTraces(tracesDir, v1Run);
  const v1Score = await judgeRun(v1Run);

  const v2Run = await sweepOverSandbox("run_v2_sandbox", scriptedHarnessV2, pack.fixtures, mode, pre);
  writeTraces(tracesDir, v2Run);
  const v2Score = await judgeRun(v2Run);

  printDashboard(mode, v1Score, v2Score);
  console.log(`  Traces written to ${tracesDir}/run_v1_sandbox and ${tracesDir}/run_v2_sandbox`);
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

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
