// The pinned harness spec: the public surface a generated agent is handed for
// the refund brief. The spec is deliberately rule-silent. It describes the
// tools the harness can call, the procedure it should follow, and the success
// criterion it is graded on, and nothing else. The business rules the brief
// never states (the 30-day window, original-method-only, manager approval,
// serial-refunder fraud review, chargeback handling) never appear here. A naive
// v1 spec leaves them out entirely; a tightened v2 spec adds the pre-screen
// steps and the escalation branches without ever naming the underlying rules as
// enforced invariants, because the billing API does not enforce them.
//
// The spec is generated from the public surface of the dossiers only: every
// tool entry's `from` points at a dossier tool_id, and the manifest is built
// from dossier intent and operations. The hidden intent layer
// (business_rules_not_enforced) is never read into a spec, which is exactly
// what the consistency gates assert.

import { z } from "zod";

// One tool the harness may call, described from the public surface of its
// dossier. `from` binds the manifest entry to the dossier it was generated
// from so the consistency gate can prove every entry resolves to a real tool.
// `description` is public prose only: it may state what the tool does
// mechanically, never a business rule the API leaves unenforced.
export const ToolManifestEntrySchema = z.object({
  // The name the harness invokes, e.g. "issue_refund".
  name: z.string(),
  // The dossier tool_id this capability is generated from, e.g.
  // "stripe_payments". The gate asserts this resolves against the pack.
  from: z.string(),
  // The operation id on that dossier the entry exposes, e.g. "create_refund".
  op_id: z.string(),
  // Public-surface description: mechanical behavior only, no hidden rule text.
  description: z.string(),
});
export type ToolManifestEntry = z.infer<typeof ToolManifestEntrySchema>;

// An enforced invariant surfaced to the harness as a hard constraint it cannot
// violate. These are the constraints the real API mechanically refuses, so
// telling the harness about them is faithful: amount cannot exceed remaining.
// Business rules the API does not enforce never appear in this list.
export const SpecEnforcedConstraintSchema = z.object({
  // The dossier enforced-invariant id this surfaces, e.g. "amount_within_remaining".
  id: z.string(),
  // The tool the constraint belongs to, e.g. "issue_refund".
  tool: z.string(),
  // A plain-language statement of the mechanical constraint.
  statement: z.string(),
});
export type SpecEnforcedConstraint = z.infer<
  typeof SpecEnforcedConstraintSchema
>;

// The pinned harness spec. Public surface only: a system prompt, a tool
// manifest, the enforced (mechanical) constraints, a procedure, and the
// success criterion. No business rule the brief left unstated appears anywhere.
export const HarnessSpecSchema = z.object({
  id: z.string(),
  version: z.enum(["v1", "v2"]),
  // The model the live harness drives. Pinned to Opus for the live path.
  model: z.string(),
  // The base URL of the billing API, surfaced so the harness knows where to
  // issue refunds. A public fact, not a rule.
  billing_base_url: z.string(),
  // The system prompt handed to the agent. Rule-silent by construction.
  system_prompt: z.string(),
  // The tools the harness may call, each generated from a dossier's surface.
  tool_manifest: z.array(ToolManifestEntrySchema),
  // The mechanical constraints the harness is told are enforced. v1 surfaces
  // only the amount-within-remaining invariant the brief permits us to state.
  enforced_constraints: z.array(SpecEnforcedConstraintSchema),
  // The ordered procedure the harness should follow. v1 is read-and-resolve;
  // v2 adds the pre-screen and escalation steps.
  procedure: z.array(z.string()),
  // The single line the harness is graded on having satisfied.
  success_criterion: z.string(),
});
export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
