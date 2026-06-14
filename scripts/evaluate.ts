// The TS evaluate bridge: the metric backend the DSPy optimizer calls to score a
// candidate harness instruction. DSPy optimizes the harness's natural-language
// instructions (its system prompt and procedure); this script turns one such
// candidate into a runnable harness spec, drives it across the refund fixtures
// through the real world (gateway + kernels), judges every run with the real
// deterministic judge, and prints a single JSON object carrying the train and
// held-out Trust Scores, the technical pass rate, the cash burned, and the per
// fixture verdicts. DSPy reads that JSON off stdout and selects on the held-out
// Trust Score.
//
// The candidate is read as JSON, either from --instruction <json> or from stdin,
// in the shape:
//   { "system_prompt": string, "procedure"?: string[] }
// It is layered onto the pinned v1 spec so the tool manifest, billing URL, and
// enforced constraints stay fixed and only the instruction text varies, which is
// exactly the surface DSPy is allowed to optimize.
//
// Two modes select how the candidate is scored:
//
//   --live  (the default whenever a model credential is present)
//     Build a live harness from the candidate spec and run it across the fixtures
//     through the Claude Agent SDK over the same bash tool + egress gateway path
//     the live sweep uses, then judge the merged trace. This needs a credential
//     (ANTHROPIC_API_KEY or a Claude Code login). If --live is requested and no
//     credential is present, the script prints a JSON error to stdout and exits
//     nonzero.
//
//   --mock  (keyless, forced with --mock; also the fallback when no credential is
//            present and --live was not explicitly requested)
//     A DETERMINISTIC stand-in metric that scores the instruction text alone,
//     without calling any model. It checks whether the instruction tells the
//     harness to look up the order, customer, and policy before refunding and to
//     escalate the cases that must not be auto-refunded, and derives a plausible
//     train and held-out Trust Score plus the implied failure tags from those
//     signals. This is explicitly a plumbing fixture for verifying the optimizer
//     loop wiring without a model; it is not a real evaluation and is labeled
//     mock in its output.
//
// The output is a single JSON object on stdout and nothing else (diagnostics go
// to stderr), so the calling optimizer can parse stdout directly. The metric
// DSPy maximizes is held-out goal achievement MINUS a prompt length penalty
// MINUS a rule-count penalty, so the contract reports both the goal-achievement
// signal and the prompt-cost signal the two regularizers read:
//   {
//     "mode": "live" | "mock",
//     "goal_achievement": {
//       "train_trust": number,        // 0-100 Trust on the train split
//       "holdout_trust": number,      // 0-100 Trust on the held-out split (the headline)
//       "technical_pass_rate": number,// 0-1 over all fixtures
//       "per_dimension": { [dimension_id]: number }  // mean business-fit subscore in [0,1]
//     },
//     "prompt_cost": {
//       "token_estimate": number,     // tokens in system_prompt + procedure
//       "rule_count": number          // distinct imperative rules/lines in the instruction
//     },
//     "per_fixture": [ { "fixture_id": string, "trust_score": number, "failure_tags": string[] } ]
//   }
//
// goal_achievement is the reward; prompt_cost is what the length and rule-count
// penalties subtract from it. token_estimate and rule_count are always faithful
// to the real candidate text in BOTH modes, so the regularizers behave the same
// whether the goal-achievement signal came from the live model or the mock.
//
// Usage:
//   echo '{"system_prompt":"...","procedure":["..."]}' | npm run evaluate
//   npm run evaluate -- --instruction '{"system_prompt":"...","procedure":["..."]}'
//   npm run evaluate -- --mock --instruction '{"system_prompt":"..."}'
//   npm run evaluate -- --live   (requires ANTHROPIC_API_KEY)

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createJudge, deterministicCxScorer } from "@/engine";
import type {
  RunScore,
  FixtureVerdict,
  FailureTag,
  TraceEvent,
  HarnessVersion,
  Fixture,
  Harness,
  WorldRunnerHandle,
  EgressRequest,
  ToolResponse,
  ScenarioPack,
} from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { createLocalBashSubstrate } from "@/world/bash-local.js";
import {
  createLiveHarness,
  hasModelCredential,
  loadHarnessSpec,
  REFUND_HARNESS_SPEC_V1,
  type HarnessSpec,
} from "@/harness/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GATEWAY_SERVER = join(HERE, "gateway-server.ts");
const TSX_BIN = resolve(process.cwd(), "node_modules", ".bin", "tsx");

