// The sweep CLI: the keyless end-to-end proof of the thesis. It loads the refund
// scenario pack, runs the scripted v1 (naive) and v2 (tightened) harnesses across
// all five fixtures through the World Runner and the deterministic kernels,
// judges each run, writes the unified per-fixture traces to disk, and prints a
// side-by-side dashboard: technical-pass %, Cash Burned $, and Trust Score.
//
// Expected result, with no Anthropic or Vercel key anywhere in the pipeline:
//   v1: technical pass 100%, Cash Burned $5,140, Trust ~38
//   v2: technical pass 100%, Cash Burned $0,     Trust ~91
//
// Usage:
//   npm run sweep
//   tsx scripts/sweep.ts
//   tsx scripts/sweep.ts --traces ./out/traces   (override the trace output dir)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createJudge, deterministicCxScorer } from "@/engine";
import type { RunScore, TraceEvent, HarnessVersion } from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { runSweep, scriptedHarnessV1, scriptedHarnessV2 } from "@/world/index.js";
import type { RunResult } from "@/world/index.js";

function parseTracesDir(argv: string[]): string {
  const idx = argv.indexOf("--traces");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    return resolve(argv[idx + 1]!);
  }
  return resolve(process.cwd(), "traces");
}

// Write one JSONL trace file per fixture, append-only lines in seq order, under
// traces/<run_id>/<fixture_id>.jsonl. This is the artifact the Judge reads and
// the viewer will render later.
function writeTraces(baseDir: string, run: RunResult): void {
  const runDir = join(baseDir, run.runId);
  mkdirSync(runDir, { recursive: true });
  for (const f of run.fixtures) {
    const lines = f.events.map((e: TraceEvent) => JSON.stringify(e)).join("\n");
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
  console.log("  Synthetic Harness Lab: Refund Trap sweep (keyless, deterministic)");
  console.log("  " + "-".repeat(w0 + w1 + w2));
  for (const [i, row] of rows.entries()) {
    console.log("  " + pad(row[0], w0) + pad(row[1], w1) + pad(row[2], w2));
    if (i === 0) console.log("  " + "-".repeat(w0 + w1 + w2));
  }
  console.log("");

  // The narrative line the demo rests on: the technical line never moved, but the
  // money and trust did. Same harness, judged on business fit instead of green checks.
  console.log(
    `  Technical pass held flat at ${pct(v1.technical_pass_rate)} while Cash Burned went ` +
      `${dollars(v1.cash_burned_cents)} -> ${dollars(v2.cash_burned_cents)} and Trust ` +
      `${v1.trust_score.toFixed(0)} -> ${v2.trust_score.toFixed(0)}.`,
  );

  // Per-fixture failure tags for v1, the input to the Optimize Reveal.
  console.log("");
  console.log("  v1 per-fixture verdicts:");
  for (const verdict of v1.fixture_verdicts) {
    const tags = verdict.failure_tags.length > 0 ? verdict.failure_tags.join(", ") : "none";
    console.log(
      `    ${pad(verdict.fixture_id, 22)} ${pad(dollars(verdict.dollar_impact_cents), 12)} [${tags}]`,
    );
  }
  console.log("");
}

async function judgeRun(run: RunResult): Promise<RunScore> {
  const judge = createJudge(deterministicCxScorer);
  const pack = loadRefundPack();
  return judge.scoreRun({
    runId: run.runId,
    harnessVersion: run.harnessVersion as HarnessVersion,
    rubric: pack.rubric,
    fixtures: run.fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      fixture: f.fixture,
      events: f.events,
    })),
  });
}

async function main(): Promise<void> {
  const tracesDir = parseTracesDir(process.argv.slice(2));
  const pack = loadRefundPack();

  // v1 sweep, then judge.
  const v1Run = await runSweep("run_v1", scriptedHarnessV1, pack.fixtures);
  writeTraces(tracesDir, v1Run);
  const v1Score = await judgeRun(v1Run);

  // v2 sweep, then judge.
  const v2Run = await runSweep("run_v2", scriptedHarnessV2, pack.fixtures);
  writeTraces(tracesDir, v2Run);
  const v2Score = await judgeRun(v2Run);

  printDashboard(v1Score, v2Score);
  console.log(`  Traces written to ${tracesDir}/run_v1 and ${tracesDir}/run_v2`);
  console.log("");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
