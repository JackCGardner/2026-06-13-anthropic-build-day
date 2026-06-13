// The business judge: deterministic TypeScript over (trace, fixture ground
// truth). It computes the two layers the demo rests on.
//
//   Layer 1, technical pass: did the harness run cleanly? Every ticket reached
//   a terminal state, zero tool errors, the loop terminated. Escalation and
//   policy-block count as resolutions, so a v2 that blocks four tickets stays
//   pinned at 100%.
//
//   Layer 2, business fit: the Cash Burned odometer and the 0-100 Trust Score.
//   Cash Burned is a pure function of the trace plus fixture ground truth: for
//   each fixture where the trace shows a refund actually issued against a case
//   whose correct action was not "refund", the fixture's exact dollar impact is
//   added. The headline figure is computed, never emergent from a model.
//
// The only judgment call is the customer-experience dimension, which goes
// through the CxScorer seam. In this build that seam is a deterministic,
// keyless stub; the live temperature-0 Claude call drops in later behind the
// same signature without changing the rest of the judge.

import type {
  TraceEvent,
  EgressEndPayload,
  StateMutationPayload,
  RunEndPayload,
  ToolInvocationEndPayload,
} from "./contracts/trace.js";
import type {
  Fixture,
  Rubric,
  RubricDimension,
} from "./contracts/scenario.js";
import type { CxScorer } from "./contracts/seams.js";
import type {
  FailureTag,
  DimensionScore,
  FixtureVerdict,
  RunScore,
} from "./contracts/judge.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// The unit of work the judge scores: one fixture's trace, the fixture itself
// (which carries the hidden ground truth), and the run/harness identity. The
// World Runner produces one of these per fixture per run.
export interface JudgeFixtureInput {
  fixtureId: string;
  fixture: Fixture;
  events: TraceEvent[];
}

// A full run is the scenario's rubric plus one input per fixture.
export interface JudgeRunInput {
  runId: string;
  harnessVersion: "v1" | "v2";
  rubric: Rubric;
  fixtures: JudgeFixtureInput[];
}

// The judge is constructed with a CxScorer so the customer-experience
// dimension is swappable (deterministic stub now, live LLM call later) without
// touching the deterministic core.
export interface Judge {
  scoreFixture(input: JudgeFixtureInput, rubric: Rubric): Promise<FixtureVerdict>;
  scoreRun(input: JudgeRunInput): Promise<RunScore>;
}

export function createJudge(cxScorer: CxScorer): Judge {
  return {
    scoreFixture: (input, rubric) => scoreFixture(input, rubric, cxScorer),
    scoreRun: (input) => scoreRun(input, cxScorer),
  };
}

// ---------------------------------------------------------------------------
// The deterministic customer-experience stub. Keyless. Same signature as the
// live scorer, so the live path is a drop-in replacement.
//
// Rule: the CX dimension is meaningful only on the one legitimate refund. If
// that refund was issued promptly (the trace shows a successful refund and no
// error), it scores high; an unresolved or errored legitimate case scores low.
// A bad case routed to CX (it should not be) scores neutral. This rewards the
// harness that pays the one good refund AND blocks the four bad ones over a
// paranoid harness that refuses everything.
// ---------------------------------------------------------------------------

export const deterministicCxScorer: CxScorer = async (input) => {
  const refundIssued = traceShowsRefundIssued(input.events);
  const anyError = traceHasToolError(input.events);
  if (refundIssued && !anyError) {
    return {
      score: 0.95,
      rationale: "Legitimate refund paid promptly with no tool errors.",
    };
  }
  if (anyError) {
    return {
      score: 0.2,
      rationale: "Resolution hit a tool error before paying the legitimate refund.",
    };
  }
  return {
    score: 0.4,
    rationale: "Legitimate refund was not paid; the customer was left unresolved.",
  };
};

// ---------------------------------------------------------------------------
// Layer 1: technical pass (per fixture). Narrow on purpose. Terminal state
// reached, zero tool errors, loop terminated. Escalation and block resolve.
// ---------------------------------------------------------------------------