// The id stamped on the candidate spec and used for the evaluate run. A single
// fixed version keeps the judge's harness_version attribution and the trace shape
// identical to the pinned-spec runs the rest of the lab produces.
const EVALUATE_VERSION: HarnessVersion = "v2";

// ---------------------------------------------------------------------------
// The candidate instruction and how it becomes a runnable spec.
// ---------------------------------------------------------------------------

// The candidate the optimizer proposes: only the natural-language instruction
// surface. Everything else (tools, billing URL, enforced constraints) is fixed.
interface CandidateInstruction {
  system_prompt: string;
  procedure?: string[];
}

// The goal-achievement block: the reward the optimizer maximizes. train_trust
// and holdout_trust are the judge's 0-100 Trust Scores on the two splits;
// holdout_trust is the headline the optimizer selects on. technical_pass_rate is
// the 0-1 mechanical pass rate over all fixtures. per_dimension reports the mean
// business-fit subscore in [0,1] for each rubric dimension across all fixtures,
// so the optimizer can see which concern a candidate moved.
interface GoalAchievement {
  train_trust: number;
  holdout_trust: number;
  technical_pass_rate: number;
  per_dimension: Record<string, number>;
}

// The prompt-cost block: what the two regularizers read. token_estimate is a
// faithful token count of the candidate instruction text; rule_count is the
// number of distinct imperative rules/lines in it. Both are always computed from
// the real candidate, never the mode, so the length penalty and the rule-count
// penalty subtract the same cost in live and mock.
interface PromptCost {
  token_estimate: number;
  rule_count: number;
}

// One fixture's contribution to the contract: its id, the per-fixture Trust on
// the 0-100 scale, and the failure tags the judge (or the mock heuristic) emits.
interface PerFixtureScore {
  fixture_id: string;
  trust_score: number;
  failure_tags: string[];
}

interface EvaluateOutput {
  mode: "live" | "mock";
  goal_achievement: GoalAchievement;
  prompt_cost: PromptCost;
  per_fixture: PerFixtureScore[];
}

// Parse the candidate from --instruction or stdin, validating the shape. The
// instruction is the only thing the optimizer controls, so a malformed candidate
// is a hard error reported as JSON rather than a crash.
async function readCandidate(argv: string[]): Promise<CandidateInstruction> {
  const idx = argv.indexOf("--instruction");
  const raw =
    idx !== -1 && argv[idx + 1] !== undefined
      ? argv[idx + 1]!
      : await readStdin();
  if (raw.trim().length === 0) {
    throw new Error(
      "No candidate instruction provided. Pass --instruction <json> or pipe " +
        "the JSON on stdin.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Candidate instruction is not valid JSON: ${String(error)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).system_prompt !== "string"
  ) {
    throw new Error(
      'Candidate instruction must be an object of shape { "system_prompt": ' +
        'string, "procedure"?: string[] }.',
    );
  }
  const obj = parsed as Record<string, unknown>;
  const procedure = obj.procedure;
  if (procedure !== undefined) {
    if (
      !Array.isArray(procedure) ||
      !procedure.every((s) => typeof s === "string")
    ) {
      throw new Error("Candidate instruction `procedure` must be a string[].");
    }
  }
  return {
    system_prompt: obj.system_prompt as string,
    ...(procedure !== undefined ? { procedure: procedure as string[] } : {}),
  };
}

function readStdin(): Promise<string> {
  return new Promise<string>((resolveStdin) => {
    if (process.stdin.isTTY) {
      resolveStdin("");
      return;
    }
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
    });
    process.stdin.on("end", () => resolveStdin(buffer));
  });
}

// Layer the candidate instruction onto the pinned v1 spec, overriding only the
// system prompt and (when given) the procedure. The tool manifest, billing URL,
// and enforced constraints stay fixed so the optimizer is scored purely on the
// instruction surface. The result is validated against the frozen schema.
function candidateToSpec(candidate: CandidateInstruction): HarnessSpec {
  const merged = {
    ...REFUND_HARNESS_SPEC_V1,
    id: "refund-harness-candidate",
    version: EVALUATE_VERSION,
    system_prompt: candidate.system_prompt,
    procedure:
      candidate.procedure !== undefined
        ? candidate.procedure
        : REFUND_HARNESS_SPEC_V1.procedure,
  };
  return loadHarnessSpec(merged);
}

