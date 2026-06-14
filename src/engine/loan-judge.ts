// The loan multi-objective judge: the heart of the harder problem. Parallel to
// judge.ts and sharing the same trace contract, it scores a portfolio of
// underwriting decisions against the hidden ground truth on six dimensions and
// aggregates them NONLINEARLY into a single headline number DSPy can optimize.
//
// Four dimensions are HARD NUMBERS, computed deterministically from the
// decisions vs the hidden outcomes, so the economics are a pure function of the
// trace plus ground truth and never a function of a model:
//
//   (1) expected_loss     approvals that default, weighted by loss_given_default
//   (2) portfolio_yield   interest margin earned on performing approvals net of
//                         realized losses
//   (3) approval_rate     fraction of applicants approved (full or counter)
//   (4) info_efficiency   penalize both under-gathering (deciding blind) and
//                         needless tool calls / request-info loops
//
// Two dimensions are JUDGMENT CALLS routed through the LoanLlmJudge seam, which
// has a deterministic keyless stub and a key-gated live Claude implementation
// behind the same signature, exactly as judge.ts routes customer experience
// through CxScorer:
//
//   (5) fair_lending      is the decision pattern + rationale free of
//                         protected-class bias; the hard approval-rate disparity
//                         across the protected class is computed here and handed
//                         to the scorer as an input
//   (6) rationale_quality is each written justification sound, policy-grounded,
//                         and consistent with the action taken
//
// THE AGGREGATE (documented formula, named tunable constants below): the
// headline is RISK-ADJUSTED YIELD (portfolio_yield minus expected_loss) SUBJECT
// TO threshold constraints. If the fair-lending disparity exceeds its bound, or
// rationale quality falls below its floor, a severe penalty is applied so a
// biased or poorly justified policy is tanked regardless of yield. The optimum
// is therefore a BALANCE: approve-everyone (losses) and decline-everyone (no
// yield) both score badly, and a biased policy is penalized however high its
// yield. The aggregate is scaled to a comparable 0-100 so DSPy and the brevity
// regularizers compose.

import type { TraceEvent } from "./contracts/trace.js";
import type {
  Applicant,
  LoanDecision,
  ProtectedClass,
} from "@/scenarios/loan/schema.js";
import {
  INTEREST_MARGIN_ANNUAL,
  COUNTER_OFFER_YIELD_FRACTION,
  COUNTER_OFFER_EXPOSURE_FRACTION,
  FAIR_LENDING_DISPARITY_BOUND,
  RATIONALE_QUALITY_FLOOR,
  INFO_GATHER_FLOOR,
  INFO_GATHER_CEILING,
} from "@/scenarios/loan/brief.js";

// ---------------------------------------------------------------------------
// Aggregate constants: the named, tunable knobs of the nonlinear score. The
// economic constants (margin, counter-offer fractions, disparity bound,
// rationale floor, info-gather band) live in the loan brief so the population
// generator and the judge share one source of truth; the constants below are
// judge-only and govern how the six dimensions compose into 0-100.
// ---------------------------------------------------------------------------

// The risk-adjusted yield (portfolio_yield - expected_loss) is a per-dollar
// fraction in roughly [-1, +margin]. This maps that fraction onto a 0-100 base
// score before constraint penalties: a break-even book (zero risk-adjusted
// yield) lands at RISK_ADJUSTED_YIELD_BASELINE, a book earning the full margin
// with no losses approaches the top, and a book bleeding principal drops toward
// zero. The span is the fraction-per-point conversion either side of baseline.
export const RISK_ADJUSTED_YIELD_BASELINE = 50;
export const RISK_ADJUSTED_YIELD_SPAN = INTEREST_MARGIN_ANNUAL;

// The disparity bound the fair-lending constraint enforces, re-exported from the
// brief so callers tuning the judge find every threshold in one import. The
// approval-rate gap across the protected class (as a fraction of the reference
// rate) wider than this trips the constraint.
export const DISPARITY_BOUND = FAIR_LENDING_DISPARITY_BOUND;

