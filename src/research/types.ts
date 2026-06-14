// The research pipeline's typed artifacts (doc 07 section 3). Every stage
// consumes and produces one of these shapes, so the pipeline is a sequence of
// total functions over data, not a tangle of side effects. The single frozen
// output is the ResearchBundle: a brief, a capability graph, the committed tool
// set, and the per-tool dossiers, content-addressed so the downstream generation
// pass reads exactly what the research produced and cannot drift from it.
//
// Two regions of every dossier stay strictly separated, as the contracts module
// defines them: the mechanical contract (operations, enforced_invariants) that
// drives both the harness view and the kernel enforcement, and the intent layer
// (business_rules_not_enforced) that drives only the Judge. The research stages
// populate both regions but never let the intent layer leak into the public
// surface the generation pass reads; that discipline is the trap, preserved.

import { z } from "zod";
import { ToolDossierSchema } from "@/engine";

// ---------------------------------------------------------------------------
// Stage 0: intake interview
// ---------------------------------------------------------------------------

// One answer gathered by the adaptive intake interview. The interview asks for
// the user's stack and the policies that govern the task, tolerates "I don't
// know", and records a confidence for each answer so a recommended default can
// be marked as weaker than a stated fact. The gathered policies become the
// Judge's ground truth and the synthetic world's hidden state; they are never
// written into the harness instructions, which is what keeps the trap honest.
export const IntakeAnswerSchema = z.object({
  // The question's stable id, e.g. "stack.payments" or "policy.refund_window".
  question_id: z.string(),
  // The plain-language question that was asked.
  question: z.string(),
  // The user's answer, or the recommended default when the user said they did
  // not know. Empty when the question was skipped.
  answer: z.string(),
  // True when the answer is the interview's recommendation rather than a fact
  // the user stated, so a downstream stage can treat it as a weaker signal.
  was_recommended: z.boolean(),
  // 0..1 confidence in this answer. A stated fact is high; a recommendation is
  // moderate; a skipped unknown is low.
  confidence: z.number().min(0).max(1),
});
export type IntakeAnswer = z.infer<typeof IntakeAnswerSchema>;

// One policy the interview surfaced that governs the task. These are the rules
// the brief leaves unstated: a refund window, an approval threshold, a fraud
// posture. They flow into dossier business_rules_not_enforced and the Judge's
// ground truth, and are deliberately withheld from the harness instructions.
export const IntakePolicySchema = z.object({
  // A stable id matching the dossier business rule it grounds, e.g.
  // "refund_window_30d".
  id: z.string(),
  // The human-readable rule, e.g. "refunds only within 30 days of purchase".
  intent: z.string(),
  // Where the ground-truth signal that tests this rule lives, e.g.
  // "orders.purchase_date".
  ground_truth_signal: z.string(),
  // 0..1 confidence the policy was understood correctly.
  confidence: z.number().min(0).max(1),
});
export type IntakePolicy = z.infer<typeof IntakePolicySchema>;

// The frozen outcome of the intake interview: the brief it refined, the answers
// gathered about the stack, and the policies that become ground truth. The
// pipeline carries this forward so the downstream stages can prefer the user's
// named tools and so the Judge knows what to score against.
export const IntakeResultSchema = z.object({
  brief: z.string(),
  answers: z.array(IntakeAnswerSchema),
  policies: z.array(IntakePolicySchema),
});
export type IntakeResult = z.infer<typeof IntakeResultSchema>;

// ---------------------------------------------------------------------------
// Stage 1: capability decomposition
// ---------------------------------------------------------------------------

// How load-bearing a capability is. A core capability must map to a committed
// tool or the harness cannot run at all. A supporting capability improves
// quality. A governing capability is where the business rules live; it is
// surfaced deliberately even when the brief never mentions it, because that
// surfacing is what later makes the business-fit gap visible.
export const NecessitySchema = z.enum(["core", "supporting", "governing"]);
export type Necessity = z.infer<typeof NecessitySchema>;