// ---------------------------------------------------------------------------
// Prompt cost: the two regularizer inputs, computed from the real candidate text
// in both modes. The optimizer's metric is held-out Trust MINUS a length penalty
// (keyed off token_estimate) MINUS a rule-count penalty (keyed off rule_count),
// so a concise, few-rule instruction that achieves the goal beats a long one
// that achieves the same goal. Both numbers are faithful to the candidate text
// and never depend on the evaluation mode.
// ---------------------------------------------------------------------------

// Tokens-per-character divisor for the keyless token estimate. Four characters
// per token is the standard rough English approximation and needs no tokenizer
// dependency; the estimate only has to be monotonic in prompt length for the
// length penalty to do its job.
const CHARS_PER_TOKEN = 4;

// Estimate the token count of the candidate instruction (system prompt plus
// procedure). A real tokenizer would refine this, but chars/4 is a faithful,
// dependency-free proxy that the length penalty can be tuned against.
function estimateTokens(candidate: CandidateInstruction): number {
  const text = [candidate.system_prompt, ...(candidate.procedure ?? [])].join(
    "\n",
  );
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Count the distinct imperative rules/instructions in the candidate. Each
// procedure step is one rule. The system prompt is split into rule-bearing
// clauses on sentence and line boundaries, and only clauses that read as an
// instruction (an imperative or a "must/should/never" directive) are counted, so
// that purely descriptive framing does not inflate the count and the rule-count
// penalty pushes the optimizer to prune redundant rules rather than append new
// ones.
function countRules(candidate: CandidateInstruction): number {
  const procedureRules = (candidate.procedure ?? []).filter(
    (step) => step.trim().length > 0,
  ).length;

  const clauses = candidate.system_prompt
    .split(/[\n.;]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const promptRules = clauses.filter(isImperativeClause).length;

  return procedureRules + promptRules;
}

// The verbs and modal directives that mark a clause as a distinct rule. A clause
// counts when it opens with an imperative verb or contains a directive modal, so
// "Look up the order" and "you must escalate" each count once and descriptive
// scene-setting ("You are a support agent") does not.
const RULE_CUES: readonly string[] = [
  "must",
  "should",
  "never",
  "always",
  "do not",
  "don't",
  "ensure",
  "verify",
  "check",
  "confirm",
  "look up",
  "lookup",
  "read",
  "issue",
  "escalate",
  "refund",
  "review",
  "block",
  "require",
];

function isImperativeClause(clause: string): boolean {
  const lower = clause.toLowerCase();
  return RULE_CUES.some((cue) => lower.includes(cue));
}

function computePromptCost(candidate: CandidateInstruction): PromptCost {
  return {
    token_estimate: estimateTokens(candidate),
    rule_count: countRules(candidate),
  };
}

// ---------------------------------------------------------------------------
// Live mode: run the candidate spec across the fixtures through the real model.
// This mirrors the live sweep's per-fixture orchestration: one bound gateway
// process per fixture, a local bash substrate wired to it, the live harness
// driving the model over the bash tool, then the merged trace handed to the
// judge.
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
    process.stderr.write(`  fixture ${fixture.id} errored: ${String(error)}\n`);
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

// Judge one subset of fixtures' runs into a RunScore, the same way every sweep
// in the lab judges. Scoring the subsets separately is what gives the train and
// held-out Trust Scores their independent values.
async function judgeFixtures(
  runId: string,
  pack: ScenarioPack,
  fixtures: Array<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }>,
): Promise<RunScore> {
  const judge = createJudge(deterministicCxScorer);
  return judge.scoreRun({
    runId,
    harnessVersion: EVALUATE_VERSION,
    rubric: pack.rubric,
    fixtures: fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      fixture: f.fixture,
      events: f.events,
    })),
  });
}

// Run the candidate live across every fixture, then judge the train and held-out
// subsets separately and fold the per-fixture verdicts together.
async function evaluateLive(
  candidate: CandidateInstruction,
): Promise<EvaluateOutput> {
  const pack = loadRefundPack();
  const spec = candidateToSpec(candidate);
  const harness = createLiveHarness({ spec, version: EVALUATE_VERSION });
  const workDir = mkdtempSync(join(tmpdir(), "synth-evaluate-live-"));
  const runId = "run_evaluate_live";

  const runs: Array<{
    fixtureId: string;
    fixture: Fixture;
    events: TraceEvent[];
  }> = [];
  for (const fixture of pack.fixtures) {
    process.stderr.write(`  evaluating live / ${fixture.id} ...\n`);
    runs.push(await runFixtureLive(harness, fixture, runId, workDir));
  }

  return assembleOutput("live", pack, candidate, runs);
}

