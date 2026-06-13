// The harness generator: it turns a brief plus the tool dossiers into a
// GenerationOutput, which is a public-surface harness spec paired with the world
// manifest that spec runs against. The live generation call (an Opus pass that
// reads the brief and the dossiers' public surface and writes a fresh spec) sits
// behind a key seam and is never invoked in the keyless build. The keyless
// default returns the committed, pinned v1 spec, so the whole pipeline builds,
// typechecks, and runs the consistency gates with no model in the loop.
//
// The deterministic consistency gates (doc 07 section 5.4) are the load-bearing
// part of this module. They run with no model and prove three properties of any
// candidate spec, generated or pinned:
//
//   1. resolution: every tool_manifest entry's `from` resolves to a real dossier
//      tool, and its `op_id` resolves to a real operation on that dossier, and
//      every enforced_constraint references a real enforced invariant. A spec
//      that names a tool or constraint the world does not provide cannot run.
//
//   2. leak: no text from the hidden intent layer (business_rules_not_enforced)
//      appears in the system prompt, the procedure, or any tool description, and
//      no business rule is dressed up as an enforced_constraint. This is the
//      trap, protected: the rules the brief never states must stay out of the
//      spec, or the synthetic stops measuring whether the harness discovers them.
//
//   3. owner-map coverage: the hidden_state_owner_map assigns an owning tool to
//      every business rule's ground-truth signal, and every owner is a tool the
//      world manifest actually provides. This proves no rule is unmeasurable
//      because the fact it turns on has no home in the synthetic world.

import type { ToolDossier } from "@/engine";
import type { HarnessSpec } from "./specs/index.js";
import { REFUND_HARNESS_SPEC_V1 } from "./specs/index.js";

// ---------------------------------------------------------------------------
// Generation output
// ---------------------------------------------------------------------------

// One synthetic tool the world provides, projected to the surface the harness
// spec is generated from: its id, its public intent, its base URL, and its
// operation ids. The hidden intent layer is intentionally absent here.
export interface WorldManifestTool {
  tool_id: string;
  intent: string;
  base_url: string;
  op_ids: string[];
}

// The map from a business rule to the tool that owns the ground-truth signal it
// turns on. The Judge reads ground truth from these owners; the coverage gate
// proves every rule has one and that the owner is a real tool. The owner is
// derived from the dossier that declares the rule and the signal's namespace.
export interface HiddenStateOwnerEntry {
  rule_id: string;
  // The tool whose hidden state holds the ground-truth signal for this rule.
  owner_tool_id: string;
  // The signal itself, e.g. "orders.purchase_date".
  ground_truth_signal: string;
  // The failure tag the Judge emits when this rule is violated.
  failure_tag: string;
}

// The world manifest: the synthetic world a harness spec runs against. It is the
// public projection of the dossiers plus the owner map the coverage gate checks.
export interface WorldManifest {
  pack_id: string;
  tools: WorldManifestTool[];
  hidden_state_owner_map: HiddenStateOwnerEntry[];
}

// The full output of one generation: the harness spec the agent is driven from
// and the world manifest that spec was generated against. Both are validated by
// the consistency gates before either is used.
export interface GenerationOutput {
  spec: HarnessSpec;
  world: WorldManifest;
}

// ---------------------------------------------------------------------------
// Owner derivation
// ---------------------------------------------------------------------------