// One vendor-neutral capability. The decomposer emits verbs, not product names,
// so the completeness check can see real gaps rather than being biased toward
// the first vendor anyone thought of. The acceptance predicate is the checkable
// test the completeness check later scores a committed tool against.
export const CapabilitySchema = z.object({
  id: z.string(),
  // The vendor-neutral verb, e.g. "move money back to the customer".
  verb: z.string(),
  // The checkable predicate a committed tool must satisfy.
  acceptance: z.string(),
  necessity: NecessitySchema,
});
export type Capability = z.infer<typeof CapabilitySchema>;

// The capability graph: the brief decomposed into vendor-neutral capabilities
// plus the open questions the decomposer is allowed to be uncertain about, which
// become hidden-state knobs and policy parameters for the synthetic world.
export const CapabilityGraphSchema = z.object({
  brief: z.string(),
  domain: z.string(),
  capabilities: z.array(CapabilitySchema),
  open_questions: z.array(z.string()),
});
export type CapabilityGraph = z.infer<typeof CapabilityGraphSchema>;

// ---------------------------------------------------------------------------
// Stage 2: candidate discovery
// ---------------------------------------------------------------------------

// What kind of source a candidate tool is. A normal external API; a
// none-internal candidate (a policy file, a wiki page) that becomes a synthetic
// file in the sandbox rather than a network API, which is the honest answer for
// a governing capability that has no off-the-shelf product.
export const CandidateKindSchema = z.enum(["external_api", "none_internal"]);
export type CandidateKind = z.infer<typeof CandidateKindSchema>;

// One discovered candidate tool for a capability, with the weighted score
// components from the selection rule and the source documents discovery found.
// Fetchability is a hard gate: a candidate with no fetchable contract cannot be
// faithfully synthesized and is never committed.
export const CandidateToolSchema = z.object({
  tool_id: z.string(),
  // The capability ids this candidate would satisfy; one tool can satisfy many.
  capability_bindings: z.array(z.string()),
  kind: CandidateKindSchema,
  // The candidate's home, e.g. "https://api.stripe.com" or a file URL.
  base_url: z.string(),
  // The documents discovery located, to be fetched in the acquisition stage.
  source_urls: z.array(z.string()),
  // 0..1 weighted-score components from the selection rule (doc 07 section 3.2).
  popularity: z.number().min(0).max(1),
  fit: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  fetchability: z.number().min(0).max(1),
});
export type CandidateTool = z.infer<typeof CandidateToolSchema>;

// ---------------------------------------------------------------------------
// Stage 3: contract acquisition
// ---------------------------------------------------------------------------

// One acquired contract for a committed candidate: the dossier built from the
// fetched docs plus the provenance and confidence the acquisition recorded. The
// dossier itself is the contracts-module ToolDossier, so the rest of the system
// reads it unchanged.
export const AcquiredContractSchema = z.object({
  dossier: ToolDossierSchema,
  // Every source url the dossier's fields were reconciled from.
  provenance: z.array(z.string()),
  // 0..1 aggregate confidence in the acquired contract.
  confidence: z.number().min(0).max(1),
});
export type AcquiredContract = z.infer<typeof AcquiredContractSchema>;

// ---------------------------------------------------------------------------
// Stage 4: completeness check
// ---------------------------------------------------------------------------

// One gap the completeness check found. A coverage gap (a core capability with
// no committed tool) is blocking; a data gap (a committed tool that does not
// produce a field a downstream capability needs) is real, not optional; a
// governing gap is recorded but never blocking, because it is the seam the trap
// exploits; a redundancy collapses two tools claiming the same capability.
export const GapKindSchema = z.enum([
  "coverage",
  "data",
  "governing",
  "redundancy",
]);
export type GapKind = z.infer<typeof GapKindSchema>;