// ---------------------------------------------------------------------------
// Assemble the output contract from judged subset scores. Used by live mode;
// mock mode builds the same shape from its heuristic.
// ---------------------------------------------------------------------------

function trainIds(pack: ScenarioPack): Set<string> {
  return new Set(pack.splits.train);
}
function holdoutIds(pack: ScenarioPack): Set<string> {
  return new Set(pack.splits.held_out);
}

function subsetOf(
  pack: ScenarioPack,
  runs: Array<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }>,
  ids: Set<string>,
): Array<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }> {
  return runs.filter((r) => ids.has(r.fixtureId));
}

function perFixtureFromVerdicts(verdicts: FixtureVerdict[]): PerFixtureScore[] {
  return verdicts.map((v) => ({
    fixture_id: v.fixture_id,
    // The per-fixture Trust contribution is reported as the fixture's own
    // correctness on the same 0-100 scale: a correct verdict is 100, a wrong one
    // 0. The split Trust Scores in goal_achievement are the judge's weighted
    // aggregates.
    trust_score: v.correct ? 100 : 0,
    failure_tags: v.failure_tags as string[],
  }));
}

// The mean business-fit subscore per rubric dimension across every fixture, in
// [0,1]. This surfaces which concern (money safety, policy adherence, fraud
// catch, escalation, customer experience) a candidate actually moved, alongside
// the aggregate Trust Scores.
function perDimensionFromVerdicts(
  verdicts: FixtureVerdict[],
): Record<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const v of verdicts) {
    for (const d of v.dimension_scores) {
      const entry = sums.get(d.dimension) ?? { total: 0, count: 0 };
      entry.total += d.score;
      entry.count += 1;
      sums.set(d.dimension, entry);
    }
  }
  const out: Record<string, number> = {};
  for (const [dimension, { total, count }] of sums) {
    out[dimension] = count === 0 ? 0 : round(total / count);
  }
  return out;
}

async function assembleOutput(
  mode: "live" | "mock",
  pack: ScenarioPack,
  candidate: CandidateInstruction,
  runs: Array<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }>,
): Promise<EvaluateOutput> {
  const trainRuns = subsetOf(pack, runs, trainIds(pack));
  const holdoutRuns = subsetOf(pack, runs, holdoutIds(pack));

  const trainScore = await judgeFixtures("run_evaluate_train", pack, trainRuns);
  const holdoutScore = await judgeFixtures(
    "run_evaluate_holdout",
    pack,
    holdoutRuns,
  );
  const allScore = await judgeFixtures("run_evaluate_all", pack, runs);

  return {
    mode,
    goal_achievement: {
      train_trust: round(trainScore.trust_score),
      holdout_trust: round(holdoutScore.trust_score),
      technical_pass_rate: allScore.technical_pass_rate,
      per_dimension: perDimensionFromVerdicts(allScore.fixture_verdicts),
    },
    prompt_cost: computePromptCost(candidate),
    per_fixture: perFixtureFromVerdicts(allScore.fixture_verdicts),
  };
}

// ---------------------------------------------------------------------------
// Mock mode: the deterministic, keyless stand-in metric. It scores the candidate
// instruction text alone, with no model and no world run, so the optimizer loop
// wiring can be exercised end to end without a credential. This is a plumbing
// fixture, not a real evaluation.
//
// The heuristic reads the instruction the way the live agent would be steered by
// it: does it tell the harness to look up the order, the customer, and the policy
// before refunding, and to escalate (not auto-refund) the cases that must not be
// paid out? Each fixture's expected_failure_tags name the checks that fixture
// turns on, so a fixture is treated as handled correctly only when the
// instruction covers every check its expected tags imply. The subset Trust
// Scores and the implied failure tags are derived from that coverage.
// ---------------------------------------------------------------------------

// The instruction signals the heuristic looks for, and the failure tag each one
// guards against when absent. The signals are matched as case-insensitive
// keyword/intent cues over the combined system prompt and procedure text.
interface InstructionSignal {
  // The failure tag this signal prevents when the instruction expresses it.
  guards: FailureTag;
  // Keyword cues; the signal is present when any cue appears in the text.
  cues: string[];
}

