// The loan evaluate bridge: the metric backend the loan DSPy optimizer calls to
// score a candidate underwriting instruction. DSPy optimizes the harness's
// natural-language instruction (system prompt and procedure); this script turns
// one candidate into a runnable loan harness spec, runs it across the loan
// population's eval sample (live) or scores it deterministically (mock), judges
// the portfolio with the real six-dimension multi-objective judge, and prints a
// single JSON object carrying the headline aggregate, the per-dimension
// breakdown, the economic core, the fairness disparity, the tripped constraints,
// and the prompt cost the brevity regularizers read.
//
// The candidate is read as JSON, either from --instruction <json> or from stdin,
// in the shape { "system_prompt": string, "procedure"?: string[] }. It is layered
// onto the seed loan harness spec so the tool manifest, model, and submit-decision
// contract stay fixed and only the instruction text varies, which is exactly the
// surface DSPy is allowed to optimize.
//
// Two modes:
//
//   --live  (the default whenever a model credential is present)
//     Build a live loan harness from the candidate and run it across the eval
//     sample through the Claude Agent SDK over the loan function tools, dispatch
//     each tool call in-process into the generic kernels, derive each applicant's
//     decision off the trace, and judge the portfolio with the real judge plus
//     the live LLM judge for the two judgment dimensions. Needs a credential.
//
//   --mock  (keyless, forced with --mock; also the fallback when no credential is
//            present and --live was not requested)
//     A DETERMINISTIC stand-in that reads the candidate instruction text and the
//     applicant's queryable signals and derives a plausible per-applicant
//     decision and rationale with NO model call, then judges that portfolio with
//     the SAME real multi-objective judge (using the deterministic keyless LLM
//     judge stub). This exercises the whole loop and the full judge wiring
//     without a credential; it is labeled mock in its output.
//
// The headline the optimizer maximizes is `aggregate` (the judge's 0-100
// nonlinear score); the brevity regularizers subtract a length penalty and a
// rule-count penalty keyed off prompt_cost. token_estimate and rule_count are
// always faithful to the real candidate text in BOTH modes.
//
// Usage:
//   echo '{"system_prompt":"...","procedure":["..."]}' | npm run evaluate:loan
//   npm run evaluate:loan -- --mock --instruction '{"system_prompt":"..."}'
//   npm run evaluate:loan -- --live --eval-sample 12   (requires ANTHROPIC_API_KEY)

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  EgressRequest,
  ToolResponse,
  TraceEvent,
  WorldRunnerHandle,
  ToolKernel,
  WorldState,
} from "@/engine";
import {
  createLoanJudge,
  deterministicLoanLlmJudge,
  type LoanDecisionInput,
  type LoanDimension,
  type LoanLlmJudge,
  type LoanRunScore,
} from "@/engine/loan-judge.js";
import { deriveLoanTerminalDecision } from "@/engine/loan-terminal-decision.js";
import {
  loadLoanPack,
  type Applicant,
  type LoanDecision,
  type LoanScenarioPack,
} from "@/scenarios/loan/index.js";
import {
  hasModelCredential,
  createLiveLoanHarness,
  loadLoanHarnessSpec,
  LOAN_HARNESS_SPEC_SEED,
  LOAN_DECISION_KEY_PREFIX,
  type LoanHarnessSpec,
} from "@/harness/index.js";
import {
  buildLoanKernels,
  seedLoanWorld,
  createLoanApplicantWorld,
} from "@/world/loan-world.js";

// ---------------------------------------------------------------------------
// The candidate instruction and the output contract.
// ---------------------------------------------------------------------------

interface CandidateInstruction {
  system_prompt: string;
  procedure?: string[];
}

// The multi-objective goal-achievement block: the reward the optimizer
// maximizes. aggregate is the judge's headline 0-100 nonlinear score; the rest is
// the breakdown the dashboard and the optimizer's trajectory read.
interface GoalAchievement {
  aggregate: number;
  risk_adjusted_yield: number;
  disparity: number;
  constraint_penalty: number;
  tripped_constraints: string[];
  per_dimension: Record<LoanDimension, number>;
}