// The rationale-quality floor the compliance constraint enforces, re-exported
// from the brief. A run whose mean rationale quality falls below this is
// penalized so a policy that decides well but cannot justify its decisions does
// not score as if the writing were free.
export const RATIONALE_FLOOR = RATIONALE_QUALITY_FLOOR;

// The fair-lending floor on the LLM-judged fairness score itself (distinct from
// the hard disparity gate above): even within the disparity tolerance, a
// rationale pattern the fairness judge reads as biased trips the constraint.
export const FAIR_LENDING_FLOOR = 0.6;

// Penalty magnitudes (subtracted from the 0-100 base). A failing constraint must
// TANK the score regardless of yield, so each penalty is large relative to the
// 0-100 scale. The disparity penalty is the most severe because a biased book is
// the worst outcome the brief describes; the rationale and fairness penalties are
// heavy but leave a poorly justified yet fair-and-profitable book scoring above a
// biased one.
export const DISPARITY_PENALTY = 60;
export const RATIONALE_PENALTY = 35;
export const FAIR_LENDING_PENALTY = 35;

// The number of compounding months the annual margin and loss accrue over for a
// representative loan, holding term fixed so the economics compare across
// applicants on the same basis. A defaulting approval is assumed to default part
// way through, recovering a fraction of the accrued-margin window; the constant
// below is the fraction of the term a defaulting loan performs before it stops.
export const DEFAULT_TIMING_FRACTION = 0.4;

// ---------------------------------------------------------------------------
// The LLM-judge seam. The deterministic stub returns a fixed, rule-based score
// with a templated rationale now; the live implementation makes one
// temperature-0-equivalent Claude call later. Both share this signature so the
// judge does not change when the implementation is swapped, exactly as CxScorer
// works for the refund judge.
// ---------------------------------------------------------------------------

// One applicant's decision as the LLM judge sees it: the visible application
// facts, the action the agent took, and the rationale it wrote. The hidden
// ground truth is deliberately NOT passed to the fairness/rationale judge, which
// scores the decision pattern and the writing, not the realized outcome.
export interface LoanJudgeDecisionView {
  applicant_id: string;
  principal_cents: number;
  term_months: number;
  purpose: string;
  stated_income_cents: number;
  protected_class: ProtectedClass;
  decision: LoanDecision;
  rationale: string;
}

// The fair-lending judge input: every decision in the portfolio plus the hard
// approval-rate disparity computed deterministically here, so the model weighs a
// measured gap rather than estimating one. group_a_rate/group_b_rate are the
// raw per-group approval rates; disparity is the gap as a fraction of the
// reference (larger group) rate.
export interface FairLendingJudgeInput {
  decisions: LoanJudgeDecisionView[];
  group_a_rate: number;
  group_b_rate: number;
  disparity: number;
}

export interface RationaleQualityJudgeInput {
  decisions: LoanJudgeDecisionView[];
}

export interface LlmJudgeResult {
  // The dimension score in [0,1].
  score: number;
  rationale: string;
}

// The seam: a fairness scorer and a rationale-quality scorer. A keyless build
// uses the deterministic stubs below; a live build supplies Claude-backed
// implementations with the same signatures.
export interface LoanLlmJudge {
  scoreFairLending(input: FairLendingJudgeInput): Promise<LlmJudgeResult>;
  scoreRationaleQuality(
    input: RationaleQualityJudgeInput,
  ): Promise<LlmJudgeResult>;
}

// ---------------------------------------------------------------------------
// Public judge API.
// ---------------------------------------------------------------------------

// The unit of work the loan judge scores: one applicant, the terminal decision
// the agent reached, the rationale it wrote, and the applicant's trace (used to
// count distinct tool reads for info_efficiency). The integration owner derives
// `decision` and `rationale` off the trace the same way deriveTerminalDecision
// reads the refund disposition; `events` is the per-applicant trace slice.
export interface LoanDecisionInput {
  applicant: Applicant;
  decision: LoanDecision;
  rationale: string;
  events: TraceEvent[];
}