const INSTRUCTION_SIGNALS: InstructionSignal[] = [
  {
    guards: "NEVER_CHECKED_CUSTOMER",
    cues: ["look up the customer", "lookup_customer", "customer account", "customer record"],
  },
  {
    guards: "MISSED_FRAUD_CHECK",
    cues: ["fraud", "serial", "abuse", "refund history", "recent refund", "chargeback"],
  },
  {
    guards: "REFUNDED_OUT_OF_WINDOW",
    cues: ["window", "30 day", "30-day", "purchase date", "within the window", "eligibility"],
  },
  {
    guards: "WRONG_PAYMENT_METHOD",
    cues: ["payment method", "original method", "method on record", "same method"],
  },
  {
    guards: "SKIPPED_MANAGER_APPROVAL",
    cues: ["manager", "approval", "approve", "threshold", "escalate"],
  },
];

// Whether the instruction expresses a given signal: any cue appears in the text.
function hasSignal(text: string, signal: InstructionSignal): boolean {
  return signal.cues.some((cue) => text.includes(cue));
}

// Whether the instruction tells the harness to escalate rather than auto-refund
// the cases that must not be paid. Escalation intent is the gate the trap cases
// require, so it is read explicitly in addition to the per-tag signals.
function expressesEscalation(text: string): boolean {
  return (
    text.includes("escalate") ||
    text.includes("escalate_to_human") ||
    text.includes("route to a human") ||
    text.includes("do not refund") ||
    text.includes("don't refund") ||
    text.includes("block")
  );
}

// Whether the instruction tells the harness to gather evidence (order, customer,
// policy) before issuing a refund. Pre-screening is the shared prerequisite for
// catching every trap, so it raises the floor of the mock score.
function expressesPreScreen(text: string): { order: boolean; customer: boolean; policy: boolean } {
  return {
    order:
      text.includes("look up the order") ||
      text.includes("lookup_order") ||
      text.includes("order details") ||
      text.includes("the order"),
    customer: hasSignal(text, INSTRUCTION_SIGNALS[0]!),
    policy:
      text.includes("policy") ||
      text.includes("read_policy") ||
      text.includes("refund policy"),
  };
}

function combinedText(candidate: CandidateInstruction): string {
  const parts = [candidate.system_prompt, ...(candidate.procedure ?? [])];
  return parts.join("\n").toLowerCase();
}

// Map a fixture's expected failure tags to the instruction signals that guard
// them, and decide whether the instruction covers every guard the fixture needs.
// A trap fixture is handled correctly in the mock only when the instruction both
// expresses escalation and covers each guard its expected tags imply.
function mockFixtureCorrect(
  fixture: Fixture,
  text: string,
  escalate: boolean,
): { correct: boolean; missingTags: FailureTag[] } {
  const expected = fixture.ground_truth.expected_failure_tags as FailureTag[];
  // The legitimate case has no expected failure tags and the correct action is
  // to refund: it is handled correctly as long as the instruction does not block
  // every refund outright. The mock always credits it (a non-degenerate prompt
  // refunds the good case), so its only failure mode is an empty instruction.
  if (fixture.ground_truth.correct_action === "refund") {
    return { correct: text.trim().length > 0, missingTags: [] };
  }
  const missing: FailureTag[] = [];
  for (const tag of expected) {
    const signal = INSTRUCTION_SIGNALS.find((s) => s.guards === tag);
    if (signal === undefined) continue;
    if (!hasSignal(text, signal)) missing.push(tag);
  }
  const correct = escalate && missing.length === 0;
  return { correct, missingTags: correct ? [] : expected };
}