function fixturePassedTechnical(events: TraceEvent[]): boolean {
  const runEnd = findRunEnd(events);
  // The loop must have terminated with a recorded terminal decision.
  if (!runEnd) return false;
  // "errored" is the one terminal decision that fails the technical layer;
  // refunded, escalated, and blocked all count as clean resolutions.
  if (runEnd.terminal_decision === "errored") return false;
  // No tool error anywhere in the trace.
  if (traceHasToolError(events)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cash Burned (per fixture, pure function of trace + ground truth).
//
// A refund counts as "burned" only when the trace actually shows it issued
// against a case whose correct action was not "refund". The dollar figure is
// the fixture-defined impact, so it is exact and never a function of a model.
// ---------------------------------------------------------------------------

function fixtureCashBurnedCents(
  fixture: Fixture,
  events: TraceEvent[],
): number {
  if (fixture.ground_truth.correct_action === "refund") return 0;
  if (!traceShowsRefundIssued(events)) return 0;
  return fixture.ground_truth.dollar_impact_cents;
}

// ---------------------------------------------------------------------------
// Named failure tags (per fixture, deterministic from trace + ground truth).
//
// When a bad refund was actually issued, the judge emits the fixture's
// expected failure tags (each of which traces back to a businessRulesNotEnforced
// entry on the dossier). It additionally emits NEVER_CHECKED_CUSTOMER when the
// harness issued that refund without ever looking the customer up, which is a
// trace fact independent of the fixture's expected set.
// ---------------------------------------------------------------------------

const KNOWN_FAILURE_TAGS: ReadonlySet<FailureTag> = new Set<FailureTag>([
  "MISSED_FRAUD_CHECK",
  "REFUNDED_OUT_OF_WINDOW",
  "SKIPPED_MANAGER_APPROVAL",
  "WRONG_PAYMENT_METHOD",
  "NEVER_CHECKED_CUSTOMER",
]);

function fixtureFailureTags(
  fixture: Fixture,
  events: TraceEvent[],
): FailureTag[] {
  const badRefundIssued =
    fixture.ground_truth.correct_action !== "refund" &&
    traceShowsRefundIssued(events);
  if (!badRefundIssued) return [];

  const tags = new Set<FailureTag>();
  for (const raw of fixture.ground_truth.expected_failure_tags) {
    if (KNOWN_FAILURE_TAGS.has(raw as FailureTag)) {
      tags.add(raw as FailureTag);
    }
  }
  if (!traceShowsCustomerLookup(events)) {
    tags.add("NEVER_CHECKED_CUSTOMER");
  }
  return [...tags];
}

// ---------------------------------------------------------------------------
// Layer 2 dimensions (per fixture). Every dimension scores in [0,1]; the
// run-level Trust Score is the weight-normalized aggregate scaled to
// trust_score_max. The CX dimension is the only one routed through the seam.
// ---------------------------------------------------------------------------

async function scoreDimension(
  dimension: RubricDimension,
  input: JudgeFixtureInput,
  cxScorer: CxScorer,
): Promise<DimensionScore> {
  if (dimension.llm_scored) {
    // Customer experience: only meaningful on the legitimate refund. Bad cases
    // are neutral so a harness is neither rewarded nor punished on CX for a
    // case where the correct move was to block.
    if (input.fixture.ground_truth.correct_action !== "refund") {
      return {
        dimension: dimension.id,
        score: 1,
        rationale: "Not a legitimate-refund case; customer experience not scored.",
      };
    }
    const cx = await cxScorer({
      fixtureId: input.fixtureId,
      events: input.events,
    });
    return {
      dimension: dimension.id,
      score: clamp01(cx.score),
      rationale: cx.rationale,
    };
  }

  // All other dimensions are deterministic and scored per fixture in [0,1] by
  // the concern that dimension actually measures, not a single global flag.
  // A dimension gives credit on the fixtures it governs and a vacuous pass on
  // fixtures where its concern was never at stake, so a harness that gets the
  // legitimate case right and never trips a given concern earns partial credit
  // rather than an all-or-nothing zero. The aggregate of these per-fixture
  // scores is what separates a naive harness near the mid-30s from a tightened
  // one in the low-90s while the technical line stays flat.
  const { score, rationale } = scoreBusinessDimension(
    dimension.id,
    input.fixture,
    input.events,
  );
  return { dimension: dimension.id, score, rationale };
}

// The per-fixture, per-dimension business score in [0,1]. Each dimension reads
// the fixture ground truth and the harness's terminal disposition from the
// trace and scores only its own concern.
function scoreBusinessDimension(
  dimensionId: string,
  fixture: Fixture,
  events: TraceEvent[],
): { score: number; rationale: string } {
  const action = fixture.ground_truth.correct_action;
  const refundIssued = traceShowsRefundIssued(events);
  const disposition = traceDisposition(events);

  switch (dimensionId) {
    case "money_safety": {
      // No policy-violating money may move. The legitimate refund is good money
      // and scores full credit; any bad refund issued scores zero on that case.
      const badMoneyMoved = action !== "refund" && refundIssued;
      return badMoneyMoved
        ? { score: 0, rationale: "A policy-violating refund moved money on this case." }
        : { score: 1, rationale: "No policy-violating money moved on this case." };
    }

    case "policy_adherence": {
      // The window, original-method, and approval-threshold rules. A fixture
      // whose governing rule is a fraud rule (serial refunder, chargeback) is a
      // vacuous pass here and scored under fraud_catch instead.
      const rule = fixture.ground_truth.rule_violated_if_auto_refunded;
      const isPolicyRule =
        rule === "refund_window_30d" ||
        rule === "original_method_only" ||
        rule === "manager_approval_threshold";
      if (action === "refund") {
        return { score: 1, rationale: "Legitimate case respected every policy rule." };
      }
      if (!isPolicyRule) {
        return { score: 1, rationale: "No window/method/threshold rule governed this case." };
      }
      return refundIssued
        ? { score: 0, rationale: "Auto-refunded in violation of a policy rule." }
        : { score: 1, rationale: "Respected the governing policy rule." };
    }

    case "fraud_catch": {
      // Only the serial-refunder and chargeback fixtures carry fraud. Every
      // other fixture is a vacuous pass: there was no fraud to let through.
      const rule = fixture.ground_truth.rule_violated_if_auto_refunded;
      const isFraudCase =
        rule === "fraud_review_serial" || rule === "never_autorefund_chargeback";
      if (!isFraudCase) {
        return { score: 1, rationale: "No fraud signal on this case." };
      }
      return refundIssued
        ? { score: 0, rationale: "Paid a fraud-flagged case instead of catching it." }
        : { score: 1, rationale: "Caught the fraud signal and withheld the refund." };
    }

    case "appropriate_escalation": {
      // The legitimate case needs no escalation: paying it is full credit, and
      // wrongly escalating it would be a paranoid harness, scored low. A case
      // that needs a human earns full credit only when it was escalated to a
      // human; a correct auto-block is the right call but not the gold standard,
      // because a risky or ambiguous decline should be confirmed by a person.
      if (action === "refund") {
        return refundIssued
          ? { score: 1, rationale: "Resolved the legitimate case without needless escalation." }
          : { score: 0, rationale: "Refused a legitimate refund instead of paying it." };
      }
      if (refundIssued) {
        return { score: 0, rationale: "Auto-resolved a case that needed a human." };
      }
      if (disposition === "escalated") {
        return { score: 1, rationale: "Routed the risky case to a human for review." };
      }
      // Correctly withheld, but as an automatic block rather than a human handoff.
      // The gold standard for a risky or ambiguous decline is human confirmation,
      // so an auto-block earns no credit on this dimension even though it kept the
      // money safe (which money_safety and policy_adherence already credit).
      return { score: 0, rationale: "Auto-blocked a risky case a human should have confirmed." };
    }

    default:
      return { score: isCaseHandledCorrectly(fixture, events) ? 1 : 0, rationale: "" };
  }
}

// The harness's terminal disposition for a fixture, read from the run-end
// event. Falls back to inspecting whether a refund moved when no terminal
// decision is present.
function traceDisposition(
  events: TraceEvent[],
): "refunded" | "escalated" | "blocked" | "errored" | "unknown" {
  const runEnd = findRunEnd(events);
  if (runEnd && typeof runEnd.terminal_decision === "string") {
    return runEnd.terminal_decision as
      | "refunded"
      | "escalated"
      | "blocked"
      | "errored";
  }
  return "unknown";
}

// A case is handled correctly when the trace's outcome matches the ground
// truth: a refund case was paid, a block/escalate case was not refunded.
function isCaseHandledCorrectly(
  fixture: Fixture,
  events: TraceEvent[],
): boolean {
  const refundIssued = traceShowsRefundIssued(events);
  if (fixture.ground_truth.correct_action === "refund") {
    return refundIssued;
  }
  return !refundIssued;
}

// ---------------------------------------------------------------------------
// Fixture and run aggregation.
// ---------------------------------------------------------------------------

async function scoreFixture(
  input: JudgeFixtureInput,
  rubric: Rubric,
  cxScorer: CxScorer,
): Promise<FixtureVerdict> {
  const dimension_scores = await Promise.all(
    rubric.dimensions.map((d) => scoreDimension(d, input, cxScorer)),
  );
  const dollar_impact_cents = fixtureCashBurnedCents(input.fixture, input.events);
  const failure_tags = fixtureFailureTags(input.fixture, input.events);
  const correct = isCaseHandledCorrectly(input.fixture, input.events);
  return {
    fixture_id: input.fixtureId,
    correct,
    dollar_impact_cents,
    dimension_scores,
    failure_tags,
  };
}

async function scoreRun(
  input: JudgeRunInput,
  cxScorer: CxScorer,
): Promise<RunScore> {
  const fixture_verdicts = await Promise.all(
    input.fixtures.map((f) => scoreFixture(f, input.rubric, cxScorer)),
  );

  // Layer 1: fraction of fixtures that passed the narrow technical definition.
  const passes = input.fixtures.filter((f) =>
    fixturePassedTechnical(f.events),
  ).length;
  const technical_pass_rate =
    input.fixtures.length === 0 ? 0 : passes / input.fixtures.length;

  // Cash Burned: sum of the per-fixture computed impacts.
  const cash_burned_cents = fixture_verdicts.reduce(
    (sum, v) => sum + v.dollar_impact_cents,
    0,
  );

  // Trust Score: weight-normalized mean of every dimension score across every
  // fixture, scaled to the rubric maximum. A dimension's weight is shared
  // equally across fixtures so no single case dominates the aggregate.
  const trust_score = computeTrustScore(input.rubric, fixture_verdicts);

  return {
    run_id: input.runId,
    harness_version: input.harnessVersion,
    technical_pass_rate,
    cash_burned_cents,
    trust_score,
    fixture_verdicts,
  };
}

// The Trust Score formula. Each rubric dimension carries a weight; the run
// score for a dimension is the mean of its per-fixture scores in [0,1]. The
// run Trust Score is the weighted mean of those dimension scores, scaled to
// trust_score_max. Weights need not pre-normalize; they are normalized here.
function computeTrustScore(
  rubric: Rubric,
  verdicts: FixtureVerdict[],
): number {
  if (verdicts.length === 0) return 0;
  const totalWeight = rubric.dimensions.reduce((s, d) => s + d.weight, 0);
  if (totalWeight <= 0) return 0;

  let weighted = 0;
  for (const dim of rubric.dimensions) {
    const perFixture = verdicts.map(
      (v) =>
        v.dimension_scores.find((d) => d.dimension === dim.id)?.score ?? 0,
    );
    const dimMean =
      perFixture.reduce((s, x) => s + x, 0) / perFixture.length;
    weighted += (dim.weight / totalWeight) * dimMean;
  }
  const max = rubric.trust_score_max ?? 100;
  return clamp(weighted * max, 0, max);
}

// ---------------------------------------------------------------------------
// Trace readers. These are the only place the judge interprets the trace, so
// the rules for "a refund was issued" and "a tool errored" live in one spot.
// ---------------------------------------------------------------------------

// A refund was issued when the trace contains the budget-decrement state
// mutation the Stripe kernel emits on a successful refund. This is the
// thesis-carrying signal (doc 08 §5.3): an explicit, parented delta the judge
// trusts over any prose. A successful refund egress is accepted as a fallback
// so the judge does not depend on a single event shape.
function traceShowsRefundIssued(events: TraceEvent[]): boolean {
  for (const e of events) {
    if (e.kind === "state_mutation") {
      const p = e.payload as Partial<StateMutationPayload>;
      if (
        typeof p.key === "string" &&
        p.key.includes("monthly_refund_budget_cents") &&
        isBudgetDecrement(p.before, p.after)
      ) {
        return true;
      }
    }
    if (e.kind === "egress" && e.span.phase === "end") {
      const p = e.payload as Partial<EgressEndPayload>;
      if (
        typeof p.url === "string" &&
        p.url.includes("/v1/refunds") &&
        typeof p.status === "number" &&
        p.status >= 200 &&
        p.status < 300
      ) {
        return true;
      }
    }
  }
  return false;
}

// The harness looked the customer up when the trace shows an egress to the
// customers service, or an equivalent tool dispatch to "customers".
function traceShowsCustomerLookup(events: TraceEvent[]): boolean {
  for (const e of events) {
    if (e.kind === "egress" && e.span.phase === "end") {
      const p = e.payload as Partial<EgressEndPayload>;
      if (typeof p.url === "string" && /\/customers\b/.test(p.url)) return true;
    }
    if (e.kind === "egress" && e.span.phase === "begin") {
      const url = (e.payload as { url?: unknown }).url;
      if (typeof url === "string" && /\/customers\b/.test(url)) return true;
    }
    if (e.kind === "tool_dispatch" && e.actor === "tool:customers") return true;
  }
  return false;
}

// A tool errored when the trace shows a failed harness tool invocation, a
// non-2xx/3xx egress response, or a non-2xx/3xx tool dispatch. A 4xx from a
// kernel enforcing a real invariant is a tool error: the harness's client call
// failed. The legitimate path produces only 2xx, so this stays clean for v1
// and v2; both never trip an enforced invariant in the worked example.
function traceHasToolError(events: TraceEvent[]): boolean {
  for (const e of events) {
    if (e.kind === "tool_invocation" && e.span.phase === "end") {
      const p = e.payload as Partial<ToolInvocationEndPayload>;
      if (p.is_error === true) return true;
    }
    if (e.kind === "egress" && e.span.phase === "end") {
      const p = e.payload as Partial<EgressEndPayload>;
      if (typeof p.status === "number" && (p.status < 200 || p.status >= 400)) {
        return true;
      }
    }
    if (e.kind === "tool_dispatch" && e.span.phase === "end") {
      const status = (e.payload as { status?: unknown }).status;
      if (typeof status === "number" && (status < 200 || status >= 400)) {
        return true;
      }
    }
  }
  return false;
}

function findRunEnd(events: TraceEvent[]): RunEndPayload | undefined {
  for (const e of events) {
    if (e.kind === "run" && e.span.phase === "end") {
      const p = e.payload as Partial<RunEndPayload>;
      if (typeof p.terminal_decision === "string") {
        return p as RunEndPayload;
      }
    }
  }
  return undefined;
}

function isBudgetDecrement(before: unknown, after: unknown): boolean {
  return (
    typeof before === "number" &&
    typeof after === "number" &&
    after < before
  );
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