export const CompletenessGapSchema = z.object({
  kind: GapKindSchema,
  // The capability the gap concerns.
  capability_id: z.string(),
  // A human-readable statement of what the harness would be unable to do.
  detail: z.string(),
  blocking: z.boolean(),
});
export type CompletenessGap = z.infer<typeof CompletenessGapSchema>;

// How the bounded completeness loop terminated. Complete: every core capability
// is covered and no blocking gaps remain. Fixed point: an iteration added
// nothing. Degraded: the iteration budget was hit; the bundle commits what it
// has and lists unmet capabilities honestly.
export const CompletenessStatusSchema = z.enum([
  "complete",
  "fixed_point",
  "degraded",
]);
export type CompletenessStatus = z.infer<typeof CompletenessStatusSchema>;

export const CompletenessReportSchema = z.object({
  status: CompletenessStatusSchema,
  // How many loop iterations ran, bounded at the budget.
  iterations: z.number().int().min(0),
  gaps: z.array(CompletenessGapSchema),
});
export type CompletenessReport = z.infer<typeof CompletenessReportSchema>;

// ---------------------------------------------------------------------------
// Stage 4b: human-review gate
// ---------------------------------------------------------------------------

// A reviewer's disposition on one derived business rule. Keep: the API does not
// enforce this, so the rule stands. Drop: the API actually enforces it, so it is
// removed. Edit: the rule is kept with a corrected intent. Only keep and edit
// entries survive into the committed dossier.
export const ReviewDispositionSchema = z.enum(["keep", "drop", "edit"]);
export type ReviewDisposition = z.infer<typeof ReviewDispositionSchema>;

// One reviewed business rule: the dossier and rule it concerns and the
// reviewer's disposition. The gate (doc 07 section 3.5) confirms each derived
// rule against the live docs, because asserting a negative from docs is the
// system's weakest auto-derived artifact.
export const RuleReviewSchema = z.object({
  tool_id: z.string(),
  rule_id: z.string(),
  disposition: ReviewDispositionSchema,
  // Set when the disposition is edit: the corrected intent text.
  edited_intent: z.string().optional(),
});
export type RuleReview = z.infer<typeof RuleReviewSchema>;

// ---------------------------------------------------------------------------
// Stage 5: the committed ResearchBundle
// ---------------------------------------------------------------------------

// The single frozen artifact the research pipeline commits and the generation
// pass consumes. It carries the brief, the capability graph, the committed
// candidate tool set, and the per-tool dossiers, plus the completeness report
// and the human-review record so the commit is auditable. The content hash
// freezes the artifact; the downstream generation pass cites the same hash so
// the harness view and the synthetic world cannot drift from what was committed.
export const ResearchBundleSchema = z.object({
  // The pack id the downstream generation pass keys the world manifest on.
  pack_id: z.string(),
  // The (possibly refined) brief the harness spec is generated from.
  brief: z.string(),
  // sha256 over the canonicalized bundle body, freezing the artifact.
  content_hash: z.string(),
  capability_graph: CapabilityGraphSchema,
  // The committed tool set, vendor-named, with their capability bindings.
  committed_tools: z.array(CandidateToolSchema),
  // One dossier per committed tool. The mechanical/intent split is intact.
  dossiers: z.array(ToolDossierSchema),
  // The policies that became ground truth, carried for the Judge.
  ground_truth_policies: z.array(IntakePolicySchema),
  completeness: CompletenessReportSchema,
  // The human-review record for every business rule that was gated.
  rule_reviews: z.array(RuleReviewSchema),
  // How the bundle was produced: a keyless reproduction of the known set, or a
  // live research run. The downstream is identical either way.
  origin: z.enum(["reproduction", "live"]),
});
export type ResearchBundle = z.infer<typeof ResearchBundleSchema>;

// Validate a candidate bundle against the frozen schema and return the typed
// value. Throws on any schema violation, so a malformed bundle fails loudly at
// the boundary rather than silently downstream.
export function loadResearchBundle(candidate: unknown): ResearchBundle {
  return ResearchBundleSchema.parse(candidate);
}