// What the two regularizers read, computed from the real candidate text in both
// modes so the penalties behave identically live and mock.
interface PromptCost {
  token_estimate: number;
  rule_count: number;
}

// One applicant's contribution to the contract: its id, the action the run took,
// and how many distinct loan tools the run read for it.
interface PerApplicantScore {
  applicant_id: string;
  decision: LoanDecision;
  distinct_tool_reads: number;
}

interface EvaluateOutput {
  mode: "live" | "mock";
  eval_sample_size: number;
  goal_achievement: GoalAchievement;
  prompt_cost: PromptCost;
  per_applicant: PerApplicantScore[];
}

// ---------------------------------------------------------------------------
// Candidate parsing and spec layering.
// ---------------------------------------------------------------------------

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

// Layer the candidate onto the seed loan harness spec, overriding only the system
// prompt and (when given) the procedure. The tool manifest, model, and success
// criterion stay fixed so the optimizer is scored purely on the instruction.
function candidateToSpec(candidate: CandidateInstruction): LoanHarnessSpec {
  const merged = {
    ...LOAN_HARNESS_SPEC_SEED,
    id: "loan-harness-candidate",
    version: "candidate",
    system_prompt: candidate.system_prompt,
    procedure:
      candidate.procedure !== undefined
        ? candidate.procedure
        : LOAN_HARNESS_SPEC_SEED.procedure,
  };
  return loadLoanHarnessSpec(merged);
}

// ---------------------------------------------------------------------------
// Prompt cost: the two regularizer inputs, computed from the real candidate text
// in both modes, identical to the refund bridge so the shared regularizers in
// py/dspy_optimizer/metric.py read the same signal for both packs.
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

function estimateTokens(candidate: CandidateInstruction): number {
  const text = [candidate.system_prompt, ...(candidate.procedure ?? [])].join(
    "\n",
  );
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

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
  "read",
  "pull",
  "analyze",
  "gather",
  "weigh",
  "approve",
  "decline",
  "counter",
  "request",
  "decide",
  "submit",
  "price",
];

function isImperativeClause(clause: string): boolean {
  const lower = clause.toLowerCase();
  return RULE_CUES.some((cue) => lower.includes(cue));
}

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

function computePromptCost(candidate: CandidateInstruction): PromptCost {
  return {
    token_estimate: estimateTokens(candidate),
    rule_count: countRules(candidate),
  };
}

// ---------------------------------------------------------------------------
// Eval-sample resolution and the applicants to score. The full population is
// used for final scoring elsewhere; the bridge scores the configurable eval
// sample so the live optimizer loop stays cost-bounded.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 8;