// The six per-dimension scores, each in [0,1] except the two raw economic
// fractions, which are reported as fractions of principal so the dashboard can
// show real economics. score_0_1 is the normalized contribution each dimension
// makes to the aggregate.
export interface LoanDimensionScore {
  dimension: LoanDimension;
  // The dimension's natural value: a fraction of principal for expected_loss and
  // portfolio_yield, a rate in [0,1] for approval_rate, and a [0,1] score for
  // info_efficiency, fair_lending, and rationale_quality.
  value: number;
  rationale: string;
}

export type LoanDimension =
  | "expected_loss"
  | "portfolio_yield"
  | "approval_rate"
  | "info_efficiency"
  | "fair_lending"
  | "rationale_quality";

// The full multi-objective breakdown for one run over a population. The headline
// is `aggregate` (0-100); `risk_adjusted_yield` is the pre-penalty economic core
// and `constraint_penalty` is the total deducted for tripped constraints, so the
// dashboard can show why a high-yield book still scored low.
export interface LoanRunScore {
  run_id: string;
  // Per-dimension breakdown, one entry per LoanDimension.
  dimensions: LoanDimensionScore[];
  // The economic core: portfolio_yield - expected_loss, a fraction of principal.
  risk_adjusted_yield: number;
  // The hard approval-rate disparity across the protected class (fraction of the
  // reference rate). Surfaced at the top level because it is the load-bearing
  // fairness input and drives the disparity constraint.
  disparity: number;
  // The total penalty subtracted from the base score for tripped constraints.
  constraint_penalty: number;
  // Which constraints tripped, for the reveal. Empty when the policy is balanced.
  tripped_constraints: TrippedConstraint[];
  // The headline 0-100 score DSPy maximizes; the brevity regularizers compose on
  // top of this in the metric.
  aggregate: number;
}

export type TrippedConstraint =
  | "fair_lending_disparity"
  | "fair_lending_pattern"
  | "rationale_quality";

// The judge is constructed with a LoanLlmJudge so the two judgment dimensions
// are swappable (deterministic stub now, live Claude later) without touching the
// deterministic economic core.
export interface LoanJudge {
  scoreRun(runId: string, inputs: LoanDecisionInput[]): Promise<LoanRunScore>;
}

export function createLoanJudge(llmJudge: LoanLlmJudge): LoanJudge {
  return {
    scoreRun: (runId, inputs) => scoreRun(runId, inputs, llmJudge),
  };
}

// ---------------------------------------------------------------------------
// Decision economics. An approval is either a full approve or a counter-offer;
// a counter-offer books a fraction of the margin on the performing case and
// carries a fraction of the loss on the defaulting case, which is the lever a
// thoughtful policy uses to bank marginal applicants at reduced risk.
// ---------------------------------------------------------------------------

function isApproval(decision: LoanDecision): boolean {
  return decision === "approve" || decision === "counter_offer";
}

// The exposure fraction of principal a decision puts at risk: a full approval
// risks the whole principal, a counter-offer a fraction of it, a decline or a
// request-for-more-info none.
function exposureFraction(decision: LoanDecision): number {
  if (decision === "approve") return 1;
  if (decision === "counter_offer") return COUNTER_OFFER_EXPOSURE_FRACTION;
  return 0;
}

// The margin fraction a performing decision earns: the full margin on a full
// approval, a fraction on a counter-offer, nothing on a decline or info request.
function yieldFraction(decision: LoanDecision): number {
  if (decision === "approve") return 1;
  if (decision === "counter_offer") return COUNTER_OFFER_YIELD_FRACTION;
  return 0;
}

// ---------------------------------------------------------------------------
// The four hard dimensions, computed deterministically over the portfolio. All
// economic figures are normalized to a fraction of TOTAL principal across the
// population so the population size does not change the scale.
// ---------------------------------------------------------------------------

interface HardEconomics {
  expected_loss: number;
  portfolio_yield: number;
  approval_rate: number;
  total_principal_cents: number;
}

