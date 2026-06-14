// Derive a loan applicant's terminal decision from the trace the run produced.
// The loan live harness drives the world through named read tools and records its
// terminal action through submit_decision, which writes a single state_mutation
// on the applicant's "decision:<id>" key carrying the action and the rationale.
// This module is the single owner of reading that fact back off the trace, the
// loan analog of deriveTerminalDecision for the refund pack: the decision is a
// property of what the run recorded, not asserted by the agent's prose.
//
// A run that never submitted a decision (the agent errored or ran past the turn
// cap before deciding) yields a deterministic safe fallback: decline with an
// empty rationale. Declining is the conservative non-action, and the empty
// rationale lets the judge's rationale-quality dimension see and penalize the
// missing justification, so an agent that fails to decide is scored honestly
// rather than credited.

import type { TraceEvent } from "./contracts/trace.js";
import {
  LoanDecisionSchema,
  type LoanDecision,
} from "@/scenarios/loan/schema.js";
import { LOAN_DECISION_KEY_PREFIX } from "@/harness/loan/loan-function-tools.js";

// The terminal action plus the rationale the agent wrote for one applicant.
export interface LoanTerminalDecision {
  decision: LoanDecision;
  rationale: string;
}

// The conservative fallback for a run that recorded no decision: decline with no
// rationale, so a failure to decide neither approves blindly nor escapes the
// rationale-quality penalty.
const NO_DECISION_FALLBACK: LoanTerminalDecision = {
  decision: "decline",
  rationale: "",
};

// Read the terminal decision for one applicant off its trace slice. The last
// decision state_mutation wins, so a re-submitted decision (an agent that
// corrected itself) resolves to its final action. Returns the safe fallback when
// no valid decision was recorded.
export function deriveLoanTerminalDecision(
  applicantId: string,
  events: TraceEvent[],
): LoanTerminalDecision {
  const key = `${LOAN_DECISION_KEY_PREFIX}:${applicantId}`;
  let found: LoanTerminalDecision | undefined;

  for (const e of events) {
    if (e.kind !== "state_mutation") continue;
    const p = e.payload as { key?: unknown; after?: unknown };
    if (p.key !== key) continue;
    const parsed = parseDecisionAfter(p.after);
    if (parsed !== undefined) found = parsed;
  }

  return found ?? NO_DECISION_FALLBACK;
}

// Parse the `after` payload of a decision state_mutation into a typed decision.
// The action is validated against the loan decision enum; an unrecognized action
// or a missing rationale yields undefined so the caller falls back rather than
// trusting a malformed capture.
function parseDecisionAfter(after: unknown): LoanTerminalDecision | undefined {
  if (after === null || typeof after !== "object") return undefined;
  const obj = after as { decision?: unknown; rationale?: unknown };
  const decision = LoanDecisionSchema.safeParse(obj.decision);
  if (!decision.success) return undefined;
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  return { decision: decision.data, rationale };
}
