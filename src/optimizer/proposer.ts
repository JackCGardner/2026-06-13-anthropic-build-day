// The edit proposer: the half of the optimizer that generates candidate spec
// edits from judge feedback. It is deliberately NOT handed the answer. It reads
// the run's per-fixture failure tags and the trace facts (what the harness did
// and did not look up) and proposes a SET of candidate structured specs per
// round. The other half of the optimizer, the keep-if-better selection rule,
// decides which of those candidates survive by re-running and re-judging; the
// proposer never decides that itself.
//
// Two implementations sit behind one seam:
//   - the deterministic reference proposer (keyless): maps each observed failure
//     mode to the matching gate, and also emits plausible-but-wrong candidates
//     (an over-broad block-all ceiling) so that selection, not authorship, is
//     what rejects an over-broad edit.
//   - the LLM proposer (Opus, gated on a credential): asks a model to propose
//     edits across the full surface. It is not needed for the keyless loop and
//     throws without a key rather than touching the network.
//
// Both return candidate StructuredHarnessSpec values validated against the
// frozen schema, so a malformed proposal fails loudly before it is ever run.

import type { FailureTag, RunScore, TraceEvent } from "@/engine";
import {
  loadStructuredSpec,
  type Gate,
  type StructuredHarnessSpec,
} from "@/harness/structured-spec.js";

// One proposed edit: a candidate spec plus a short, human-readable label of the
// change it makes, recorded in the trajectory so the report can explain why each
// candidate was tried. The label is descriptive only; it carries no selection
// authority.
export interface CandidateEdit {
  // The candidate spec the optimizer will run and judge.
  spec: StructuredHarnessSpec;
  // A short description of the edit relative to the parent spec, for the report.
  label: string;
  // Whether the proposer expects this to be a tightening that helps (true) or a
  // deliberately plausible-but-wrong probe (false). Recorded for the report; the
  // keep-if-better rule ignores it and judges on Trust + technical pass alone.
  expected_helpful: boolean;
}

// The proposer seam. Given the current spec, the judge's run score over the
// train split, and the per-fixture traces, return the candidate edits to try
// this round. An empty array signals the proposer has nothing more to suggest.
export interface EditProposer {
  id: string;
  propose(
    spec: StructuredHarnessSpec,
    runScore: RunScore,
    traces: TraceEvent[][],
  ): Promise<CandidateEdit[]>;
}

// ---------------------------------------------------------------------------
// The deterministic reference proposer.
//
// It reads the run's failure tags and proposes the gate that closes each one.
// The mapping is from failure mode to a remedy, never to a fixture's answer: a
// MISSED_FRAUD_CHECK tag yields a chargeback gate, a serial-refunder gate, or
// both, because either is a plausible cause of that tag, and the keep-if-better
// rule sorts out which actually helps. It also always emits an over-broad
// block-all candidate so the loop has to reject one.
// ---------------------------------------------------------------------------

// The gate each failure tag could be closed by. A tag may map to more than one
// candidate gate: the proposer offers all of them and lets selection choose.
const GATES_FOR_TAG: Record<FailureTag, Gate[]> = {
  MISSED_FRAUD_CHECK: [
    {
      id: "no_chargeback_autorefund",
      requires_lookup: "orders",
      check: "not_chargeback",
      on_fail: "escalate",
    },
    {
      id: "serial_refunder_review",
      requires_lookup: "customers",
      check: "refund_count_lt_3",
      on_fail: "escalate",
    },
  ],
  NEVER_CHECKED_CUSTOMER: [
    {
      id: "serial_refunder_review",
      requires_lookup: "customers",
      check: "refund_count_lt_3",
      on_fail: "escalate",
    },
  ],
  REFUNDED_OUT_OF_WINDOW: [
    {
      id: "within_refund_window",
      requires_lookup: "orders",
      check: "within_window",
      on_fail: "block",
    },
  ],
  WRONG_PAYMENT_METHOD: [
    {
      id: "original_payment_method_only",
      requires_lookup: "orders",
      check: "original_method",
      on_fail: "block",
    },
  ],
  SKIPPED_MANAGER_APPROVAL: [
    {
      id: "manager_approval_threshold",
      requires_lookup: "orders",
      check: "amount_le_500_or_escalate",
      on_fail: "escalate",
    },
  ],
};

// Collect the distinct failure tags the judge emitted across the run, in a
// stable order so the proposed candidate set is deterministic.
function observedTags(runScore: RunScore): FailureTag[] {
  const seen = new Set<FailureTag>();
  for (const v of runScore.fixture_verdicts) {
    for (const tag of v.failure_tags) seen.add(tag);
  }
  return [...seen];
}