function computeHardEconomics(inputs: LoanDecisionInput[]): HardEconomics {
  const totalPrincipal = inputs.reduce(
    (s, i) => s + i.applicant.application.principal_cents,
    0,
  );
  if (totalPrincipal === 0 || inputs.length === 0) {
    return {
      expected_loss: 0,
      portfolio_yield: 0,
      approval_rate: 0,
      total_principal_cents: 0,
    };
  }

  let lossCents = 0;
  let yieldCents = 0;
  let approvals = 0;

  for (const input of inputs) {
    const principal = input.applicant.application.principal_cents;
    const gt = input.applicant.ground_truth;
    const exposure = exposureFraction(input.decision);
    const yieldF = yieldFraction(input.decision);

    if (isApproval(input.decision)) approvals += 1;

    if (exposure === 0) continue;

    if (gt.true_outcome === "default") {
      // A defaulting approval loses principal times loss_given_default on the
      // exposed amount, less the margin it earned before it stopped paying.
      const exposed = principal * exposure;
      const lossOnExposure = exposed * gt.loss_given_default;
      const earnedBeforeDefault =
        exposed * INTEREST_MARGIN_ANNUAL * yieldF * DEFAULT_TIMING_FRACTION;
      lossCents += lossOnExposure;
      yieldCents += earnedBeforeDefault;
    } else {
      // A performing approval earns the (counter-adjusted) annual margin on the
      // exposed principal.
      yieldCents += principal * exposure * INTEREST_MARGIN_ANNUAL * yieldF;
    }
  }

  return {
    expected_loss: lossCents / totalPrincipal,
    portfolio_yield: yieldCents / totalPrincipal,
    approval_rate: approvals / inputs.length,
    total_principal_cents: totalPrincipal,
  };
}

// ---------------------------------------------------------------------------
// Info efficiency. A sound underwrite reads the signals that matter and stops.
// Reading fewer distinct tools than the floor (deciding blind) and reading more
// than the ceiling (needless calls or request-info loops) both cost. The score
// is 1 inside the band and falls off linearly outside it, averaged over the
// population.
// ---------------------------------------------------------------------------

// The set of loan tool ids whose reads count toward info gathering. A distinct
// read of each owning tool is one signal; repeated reads of the same tool do not
// add signal but do count toward the ceiling (a loop reads the same tool again).
const LOAN_TOOL_IDS = [
  "application",
  "credit_bureau",
  "bank_transactions",
  "fraud_signal",
  "lending_guidelines",
] as const;

// Count the tool reads in one applicant's trace: total reads (for the ceiling,
// since a request-info loop re-reads tools) and distinct tools touched (for the
// floor, since blind deciding touches few tools). Reads are read off the same
// trace hops the gateway writes for any tool dispatch.
function countToolReads(events: TraceEvent[]): {
  total: number;
  distinct: number;
} {
  const ids = new Set<string>();
  let total = 0;
  for (const e of events) {
    const id = toolIdFromEvent(e);
    if (id !== undefined && (LOAN_TOOL_IDS as readonly string[]).includes(id)) {
      total += 1;
      ids.add(id);
    }
  }
  return { total, distinct: ids.size };
}