function resolveEvalSampleSize(argv: string[]): number | undefined {
  const idx = argv.indexOf("--eval-sample");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    const parsed = Number(argv[idx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  const fromEnv = Number(process.env.SYNTH_LOAN_EVAL_SAMPLE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return undefined;
}

function resolveMaxTurns(argv: string[]): number {
  const idx = argv.indexOf("--max-turns");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    const parsed = Number(argv[idx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  const fromEnv = Number(process.env.SYNTH_LOAN_MAX_TURNS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_MAX_TURNS;
}

// Whether the full held-out population should be scored instead of the eval
// sample. The optimizer selects on the eval sample for cost; a final scoring run
// passes --held-out to score the headline population the README reports.
function useHeldOut(argv: string[]): boolean {
  return argv.includes("--held-out");
}

function applicantsToScore(
  pack: LoanScenarioPack,
  heldOut: boolean,
): Applicant[] {
  const ids = new Set(heldOut ? pack.splits.held_out : pack.splits.eval_sample);
  return pack.applicants.filter((a) => ids.has(a.applicant_id));
}

// ---------------------------------------------------------------------------
// A minimal per-applicant run handle. The loan world dispatch and the harness
// both touch only emit/dispatch/fixtureId/harnessVersion; this stands those up
// over an in-memory trace buffer, the same shape the World Runner gives a
// fixture, scoped to one applicant.
// ---------------------------------------------------------------------------

interface ApplicantRun {
  applicant: Applicant;
  events: TraceEvent[];
}

function makeHandle(
  applicantId: string,
  events: TraceEvent[],
  dispatch: (req: EgressRequest) => ToolResponse,
): WorldRunnerHandle {
  let seq = 0;
  const emit = (
    event: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">,
  ): TraceEvent => {
    const full: TraceEvent = {
      v: 1,
      run_id: "run_evaluate_loan",
      seq: seq++,
      ts: new Date(0).toISOString(),
      ...event,
    };
    events.push(full);
    return full;
  };
  return {
    runId: "run_evaluate_loan",
    fixtureId: applicantId,
    // The loan path does not use the harness version for scoring; "v2" is a valid
    // enum value the frozen trace schema accepts.
    harnessVersion: "v2",
    emit,
    bash: {
      async runCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    dispatch,
  };
}

// ---------------------------------------------------------------------------
// Live mode: run each applicant through the real model over the loan tools.
// ---------------------------------------------------------------------------

async function evaluateLive(
  candidate: CandidateInstruction,
  applicants: Applicant[],
  pack: LoanScenarioPack,
  maxTurns: number,
): Promise<ApplicantRun[]> {
  const spec = candidateToSpec(candidate);
  const harness = createLiveLoanHarness({ spec, maxTurns });
  const kernels: Record<string, ToolKernel> = buildLoanKernels(pack);

  // A scratch dir is created so a future trace dump has a home; the in-process
  // path keeps traces in memory, so nothing is written unless a dump is added.
  mkdtempSync(join(tmpdir(), "synth-evaluate-loan-"));

  const runs: ApplicantRun[] = [];
  for (const applicant of applicants) {
    process.stderr.write(`  evaluating live / ${applicant.applicant_id} ...\n`);
    const events: TraceEvent[] = [];
    const state: Record<string, WorldState> = seedLoanWorld(pack, applicant);
    const applicantWorld = createLoanApplicantWorld(kernels, state);
    const handle = makeHandle(applicant.applicant_id, events, (req) =>
      applicantWorld.dispatch(handle, req),
    );
    try {
      await harness.run(applicant, handle);
    } catch (error: unknown) {
      process.stderr.write(
        `  applicant ${applicant.applicant_id} errored: ${String(error)}\n`,
      );
    }
    runs.push({ applicant, events });
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Mock mode: a deterministic, keyless policy that reads the candidate
// instruction text and the applicant's own queryable signals and derives a
// per-applicant decision and rationale with NO model call. The decisions are
// then judged by the SAME real multi-objective judge, so the full six-dimension
// breakdown and the nonlinear aggregate are faithful; only the decision-making
// is heuristic. This is a plumbing fixture for the loop, not a real evaluation.
//
// The heuristic reads the signals the population seeds (credit score, observed
// income, derogatories, fraud) and applies a balanced policy whose strictness is
// nudged by the candidate text: a prompt that talks about risk/decline/fraud
// underwrites more cautiously, a prompt that talks about counter-offers banks
// more marginal applicants at reduced exposure, and a degenerate prompt that
// says nothing decides blind. Crucially, the mock NEVER reads the protected
// class, so a non-degenerate candidate is fair by construction and the optimizer
// loop can climb the aggregate; the fairness teeth are exercised by the live
// path and the judge's own keyless tests.
// ---------------------------------------------------------------------------

function combinedText(candidate: CandidateInstruction): string {
  return [candidate.system_prompt, ...(candidate.procedure ?? [])]
    .join("\n")
    .toLowerCase();
}

// The signals the mock policy reads off the applicant's seeded slices, the same
// records the generic kernel would return to a live agent. Reading them directly
// keeps the mock deterministic and avoids standing up the kernels for a keyless
// run; the live path reads the identical facts through the tools.
interface MockSignals {
  credit_score: number;
  derogatory_count: number;
  observed_monthly_income_cents: number;
  existing_debt_payments_cents: number;
  fraud_score: number;
  principal_cents: number;
}

function readMockSignals(applicant: Applicant): MockSignals {
  const slices = applicant.hidden_state;
  const report =
    slices["credit_bureau"]?.records[`report:${applicant.applicant_id}`] ?? {};
  const cashflow =
    slices["bank_transactions"]?.records[`cashflow:${applicant.applicant_id}`] ??
    {};
  const signal =
    slices["fraud_signal"]?.records[`signal:${applicant.applicant_id}`] ?? {};
  return {
    credit_score: numberOf(report["credit_score"], 600),
    derogatory_count: numberOf(report["derogatory_count"], 0),
    observed_monthly_income_cents: numberOf(
      cashflow["observed_monthly_income_cents"],
      0,
    ),
    existing_debt_payments_cents: numberOf(
      cashflow["existing_debt_payments_cents"],
      0,
    ),
    fraud_score: numberOf(signal["fraud_score"], 0),
    principal_cents: applicant.application.principal_cents,
  };
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

// The deterministic mock policy: a balanced underwrite whose decision is a
// function of the queryable signals only, with strictness and counter-offer
// appetite nudged by the candidate text. The number of distinct tools the mock
// "reads" is set to a sound count (it consults the application, bureau, bank, and
// fraud), so info_efficiency lands in the band for a non-degenerate prompt and
// drops toward blind for an empty one.
function mockDecide(
  applicant: Applicant,
  signals: MockSignals,
  text: string,
): { decision: LoanDecision; rationale: string; distinctReads: number } {
  // A degenerate (empty or near-empty) instruction decides blind: it cannot tell
  // the agent which signals to read, so it declines with no grounding and reads
  // almost nothing.
  if (text.trim().length < 20) {
    return {
      decision: "decline",
      rationale: "",
      distinctReads: 1,
    };
  }

  const cautious =
    text.includes("risk") ||
    text.includes("decline") ||
    text.includes("fraud") ||
    text.includes("default");
  const usesCounter =
    text.includes("counter") || text.includes("marginal") || text.includes("reduced");

  // A high fraud signal is decisive regardless of credit: request more
  // information rather than booking a likely-fraudulent loan.
  if (signals.fraud_score >= 70) {
    return {
      decision: "request_more_info",
      rationale:
        "Fraud signal is elevated; requesting more information before any " +
        "decision rather than booking on a flagged identity.",
      distinctReads: 4,
    };
  }

  // A simple affordability read: observed income net of existing debt against the
  // requested principal, combined with the credit score and derogatories.
  const netMonthly =
    signals.observed_monthly_income_cents - signals.existing_debt_payments_cents;
  const strong =
    signals.credit_score >= 700 && signals.derogatory_count === 0 && netMonthly > 0;
  const weak =
    signals.credit_score < 600 || signals.derogatory_count >= 2 || netMonthly <= 0;

  if (strong) {
    return {
      decision: "approve",
      rationale:
        `Approving: credit score ${signals.credit_score} with no derogatories ` +
        `and positive net cashflow supports the requested principal.`,
      distinctReads: 4,
    };
  }

  if (weak) {
    // A cautious prompt declines a weak file; a counter-offer-aware prompt may
    // still bank a borderline weak file at reduced exposure when the score is not
    // bottom-tier.
    if (usesCounter && signals.credit_score >= 560 && signals.derogatory_count < 3) {
      return {
        decision: "counter_offer",
        rationale:
          `Counter-offering a smaller, shorter loan: credit score ` +
          `${signals.credit_score} and thin cashflow argue for reduced exposure ` +
          `rather than the full requested amount.`,
        distinctReads: 4,
      };
    }
    return {
      decision: "decline",
      rationale:
        `Declining: credit score ${signals.credit_score}, ` +
        `${signals.derogatory_count} derogatories, and weak net cashflow do not ` +
        `support the requested principal.`,
      distinctReads: 4,
    };
  }

  // The genuinely marginal middle: a counter-offer-aware cautious prompt banks
  // these at reduced exposure; otherwise approve the better half and decline the
  // rest on credit score.
  if (usesCounter) {
    return {
      decision: "counter_offer",
      rationale:
        `Counter-offering: credit score ${signals.credit_score} is marginal, so ` +
        `a smaller loan books some margin at lower exposure than a full approval.`,
      distinctReads: 4,
    };
  }
  if (cautious && signals.credit_score < 660) {
    return {
      decision: "decline",
      rationale:
        `Declining: credit score ${signals.credit_score} is below appetite and ` +
        `cashflow does not clearly offset the risk.`,
      distinctReads: 3,
    };
  }
  return {
    decision: "approve",
    rationale:
      `Approving: credit score ${signals.credit_score} and adequate cashflow ` +
      `are within appetite for the requested amount.`,
    distinctReads: 3,
  };
}

// Build a synthetic trace slice for one mock applicant that carries exactly the
// distinct tool-read dispatches the mock policy "made" plus the decision capture,
// so the real judge's info_efficiency and decision derivation read the same event
// shapes they read on the live path.
function mockEventsFor(
  applicant: Applicant,
  distinctReads: number,
  decision: LoanDecision,
  rationale: string,
): TraceEvent[] {
  const events: TraceEvent[] = [];
  let seq = 0;
  const toolIds = [
    "application",
    "credit_bureau",
    "bank_transactions",
    "fraud_signal",
    "lending_guidelines",
  ];
  const reads = toolIds.slice(0, Math.max(0, Math.min(distinctReads, toolIds.length)));
  for (const toolId of reads) {
    events.push({
      v: 1,
      run_id: "run_evaluate_loan",
      fixture_id: applicant.applicant_id,
      harness_version: "v2",
      seq: seq++,
      ts: new Date(0).toISOString(),
      parent_seq: null,
      actor: `tool:${toolId}`,
      kind: "tool_dispatch",
      span: { id: `td_${toolId}`, phase: "begin" },
      payload: { tool_id: toolId, request: {} },
    });
  }
  events.push({
    v: 1,
    run_id: "run_evaluate_loan",
    fixture_id: applicant.applicant_id,
    harness_version: "v2",
    seq: seq++,
    ts: new Date(0).toISOString(),
    parent_seq: null,
    actor: "harness",
    kind: "state_mutation",
    span: { id: `decision_${applicant.applicant_id}`, phase: "point" },
    payload: {
      key: `${LOAN_DECISION_KEY_PREFIX}:${applicant.applicant_id}`,
      before: null,
      after: { decision, rationale },
      reason: "terminal underwriting decision submitted",
    },
  });
  return events;
}

function evaluateMock(
  candidate: CandidateInstruction,
  applicants: Applicant[],
): ApplicantRun[] {
  const text = combinedText(candidate);
  return applicants.map((applicant) => {
    const signals = readMockSignals(applicant);
    const { decision, rationale, distinctReads } = mockDecide(
      applicant,
      signals,
      text,
    );
    const events = mockEventsFor(applicant, distinctReads, decision, rationale);
    return { applicant, events };
  });
}

// ---------------------------------------------------------------------------
// Judging: derive each applicant's decision off its trace and score the whole
// portfolio with the real multi-objective judge.
// ---------------------------------------------------------------------------

async function judgeRuns(
  runs: ApplicantRun[],
  llmJudge: LoanLlmJudge,
): Promise<LoanRunScore> {
  const judge = createLoanJudge(llmJudge);
  const inputs: LoanDecisionInput[] = runs.map((r) => {
    const { decision, rationale } = deriveLoanTerminalDecision(
      r.applicant.applicant_id,
      r.events,
    );
    return { applicant: r.applicant, decision, rationale, events: r.events };
  });
  return judge.scoreRun("run_evaluate_loan", inputs);
}

function countDistinctReads(events: TraceEvent[]): number {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.kind === "tool_dispatch" && e.span.phase === "begin") {
      const id = (e.payload as { tool_id?: unknown }).tool_id;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids.size;
}

function assembleOutput(
  mode: "live" | "mock",
  candidate: CandidateInstruction,
  runs: ApplicantRun[],
  score: LoanRunScore,
): EvaluateOutput {
  const perDimension = {} as Record<LoanDimension, number>;
  for (const d of score.dimensions) {
    perDimension[d.dimension] = round(d.value);
  }

  const perApplicant: PerApplicantScore[] = runs.map((r) => {
    const { decision } = deriveLoanTerminalDecision(
      r.applicant.applicant_id,
      r.events,
    );
    return {
      applicant_id: r.applicant.applicant_id,
      decision,
      distinct_tool_reads: countDistinctReads(r.events),
    };
  });

  return {
    mode,
    eval_sample_size: runs.length,
    goal_achievement: {
      aggregate: round(score.aggregate),
      risk_adjusted_yield: round6(score.risk_adjusted_yield),
      disparity: round(score.disparity),
      constraint_penalty: round(score.constraint_penalty),
      tripped_constraints: score.tripped_constraints,
      per_dimension: perDimension,
    },
    prompt_cost: computePromptCost(candidate),
    per_applicant: perApplicant,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Mode selection and entry point.
// ---------------------------------------------------------------------------

type Mode = "live" | "mock";

function resolveMode(argv: string[]): { mode: Mode; liveRequested: boolean } {
  const mockRequested = argv.includes("--mock");
  const liveRequested = argv.includes("--live");
  if (mockRequested && liveRequested) {
    throw new Error("Pass at most one of --mock or --live.");
  }
  if (mockRequested) return { mode: "mock", liveRequested: false };
  if (liveRequested) return { mode: "live", liveRequested: true };
  return { mode: hasModelCredential() ? "live" : "mock", liveRequested: false };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const candidate = await readCandidate(argv);
  const { mode, liveRequested } = resolveMode(argv);

  if (mode === "live" && !hasModelCredential()) {
    process.stdout.write(
      JSON.stringify({
        error: "missing_credential",
        message:
          "Live loan evaluation requires a model credential (ANTHROPIC_API_KEY " +
          "or a Claude Code login). None was found. Rerun with --mock for the " +
          "keyless heuristic, or set a credential.",
        live_requested: liveRequested,
      }) + "\n",
    );
    process.exitCode = 1;
    return;
  }

  const evalSampleSize = resolveEvalSampleSize(argv);
  const pack = loadLoanPack(
    evalSampleSize !== undefined ? { eval_sample_size: evalSampleSize } : {},
  );
  const applicants = applicantsToScore(pack, useHeldOut(argv));

  let runs: ApplicantRun[];
  let llmJudge: LoanLlmJudge;

  if (mode === "live") {
    runs = await evaluateLive(candidate, applicants, pack, resolveMaxTurns(argv));
    // The live path scores the two judgment dimensions with the real LLM judge.
    // It is imported lazily so the keyless mock path never loads an SDK.
    const { createLiveLoanLlmJudge } = await import(
      "@/engine/loan-llm-judge-live.js"
    );
    llmJudge = createLiveLoanLlmJudge({});
  } else {
    runs = evaluateMock(candidate, applicants);
    llmJudge = deterministicLoanLlmJudge;
  }

  const score = await judgeRuns(runs, llmJudge);
  const output = assembleOutput(mode, candidate, runs, score);
  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch((error: unknown) => {
  process.stdout.write(
    JSON.stringify({ error: "evaluate_loan_failed", message: String(error) }) +
      "\n",
  );
  process.exitCode = 1;
});
