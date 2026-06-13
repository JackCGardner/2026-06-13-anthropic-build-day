// The dossier: the one load-bearing artifact, with two clearly separated
// regions. The mechanical contract (operations, enforcedInvariants) drives
// both the harness's view and the synthetic agent's enforcement. The intent
// layer (businessRulesNotEnforced) drives only the business evaluation and is
// never loaded into the kernel's enforcement path. That split is the trap, in
// data form: the synthetic enforces exactly what the real API enforces and
// stays silent on the business rules, exactly as the real service does.

import { z } from "zod";

// What the API does on a violation it mechanically refuses.
export const OnViolationSchema = z.object({
  http: z.number(),
  code: z.string().optional(),
});
export type OnViolation = z.infer<typeof OnViolationSchema>;

// An invariant the real API mechanically refuses. The kernel enforces THESE.
export const EnforcedInvariantSchema = z.object({
  id: z.string(),
  on_violation: OnViolationSchema,
  // Optional human-readable rule, e.g. "amount <= original - already_refunded".
  rule: z.string().optional(),
});
export type EnforcedInvariant = z.infer<typeof EnforcedInvariantSchema>;

// A business rule the API returns 200 on anyway. The trap. Never loaded into
// the kernel; fed to the harness instructions (by its absence) and to the
// Judge's ground truth. Confidence is low because asserting a negative from
// docs is inherently weak; each entry passes a human-review gate before commit.
export const BusinessRuleNotEnforcedSchema = z.object({
  id: z.string(),
  intent: z.string(),
  // Where the ground-truth signal lives, e.g. "orders.purchase_date".
  ground_truth_signal: z.string(),
  // The tag the Judge emits when this rule is violated.
  failure_tag: z.string(),
  confidence: z.number().min(0).max(1),
});
export type BusinessRuleNotEnforced = z.infer<
  typeof BusinessRuleNotEnforcedSchema
>;

// One operation on a tool, with its mechanical contract and both rule regions.
export const ToolOperationSchema = z.object({
  op_id: z.string(),
  http: z.object({ method: z.string(), path: z.string() }),
  request_schema: z.unknown().optional(),
  response_schema: z.unknown().optional(),
  enforced_invariants: z.array(EnforcedInvariantSchema),
  business_rules_not_enforced: z.array(BusinessRuleNotEnforcedSchema),
});
export type ToolOperation = z.infer<typeof ToolOperationSchema>;

// The hidden-state schema and seed reference a tool's kernel reads and writes.
export const HiddenStateSchema = z.object({
  // Field name -> a human-readable type description, for documentation only.
  schema: z.record(z.string(), z.string()),
  // Reference to the seed fixture that initializes this tool's slice.
  seed_ref: z.string().optional(),
});
export type HiddenState = z.infer<typeof HiddenStateSchema>;

// One dossier per committed tool. Both the harness view and the kernel's
// enforcement are generated from this single artifact so they cannot drift.
export const ToolDossierSchema = z.object({
  tool_id: z.string(),
  capability_bindings: z.array(z.string()),
  intent: z.string(),
  base_url: z.string(),
  operations: z.array(ToolOperationSchema),
  hidden_state: HiddenStateSchema,
});
export type ToolDossier = z.infer<typeof ToolDossierSchema>;
