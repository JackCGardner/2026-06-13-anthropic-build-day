// The structured harness spec: the surface the optimizer edits. Where the pinned
// HarnessSpec is the public artifact a generated agent is handed (system prompt,
// tool manifest, prose procedure), the structured spec is the same agent reduced
// to the typed, checkable fields an optimizer can mutate and a deterministic
// interpreter can execute: the system prompt, the ordered procedure, a set of
// typed policy gates the harness applies before issuing a refund, and optional
// tool rules. Editing any of these changes the interpreter's behavior, which is
// exactly what makes the optimizer testable without a model in the loop.
//
// The pinned v1 spec is rule-silent and maps to ZERO gates: with no gate to stop
// it, the interpreter pays every refund, including the four traps, and burns the
// budget. The pinned v2 spec maps to the full gate set: each gate is a boolean
// check against a fact the harness must first look up, so the interpreter blocks
// or escalates the four traps and still pays the one legitimate refund. The gate
// set is the learnable surface: an optimizer adds, tightens, or removes gates and
// the keep-if-better rule selects on the resulting Trust Score.
//
// The structured spec is derived from a pinned HarnessSpec by a loader, so the
// existing pinned specs stay the source of truth and remain backward compatible:
// the structured form is a view over them, not a replacement.

import { z } from "zod";
import type { HarnessSpec } from "./specs/types.js";

// The data a gate must look up before it can be checked. A gate names the read it
// depends on so the interpreter performs exactly the lookups the active gates
// need and the trace records them; a harness with no gates performs no lookups,
// which is why the naive interpreter never reads the order, customer, or policy.
export const GateLookupSchema = z.enum(["orders", "customers", "policy"]);
export type GateLookup = z.infer<typeof GateLookupSchema>;

// The checkable predicate a gate applies. Each value names one business rule the
// brief never stated and the billing API never enforces, expressed as a boolean
// test against facts the harness fetched:
//   within_window            purchase is inside the refund window
//   original_method          the request is to the original payment method
//   not_chargeback           the order is not flagged for chargeback
//   refund_count_lt_3        the customer is under the serial-refunder threshold
//   amount_le_500_or_escalate the amount is within the manager-approval threshold
// A gate "passes" when its predicate holds; a failing gate fires its on_fail
// disposition. The interpreter evaluates gates in spec order and the first
// failing gate decides the case, so gate order is itself part of the spec.
export const GateCheckSchema = z.enum([
  "within_window",
  "original_method",
  "not_chargeback",
  "refund_count_lt_3",
  "amount_le_500_or_escalate",
]);
export type GateCheck = z.infer<typeof GateCheckSchema>;

// What the harness does when a gate fails. An escalate hands the case to a human
// (the gold standard for a risky or ambiguous decline); a block declines it
// outright. Both are clean resolutions that keep the technical-pass line flat.
export const GateOnFailSchema = z.enum(["escalate", "block"]);
export type GateOnFail = z.infer<typeof GateOnFailSchema>;

// One typed policy gate. `requires_lookup` is the read the gate's predicate needs;
// the interpreter performs it before evaluating the gate. `check` is the boolean
// predicate; `on_fail` is the disposition when it fails. `id` is a stable handle
// the optimizer and the trace can refer to.
export const GateSchema = z.object({
  id: z.string(),
  requires_lookup: GateLookupSchema,
  check: GateCheckSchema,
  on_fail: GateOnFailSchema,
});
export type Gate = z.infer<typeof GateSchema>;

// Optional tool rules: a flat, typed list of constraints on how the harness uses
// its tools, distinct from the policy gates that decide a case. The interpreter
// honors `max_refund_amount_cents` as a hard ceiling above which it escalates
// rather than pays, so an optimizer can express a blanket safety rail without
// authoring a full gate. Absent rules leave behavior unchanged.
export const ToolRulesSchema = z.object({
  // A hard ceiling on any single auto-issued refund, in cents. A request above
  // this is escalated rather than paid, regardless of the gate outcome.
  max_refund_amount_cents: z.number().int().positive().optional(),
});
export type ToolRules = z.infer<typeof ToolRulesSchema>;

// The structured harness spec the optimizer edits and the interpreter executes.
// `version` is a free-form label (e.g. "v1", "v2", "v3-gen1") so the optimizer can
// name candidate generations without colliding with the pinned v1/v2 artifacts.
export const StructuredHarnessSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  system_prompt: z.string(),
  procedure: z.array(z.string()),
  policy_gates: z.array(GateSchema),
  tool_rules: ToolRulesSchema.optional(),
});
export type StructuredHarnessSpec = z.infer<typeof StructuredHarnessSpecSchema>;

// The full gate set the tightened harness applies, in policy-evaluation order:
// chargeback and serial-refunder fraud first (escalate to a human), then the
// window and original-method policy rules (block), then the manager-approval
// threshold (escalate). This is the gate set the pinned v2 spec maps to, and the
// optimizer's target: an agent that closes every trap without blocking the legit
// case scores the full set; an over-broad set that also blocks the legit refund
// scores lower, so keep-if-better rejects it.
export const FULL_REFUND_GATE_SET: Gate[] = [
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
  {
    id: "within_refund_window",
    requires_lookup: "orders",
    check: "within_window",
    on_fail: "block",
  },
  {
    id: "original_payment_method_only",
    requires_lookup: "orders",
    check: "original_method",
    on_fail: "block",
  },
  {
    id: "manager_approval_threshold",
    requires_lookup: "orders",
    check: "amount_le_500_or_escalate",
    on_fail: "escalate",
  },
];

// Derive the structured spec from a pinned HarnessSpec. The system prompt and
// procedure carry over verbatim; the gate set is the one piece the pinned version
// determines: v1 is rule-silent and maps to zero gates (pay everything), v2 maps
// to the full gate set (catch every trap, pay the legit case). This keeps the
// pinned specs the source of truth and the structured form a faithful view.
export function toStructuredSpec(spec: HarnessSpec): StructuredHarnessSpec {
  return {
    id: spec.id,
    version: spec.version,
    system_prompt: spec.system_prompt,
    procedure: [...spec.procedure],
    policy_gates: spec.version === "v2" ? [...FULL_REFUND_GATE_SET] : [],
  };
}

// Validate a candidate structured spec against the frozen schema and return the
// typed value. Throws on any schema violation, so a malformed optimizer proposal
// fails loudly at load time rather than silently in the interpreter.
export function loadStructuredSpec(candidate: unknown): StructuredHarnessSpec {
  return StructuredHarnessSpecSchema.parse(candidate);
}