// Resolve the tool that owns a ground-truth signal. A signal is namespaced by
// the tool that holds it ("orders.purchase_date", "customers.refund_count_30d",
// "charge.outcome.risk_level", "amount"). The namespace is mapped to the
// dossier tool_id that declares that data. Signals with no namespace, or one
// that names a derived quantity rather than a stored fact (e.g. "amount"), are
// owned by the dossier that declares the rule, since that tool's response is
// where the quantity is read.
function ownerForSignal(
  signal: string,
  declaringToolId: string,
  dossiers: ToolDossier[],
): string {
  const namespace = signal.includes(".") ? signal.split(".", 1)[0]! : signal;
  // Map a signal namespace to a dossier whose hidden-state schema or operation
  // surface owns it. The namespaces are the data domains, not the dossier ids,
  // so map them explicitly to the dossier that holds that domain.
  const byDomain: Record<string, string> = {
    orders: "orders",
    customers: "customers",
    charge: "stripe_payments",
    refund: "stripe_payments",
  };
  const mapped = byDomain[namespace];
  if (mapped !== undefined && dossiers.some((d) => d.tool_id === mapped)) {
    return mapped;
  }
  // A derived or unnamespaced signal (e.g. "amount") is owned by the tool that
  // declares the rule, whose response carries the quantity the rule reads.
  return declaringToolId;
}

// Build the hidden-state owner map from the dossiers' hidden intent layer. Every
// business_rules_not_enforced entry across every operation becomes one owner
// entry, deduplicated by rule id (a rule declared once owns one signal).
export function buildOwnerMap(
  dossiers: ToolDossier[],
): HiddenStateOwnerEntry[] {
  const entries: HiddenStateOwnerEntry[] = [];
  const seen = new Set<string>();
  for (const dossier of dossiers) {
    for (const op of dossier.operations) {
      for (const rule of op.business_rules_not_enforced) {
        if (seen.has(rule.id)) continue;
        seen.add(rule.id);
        entries.push({
          rule_id: rule.id,
          owner_tool_id: ownerForSignal(
            rule.ground_truth_signal,
            dossier.tool_id,
            dossiers,
          ),
          ground_truth_signal: rule.ground_truth_signal,
          failure_tag: rule.failure_tag,
        });
      }
    }
  }
  return entries;
}

// Project the dossiers to the public world manifest the gates and the live
// harness read. The hidden intent layer is dropped; only public surface and the
// owner map survive.
export function buildWorldManifest(
  packId: string,
  dossiers: ToolDossier[],
): WorldManifest {
  return {
    pack_id: packId,
    tools: dossiers.map((d) => ({
      tool_id: d.tool_id,
      intent: d.intent,
      base_url: d.base_url,
      op_ids: d.operations.map((op) => op.op_id),
    })),
    hidden_state_owner_map: buildOwnerMap(dossiers),
  };
}

// ---------------------------------------------------------------------------
// Consistency gates (doc 07 section 5.4)
// ---------------------------------------------------------------------------

// One gate violation: which gate failed, a machine-readable code, and a message
// stating exactly what was wrong so a generation can be rejected with a reason.
export interface GateViolation {
  gate: "resolution" | "leak" | "owner_map";
  code: string;
  message: string;
}

// The result of running the gates: a pass flag and every violation found. The
// gates do not stop at the first failure, so a rejected generation reports all
// of its problems at once.
export interface GateResult {
  ok: boolean;
  violations: GateViolation[];
}