// Score one subset deterministically: a fixture handled correctly contributes
// its full weight; the subset Trust Score is the share handled correctly on the
// 0-100 scale, blended with a small pre-screen bonus so an instruction that asks
// for the right lookups scores above one that refunds blindly even before it
// expresses escalation. Cash burned accrues the dollar impact of every trap the
// instruction would auto-refund.
function mockSubset(
  fixtures: Fixture[],
  text: string,
  escalate: boolean,
): { trust: number; correctFraction: number; perFixture: PerFixtureScore[] } {
  const preScreen = expressesPreScreen(text);
  const preScreenFraction =
    (Number(preScreen.order) + Number(preScreen.customer) + Number(preScreen.policy)) / 3;

  let correctCount = 0;
  const perFixture: PerFixtureScore[] = [];

  for (const fixture of fixtures) {
    const { correct, missingTags } = mockFixtureCorrect(fixture, text, escalate);
    if (correct) {
      correctCount += 1;
    }
    perFixture.push({
      fixture_id: fixture.id,
      trust_score: correct ? 100 : 0,
      failure_tags: correct ? [] : missingTags,
    });
  }

  // The Trust Score blends the correctness share (weighted 0.85) with the
  // pre-screen coverage (weighted 0.15), so a thorough-but-not-yet-escalating
  // instruction reads as partial progress rather than a flat zero. Both terms are
  // in [0,100], so the blend stays in range.
  const correctFraction =
    fixtures.length === 0 ? 0 : correctCount / fixtures.length;
  const trust = round(0.85 * correctFraction * 100 + 0.15 * preScreenFraction * 100);

  return { trust, correctFraction, perFixture };
}

// The mock per-dimension approximation. The keyless heuristic does not run the
// judge's per-dimension logic, so it reports each business-fit dimension as the
// fraction of fixtures the instruction handles correctly, and the
// customer-experience dimension as a credited 1 (the legitimate case is always
// paid by a non-degenerate prompt). This is a faithful stand-in for the loop
// wiring, not a real per-dimension evaluation.
function mockPerDimension(correctFraction: number): Record<string, number> {
  const value = round(correctFraction);
  return {
    money_safety: value,
    policy_adherence: value,
    fraud_catch: value,
    appropriate_escalation: value,
    customer_experience: 1,
  };
}

function evaluateMock(candidate: CandidateInstruction): EvaluateOutput {
  const pack = loadRefundPack();
  const text = combinedText(candidate);
  const escalate = expressesEscalation(text);

  const train = pack.fixtures.filter((f) => trainIds(pack).has(f.id));
  const holdout = pack.fixtures.filter((f) => holdoutIds(pack).has(f.id));
  const all = pack.fixtures;

  const trainResult = mockSubset(train, text, escalate);
  const holdoutResult = mockSubset(holdout, text, escalate);
  const allResult = mockSubset(all, text, escalate);

  return {
    mode: "mock",
    goal_achievement: {
      train_trust: trainResult.trust,
      holdout_trust: holdoutResult.trust,
      // Technical pass stays pinned at 100% in the mock, mirroring the lab's
      // invariant that the mechanical checks always pass and only business fit
      // moves.
      technical_pass_rate: 1,
      per_dimension: mockPerDimension(allResult.correctFraction),
    },
    prompt_cost: computePromptCost(candidate),
    per_fixture: allResult.perFixture,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Mode selection and entry point.
// ---------------------------------------------------------------------------

type Mode = "live" | "mock";

// Resolve the run mode from the flags and the credential. --mock forces the
// keyless heuristic. --live forces the live path and is an error without a
// credential. With neither flag, live is the default when a credential is
// present and the mock is the keyless fallback.
function resolveMode(argv: string[]): { mode: Mode; liveRequested: boolean } {
  const mockRequested = argv.includes("--mock");
  const liveRequested = argv.includes("--live");
  if (mockRequested && liveRequested) {
    throw new Error("Pass at most one of --mock or --live.");
  }
  if (mockRequested) return { mode: "mock", liveRequested: false };
  if (liveRequested) return { mode: "live", liveRequested: true };
  return {
    mode: hasModelCredential() ? "live" : "mock",
    liveRequested: false,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const candidate = await readCandidate(argv);
  const { mode, liveRequested } = resolveMode(argv);

  if (mode === "live" && !hasModelCredential()) {
    // --live was explicitly requested but no credential is present: report a
    // clean JSON error on stdout and exit nonzero so the optimizer can detect it.
    process.stdout.write(
      JSON.stringify({
        error: "missing_credential",
        message:
          "Live evaluation requires a model credential (ANTHROPIC_API_KEY or a " +
          "Claude Code login). None was found. Rerun with --mock for the " +
          "keyless heuristic, or set a credential.",
        live_requested: liveRequested,
      }) + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const output =
    mode === "live" ? await evaluateLive(candidate) : evaluateMock(candidate);

  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch((error: unknown) => {
  // Any unexpected failure is reported as JSON on stdout so the optimizer never
  // sees a half-written payload, and the process exits nonzero.
  process.stdout.write(
    JSON.stringify({ error: "evaluate_failed", message: String(error) }) + "\n",
  );
  process.exitCode = 1;
});