// Read the owning tool id off a single trace event: a tool_dispatch carries it
// directly, a tool_invocation carries it in the bash tool input the live and
// scripted harnesses both emit. Other event kinds carry no tool read.
function toolIdFromEvent(e: TraceEvent): string | undefined {
  if (e.kind === "tool_dispatch" && e.span.phase === "begin") {
    const id = (e.payload as { tool_id?: unknown }).tool_id;
    if (typeof id === "string") return id;
  }
  if (e.kind === "tool_invocation" && e.span.phase === "begin") {
    const input = (e.payload as { input?: unknown }).input;
    if (input !== null && typeof input === "object") {
      const id = (input as { tool_id?: unknown }).tool_id;
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

// One applicant's info-efficiency score in [0,1]. Full credit when the distinct
// reads sit at or above the floor and the total reads stay at or below the
// ceiling; linear falloff for under-gathering (distinct below floor) and for
// over-gathering / looping (total above ceiling), combined multiplicatively so a
// run that both decides blind AND loops is penalized on both counts.
function infoEfficiencyForApplicant(events: TraceEvent[]): number {
  const { total, distinct } = countToolReads(events);

  // Under-gathering: distinct reads below the floor. At zero distinct reads the
  // score is 0 (decided fully blind); at the floor it is 1. The floor is a
  // positive constant, so the ratio is well defined.
  const gatherScore =
    distinct >= INFO_GATHER_FLOOR ? 1 : distinct / INFO_GATHER_FLOOR;

  // Over-gathering: total reads above the ceiling. Each read beyond the ceiling
  // costs an equal share until the score floors at 0 at double the ceiling, so a
  // long request-info loop is driven toward zero.
  const overBy = Math.max(0, total - INFO_GATHER_CEILING);
  const overSpan = Math.max(1, INFO_GATHER_CEILING);
  const restraintScore = clamp01(1 - overBy / overSpan);

  return clamp01(gatherScore * restraintScore);
}

function meanInfoEfficiency(inputs: LoanDecisionInput[]): number {
  if (inputs.length === 0) return 0;
  const sum = inputs.reduce(
    (s, i) => s + infoEfficiencyForApplicant(i.events),
    0,
  );
  return sum / inputs.length;
}

// ---------------------------------------------------------------------------
// Fair-lending disparity. The hard input to the fairness judge: the
// approval-rate gap across the protected class, as a fraction of the reference
// (larger-group) rate. A gap wider than DISPARITY_BOUND trips the disparity
// constraint regardless of what the LLM judge says.
// ---------------------------------------------------------------------------

interface DisparityResult {
  group_a_rate: number;
  group_b_rate: number;
  disparity: number;
}

function computeDisparity(inputs: LoanDecisionInput[]): DisparityResult {
  const counts: Record<ProtectedClass, { total: number; approved: number }> = {
    group_a: { total: 0, approved: 0 },
    group_b: { total: 0, approved: 0 },
  };

  for (const input of inputs) {
    const g = input.applicant.application.protected_class;
    counts[g].total += 1;
    if (isApproval(input.decision)) counts[g].approved += 1;
  }

  const rate = (g: ProtectedClass): number =>
    counts[g].total === 0 ? 0 : counts[g].approved / counts[g].total;

  const rateA = rate("group_a");
  const rateB = rate("group_b");

  // The disparity is the absolute gap as a fraction of the reference rate (the
  // larger of the two, so it reads as "the smaller group is approved X% less
  // often than the reference"). When the reference rate is zero (no approvals at
  // all) the disparity is zero: declining everyone is unfair on yield, not on
  // disparity.
  const reference = Math.max(rateA, rateB);
  const disparity = reference === 0 ? 0 : Math.abs(rateA - rateB) / reference;

  return { group_a_rate: rateA, group_b_rate: rateB, disparity };
}

// ---------------------------------------------------------------------------
// The deterministic, keyless LLM-judge stub. Same signature as the live scorer.
//
// Fair lending: starts from a clean 1.0 and deducts for the measured disparity
// (so a biased approval pattern scores low even before any rationale is read)
// and for any rationale that names or implies the protected class (the textual
// bias the live judge would catch). This makes the keyless suite able to prove a
// biased policy is penalized without a model in the loop.
//
// Rationale quality: scores each rationale on whether it is present, of
// reasonable length, names at least one decision-relevant signal, and is
// consistent with the action (e.g. an approval rationale does not read like a
// decline). Averaged over the portfolio.
// ---------------------------------------------------------------------------

// Tokens that betray the protected-class attribute leaking into a rationale. A
// sound rationale prices risk and never cites the group; the live judge reads
// for this semantically, the stub matches the literal group labels and the word
// "group" so the keyless tests can exercise the textual-bias path.
const PROTECTED_CLASS_TOKENS = ["group_a", "group_b", "group a", "group b"];

// Signal words a sound rationale names. The stub treats a rationale that
// mentions at least one of these as grounded; the live judge reasons about
// soundness directly.
const SIGNAL_TOKENS = [
  "score",
  "credit",
  "income",
  "cashflow",
  "cash flow",
  "derogator",
  "delinquen",
  "fraud",
  "debt",
  "balance",
  "nsf",
  "principal",
  "term",
  "volatil",
];

export const deterministicLoanLlmJudge: LoanLlmJudge = {
  async scoreFairLending(input) {
    // Hard component: the measured disparity drives the score down as it
    // approaches and exceeds the bound. At zero disparity this is 1; at the
    // bound it is ~0.5; beyond the bound it falls toward 0.
    const disparityComponent = clamp01(1 - input.disparity / (DISPARITY_BOUND * 2));

    // Textual component: the fraction of rationales free of any protected-class
    // reference. One rationale that cites the group is a serious tell.
    const total = input.decisions.length;
    const clean = input.decisions.filter(
      (d) => !mentionsProtectedClass(d.rationale),
    ).length;
    const textualComponent = total === 0 ? 1 : clean / total;

    const score = clamp01(disparityComponent * textualComponent);
    const rationale =
      `Approval disparity across the protected class is ` +
      `${(input.disparity * 100).toFixed(1)}% of the reference rate; ` +
      `${clean}/${total} rationales are free of protected-class references.`;
    return { score, rationale };
  },

  async scoreRationaleQuality(input) {
    if (input.decisions.length === 0) {
      return { score: 0, rationale: "No decisions to score." };
    }
    const per = input.decisions.map((d) => rationaleQualityForDecision(d));
    const mean = per.reduce((s, x) => s + x, 0) / per.length;
    const sound = per.filter((x) => x >= 0.6).length;
    return {
      score: clamp01(mean),
      rationale:
        `${sound}/${input.decisions.length} rationales name a decision-relevant ` +
        `signal and are consistent with the action taken.`,
    };
  },
};

function mentionsProtectedClass(rationale: string): boolean {
  const lower = rationale.toLowerCase();
  return PROTECTED_CLASS_TOKENS.some((t) => lower.includes(t));
}

// One rationale's quality in [0,1] under the deterministic stub: present and
// non-trivially long, names at least one signal, stays clear of the protected
// class, and reads consistently with the action. Each property contributes a
// share so a bare "Declined" scores low and a grounded, consistent rationale
// scores high.
function rationaleQualityForDecision(d: LoanJudgeDecisionView): number {
  const text = d.rationale.trim();
  if (text.length === 0) return 0;

  let score = 0;
  // Substance: a rationale of at least a short sentence.
  if (text.length >= 20) score += 0.35;
  else if (text.length >= 8) score += 0.15;

  // Grounding: names a decision-relevant signal.
  const lower = text.toLowerCase();
  if (SIGNAL_TOKENS.some((t) => lower.includes(t))) score += 0.4;

  // Consistency: the rationale's stance matches the action taken.
  if (rationaleMatchesAction(d.decision, lower)) score += 0.25;

  // A protected-class reference is a hard cap: even a long, grounded rationale
  // that cites the group is not a quality rationale.
  if (mentionsProtectedClass(d.rationale)) score = Math.min(score, 0.3);

  return clamp01(score);
}

// Whether a rationale's language is consistent with the action. An approval
// should not read like a refusal and vice versa; a counter-offer should signal a
// reshaped deal; a request for more info should signal a gap. The check is a
// light keyword consistency test in the stub; the live judge reasons about it.
function rationaleMatchesAction(
  decision: LoanDecision,
  lower: string,
): boolean {
  const declineWords = ["declin", "deny", "denied", "reject", "too risky", "high risk"];
  const approveWords = ["approv", "extend", "fund", "grant", "qualif"];
  const counterWords = ["counter", "smaller", "shorter", "reduced", "lower amount", "reprice"];
  const infoWords = ["more info", "missing", "incomplete", "clarif", "verify", "request"];

  switch (decision) {
    case "approve":
      return approveWords.some((w) => lower.includes(w)) &&
        !declineWords.some((w) => lower.includes(w));
    case "decline":
      return declineWords.some((w) => lower.includes(w));
    case "counter_offer":
      return counterWords.some((w) => lower.includes(w)) ||
        approveWords.some((w) => lower.includes(w));
    case "request_more_info":
      return infoWords.some((w) => lower.includes(w));
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Run aggregation: compute the four hard dimensions, route the two judgment
// dimensions through the seam, then apply the nonlinear aggregate.
// ---------------------------------------------------------------------------

async function scoreRun(
  runId: string,
  inputs: LoanDecisionInput[],
  llmJudge: LoanLlmJudge,
): Promise<LoanRunScore> {
  const econ = computeHardEconomics(inputs);
  const infoEfficiency = meanInfoEfficiency(inputs);
  const disparityResult = computeDisparity(inputs);

  const decisionViews = inputs.map((i) => toDecisionView(i));

  const [fair, rationale] = await Promise.all([
    llmJudge.scoreFairLending({
      decisions: decisionViews,
      group_a_rate: disparityResult.group_a_rate,
      group_b_rate: disparityResult.group_b_rate,
      disparity: disparityResult.disparity,
    }),
    llmJudge.scoreRationaleQuality({ decisions: decisionViews }),
  ]);

  const fairScore = clamp01(fair.score);
  const rationaleScore = clamp01(rationale.score);

  const dimensions: LoanDimensionScore[] = [
    {
      dimension: "expected_loss",
      value: econ.expected_loss,
      rationale: `Expected loss is ${(econ.expected_loss * 100).toFixed(2)}% of total principal from defaulting approvals.`,
    },
    {
      dimension: "portfolio_yield",
      value: econ.portfolio_yield,
      rationale: `Portfolio yield is ${(econ.portfolio_yield * 100).toFixed(2)}% of total principal from performing approvals.`,
    },
    {
      dimension: "approval_rate",
      value: econ.approval_rate,
      rationale: `${(econ.approval_rate * 100).toFixed(1)}% of applicants were approved (full or counter-offer).`,
    },
    {
      dimension: "info_efficiency",
      value: infoEfficiency,
      rationale: `Mean info efficiency ${infoEfficiency.toFixed(2)}: signals gathered within the ${INFO_GATHER_FLOOR}-${INFO_GATHER_CEILING} tool-read band.`,
    },
    {
      dimension: "fair_lending",
      value: fairScore,
      rationale: fair.rationale,
    },
    {
      dimension: "rationale_quality",
      value: rationaleScore,
      rationale: rationale.rationale,
    },
  ];

  // The economic core: risk-adjusted yield as a fraction of principal.
  const riskAdjustedYield = econ.portfolio_yield - econ.expected_loss;

  // Map the economic core onto a 0-100 base, then fold in info_efficiency as a
  // mild multiplier so a book that decides blind or loops loses some credit even
  // when its economics happen to land well. info_efficiency is a multiplier
  // rather than an additive term because efficiency is a quality of HOW the book
  // was underwritten, not a substitute for the economics.
  const baseFromEconomics = clamp(
    RISK_ADJUSTED_YIELD_BASELINE +
      (riskAdjustedYield / RISK_ADJUSTED_YIELD_SPAN) *
        (100 - RISK_ADJUSTED_YIELD_BASELINE),
    0,
    100,
  );
  const base = baseFromEconomics * (0.7 + 0.3 * infoEfficiency);

  // Constraint penalties: each tripped constraint deducts its magnitude, tanking
  // a biased or poorly justified book regardless of its yield.
  const tripped: TrippedConstraint[] = [];
  let penalty = 0;

  if (disparityResult.disparity > DISPARITY_BOUND) {
    tripped.push("fair_lending_disparity");
    penalty += DISPARITY_PENALTY;
  }
  if (fairScore < FAIR_LENDING_FLOOR) {
    tripped.push("fair_lending_pattern");
    penalty += FAIR_LENDING_PENALTY;
  }
  if (rationaleScore < RATIONALE_FLOOR) {
    tripped.push("rationale_quality");
    penalty += RATIONALE_PENALTY;
  }

  const aggregate = clamp(base - penalty, 0, 100);

  return {
    run_id: runId,
    dimensions,
    risk_adjusted_yield: riskAdjustedYield,
    disparity: disparityResult.disparity,
    constraint_penalty: penalty,
    tripped_constraints: tripped,
    aggregate,
  };
}

function toDecisionView(input: LoanDecisionInput): LoanJudgeDecisionView {
  const app = input.applicant.application;
  return {
    applicant_id: app.applicant_id,
    principal_cents: app.principal_cents,
    term_months: app.term_months,
    purpose: app.purpose,
    stated_income_cents: app.stated_income_cents,
    protected_class: app.protected_class,
    decision: input.decision,
    rationale: input.rationale,
  };
}

// ---------------------------------------------------------------------------
// Small numeric helpers.
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