// Normalize prose for the leak comparison: lowercase and collapse whitespace so
// a rule's intent text is caught regardless of casing or wrapping in the spec.
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Gate 1, resolution. Every tool_manifest entry must point at a dossier tool
// that exists and an operation that exists on it; every enforced_constraint must
// reference an enforced invariant that exists on some operation of the tool it
// names. A spec that asks for a capability the world does not provide is
// unrunnable and is rejected here.
function resolutionGate(
  spec: HarnessSpec,
  dossiers: ToolDossier[],
): GateViolation[] {
  const violations: GateViolation[] = [];
  const byId = new Map(dossiers.map((d) => [d.tool_id, d]));

  for (const entry of spec.tool_manifest) {
    const dossier = byId.get(entry.from);
    if (dossier === undefined) {
      violations.push({
        gate: "resolution",
        code: "unknown_tool",
        message: `tool_manifest entry "${entry.name}" points at unknown tool "${entry.from}".`,
      });
      continue;
    }
    if (!dossier.operations.some((op) => op.op_id === entry.op_id)) {
      violations.push({
        gate: "resolution",
        code: "unknown_operation",
        message: `tool_manifest entry "${entry.name}" names op "${entry.op_id}" not on tool "${entry.from}".`,
      });
    }
  }

  // Map each manifest tool name to the dossier it draws from, so an enforced
  // constraint can be checked against the right dossier's invariants.
  const toolNameToDossier = new Map<string, ToolDossier>();
  for (const entry of spec.tool_manifest) {
    const dossier = byId.get(entry.from);
    if (dossier !== undefined) toolNameToDossier.set(entry.name, dossier);
  }

  for (const constraint of spec.enforced_constraints) {
    const dossier = toolNameToDossier.get(constraint.tool);
    if (dossier === undefined) {
      violations.push({
        gate: "resolution",
        code: "constraint_unknown_tool",
        message: `enforced_constraint "${constraint.id}" names tool "${constraint.tool}" not in the manifest.`,
      });
      continue;
    }
    const known = dossier.operations.some((op) =>
      op.enforced_invariants.some((inv) => inv.id === constraint.id),
    );
    if (!known) {
      violations.push({
        gate: "resolution",
        code: "constraint_unknown_invariant",
        message: `enforced_constraint "${constraint.id}" is not an enforced invariant of tool "${constraint.tool}".`,
      });
    }
  }

  return violations;
}

// Gate 2, leak. The hidden intent layer must not appear in the public spec. No
// business_rules_not_enforced intent text may appear in the system prompt, any
// procedure step, or any tool description; and no enforced_constraint may carry
// the id or the intent of a business rule (a rule the API does not enforce must
// never be surfaced as one it does). This is what keeps the trap measurable.
function leakGate(spec: HarnessSpec, dossiers: ToolDossier[]): GateViolation[] {
  const violations: GateViolation[] = [];

  // Collect every hidden business rule across every operation.
  const rules: Array<{ id: string; intent: string }> = [];
  for (const dossier of dossiers) {
    for (const op of dossier.operations) {
      for (const rule of op.business_rules_not_enforced) {
        rules.push({ id: rule.id, intent: rule.intent });
      }
    }
  }

  // The prose surfaces the spec exposes to the harness. Each is scanned for any
  // rule intent text.
  const surfaces: Array<{ where: string; text: string }> = [
    { where: "system_prompt", text: spec.system_prompt },
    ...spec.procedure.map((step, i) => ({
      where: `procedure[${i}]`,
      text: step,
    })),
    ...spec.tool_manifest.map((entry) => ({
      where: `tool_manifest["${entry.name}"].description`,
      text: entry.description,
    })),
    { where: "success_criterion", text: spec.success_criterion },
  ];

  for (const surface of surfaces) {
    const haystack = normalize(surface.text);
    for (const rule of rules) {
      const needle = normalize(rule.intent);
      if (needle.length > 0 && haystack.includes(needle)) {
        violations.push({
          gate: "leak",
          code: "rule_text_in_spec",
          message: `${surface.where} leaks business rule "${rule.id}" intent text.`,
        });
      }
    }
  }

  // An enforced_constraint must not be a business rule wearing a mechanical hat.
  const ruleIds = new Set(rules.map((r) => r.id));
  for (const constraint of spec.enforced_constraints) {
    if (ruleIds.has(constraint.id)) {
      violations.push({
        gate: "leak",
        code: "business_rule_as_constraint",
        message: `enforced_constraint "${constraint.id}" is a business rule the API does not enforce.`,
      });
    }
    const statement = normalize(constraint.statement);
    for (const rule of rules) {
      const needle = normalize(rule.intent);
      if (needle.length > 0 && statement.includes(needle)) {
        violations.push({
          gate: "leak",
          code: "business_rule_as_constraint",
          message: `enforced_constraint "${constraint.id}" statement leaks business rule "${rule.id}".`,
        });
      }
    }
  }

  return violations;
}