// A spec extended with one more gate, deduplicated by gate id, with a fresh
// version label so generations do not collide with the pinned artifacts.
function withGate(
  spec: StructuredHarnessSpec,
  gate: Gate,
  generation: number,
): StructuredHarnessSpec {
  const already = spec.policy_gates.some((g) => g.id === gate.id);
  const gates = already ? spec.policy_gates : [...spec.policy_gates, gate];
  return loadStructuredSpec({
    ...spec,
    version: `${spec.version}-gen${generation}+${gate.id}`,
    policy_gates: gates,
    // Reflect the added rail in the procedure so the spec stays self-describing.
    procedure: already
      ? spec.procedure
      : [...spec.procedure, procedureLineForGate(gate)],
  });
}

// A spec extended with several gates at once, deduplicated by id, with a fresh
// version label. The incremental single-gate candidates explore one rule at a
// time; this bundles every gate the open failure tags imply into one candidate,
// because closing two interacting failure modes can require both gates together
// (reading the order without also blocking a wrong-method refund overshoots the
// charge and errors). Selection still decides whether the bundle is kept.
function withGates(
  spec: StructuredHarnessSpec,
  gates: Gate[],
  generation: number,
): StructuredHarnessSpec {
  let next = spec.policy_gates;
  const lines: string[] = [];
  for (const gate of gates) {
    if (next.some((g) => g.id === gate.id)) continue;
    next = [...next, gate];
    lines.push(procedureLineForGate(gate));
  }
  return loadStructuredSpec({
    ...spec,
    version: `${spec.version}-gen${generation}+bundle`,
    policy_gates: next,
    procedure: [...spec.procedure, ...lines],
  });
}

// The over-broad probe: keep the current gates but add a one-cent refund ceiling
// that escalates everything, including the legitimate refund. It keeps money
// safe yet mishandles the good case, so its held-out-relevant Trust is strictly
// lower than a clean tightening. The loop must reject it on Trust even though
// Cash Burned stays at zero.
function overBroadProbe(
  spec: StructuredHarnessSpec,
  generation: number,
): StructuredHarnessSpec {
  return loadStructuredSpec({
    ...spec,
    version: `${spec.version}-gen${generation}+blockall`,
    tool_rules: { max_refund_amount_cents: 1 },
    procedure: [...spec.procedure, "Escalate any refund above a trivially small amount."],
  });
}

function procedureLineForGate(gate: Gate): string {
  switch (gate.check) {
    case "not_chargeback":
      return "Look up the order and escalate any chargeback-flagged refund.";
    case "refund_count_lt_3":
      return "Look up the customer and escalate serial refunders.";
    case "within_window":
      return "Look up the order and block refunds outside the refund window.";
    case "original_method":
      return "Block refunds requested to a card other than the original method.";
    case "amount_le_500_or_escalate":
      return "Escalate refunds above the manager-approval threshold.";
  }
}

// Build the deterministic reference proposer. It proposes, per round:
//   - for each observed failure tag, a candidate that adds the matching gate
//     (one candidate per distinct gate the tags imply);
//   - one over-broad block-all probe.
// The candidate set is regenerated each round from the current run score, so as
// gates are kept and tags disappear the proposer naturally converges and finally
// returns nothing, which is the loop's plateau signal.
export function createDeterministicProposer(): EditProposer {
  let generation = 0;
  return {
    id: "deterministic-reference",
    async propose(spec, runScore) {
      generation += 1;
      const candidates: CandidateEdit[] = [];

      // One additive-gate candidate per distinct gate implied by the open tags,
      // skipping gates the spec already carries.
      const proposedGateIds = new Set<string>();
      const impliedGates: Gate[] = [];
      for (const tag of observedTags(runScore)) {
        for (const gate of GATES_FOR_TAG[tag]) {
          if (spec.policy_gates.some((g) => g.id === gate.id)) continue;
          if (proposedGateIds.has(gate.id)) continue;
          proposedGateIds.add(gate.id);
          impliedGates.push(gate);
          candidates.push({
            spec: withGate(spec, gate, generation),
            label: `add gate ${gate.id} (from ${tag})`,
            expected_helpful: true,
          });
        }
      }

      // A bundle candidate that adds every implied gate at once. Some gates only
      // hold technical pass when introduced together, so the bundle is the
      // candidate that converges when single-gate steps stall.
      if (impliedGates.length > 1) {
        candidates.push({
          spec: withGates(spec, impliedGates, generation),
          label: `add all ${impliedGates.length} implied gates together`,
          expected_helpful: true,
        });
      }

      // Always offer one deliberately over-broad probe so selection has to
      // reject it. Only meaningful while the spec still pays the legit case;
      // once a ceiling is in place adding another is a no-op, so skip then.
      if (spec.tool_rules?.max_refund_amount_cents === undefined) {
        candidates.push({
          spec: overBroadProbe(spec, generation),
          label: "add blanket 1c refund ceiling (escalate everything)",
          expected_helpful: false,
        });
      }

      return candidates;
    },
  };
}