// Gate 3, owner-map coverage. Every business rule must have an owner-map entry,
// and every entry's owner must be a tool the world manifest provides. A rule with
// no owner, or one owned by a tool the world does not expose, cannot be measured
// by the Judge and is rejected here.
function ownerMapGate(
  world: WorldManifest,
  dossiers: ToolDossier[],
): GateViolation[] {
  const violations: GateViolation[] = [];

  const ruleIds = new Set<string>();
  for (const dossier of dossiers) {
    for (const op of dossier.operations) {
      for (const rule of op.business_rules_not_enforced) {
        ruleIds.add(rule.id);
      }
    }
  }

  const coveredRuleIds = new Set(
    world.hidden_state_owner_map.map((e) => e.rule_id),
  );
  const worldToolIds = new Set(world.tools.map((t) => t.tool_id));

  for (const ruleId of ruleIds) {
    if (!coveredRuleIds.has(ruleId)) {
      violations.push({
        gate: "owner_map",
        code: "rule_uncovered",
        message: `business rule "${ruleId}" has no hidden_state_owner_map entry.`,
      });
    }
  }

  for (const entry of world.hidden_state_owner_map) {
    if (!worldToolIds.has(entry.owner_tool_id)) {
      violations.push({
        gate: "owner_map",
        code: "owner_not_in_world",
        message: `owner_map entry for rule "${entry.rule_id}" names tool "${entry.owner_tool_id}" not in the world manifest.`,
      });
    }
  }

  return violations;
}

// Run all three consistency gates over a generation output. A pure function: no
// model, no I/O. The result lists every violation, so a generation can be
// accepted or rejected with a full reason set.
export function runConsistencyGates(
  output: GenerationOutput,
  dossiers: ToolDossier[],
): GateResult {
  const violations: GateViolation[] = [
    ...resolutionGate(output.spec, dossiers),
    ...leakGate(output.spec, dossiers),
    ...ownerMapGate(output.world, dossiers),
  ];
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// The inputs to a generation: the under-specified brief and the tool dossiers
// whose public surface the spec is generated from. The hidden intent layer rides
// along on the dossiers but is read only to build the owner map and the gates,
// never to write the spec.
export interface GenerateInput {
  packId: string;
  brief: string;
  dossiers: ToolDossier[];
  // When set, the generator returns this spec instead of the pinned default.
  // The live generation path fills this from an Opus call; the keyless build
  // leaves it unset and the pinned v1 spec is used.
  spec?: HarnessSpec;
}

// Generate a harness spec plus its world manifest, then run the consistency
// gates. The keyless default returns the pinned v1 spec; a caller that has run
// the live generation pass passes the produced spec in. Either way the gates run
// and a failing generation throws, so a spec that leaks the trap or names a tool
// the world lacks never reaches the live harness.
export function generate(input: GenerateInput): GenerationOutput {
  const spec = input.spec ?? REFUND_HARNESS_SPEC_V1;
  const world = buildWorldManifest(input.packId, input.dossiers);
  const output: GenerationOutput = { spec, world };

  const gates = runConsistencyGates(output, input.dossiers);
  if (!gates.ok) {
    const summary = gates.violations
      .map((v) => `[${v.gate}:${v.code}] ${v.message}`)
      .join("; ");
    throw new Error(`generation failed consistency gates: ${summary}`);
  }

  return output;
}

// ---------------------------------------------------------------------------
// Live generation seam (gated behind a key, not invoked in the keyless build)
// ---------------------------------------------------------------------------

// The live generation pass: one Opus call that reads the brief and the public
// surface of the dossiers and writes a fresh harness spec. It is gated behind a
// key and is intentionally not implemented in the keyless build, because every
// keyless path uses the pinned spec. The seam is stated here so the live path
// drops in without changing the gate or the GenerationOutput contract: an
// implementation calls the model, parses its output through loadHarnessSpec, and
// hands the validated spec to generate() as input.spec, where the same
// deterministic gates reject any spec that leaks the trap or misnames a tool.
export type LiveSpecWriter = (input: {
  brief: string;
  worldTools: WorldManifestTool[];
}) => Promise<HarnessSpec>;
