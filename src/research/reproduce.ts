// The keyless reproduction path (doc 07 section 3.6). For the known refund
// brief the research step is shown reproducing the committed dossier set, not a
// blind discovery, so the whole downstream (the generation pass, the consistency
// gates, the synthetic world) is exercisable with no model credential and no web
// access. reproduceRefundBundle() returns a schema-valid ResearchBundle built
// from the committed refund dossiers: the five expected tools, the
// enforced-vs-not-enforced split intact, the capability graph that decomposes
// the refund brief, and the policies that became the Judge's ground truth.
//
// This is honest about its scope: it is a reproduction of the known set, the
// exact discipline doc 07 section 3.6 describes, validated against the committed
// fixtures rather than claiming a reliable blind discovery on an arbitrary
// brief. What it proves is narrower and still strong: given the brief and the
// real contracts, the enforced/unenforced split is present and that split alone
// drives the trap, and the downstream runs identically whether the bundle came
// from a live run or this reproduction.

import {
  REFUND_PACK_ID,
  REFUND_BRIEF,
  REFUND_DOSSIERS,
} from "@/scenarios/refund/index.js";
import type { ToolDossier } from "@/engine";

import type {
  CapabilityGraph,
  CandidateTool,
  IntakePolicy,
  RuleReview,
  ResearchBundle,
} from "./types.js";
import { ResearchBundleSchema } from "./types.js";
import { commitResearchBundle, completenessCheck } from "./stages.js";

// The vendor-neutral capability graph the refund brief decomposes into (doc 07
// section 3.1). The capability ids match the capability_bindings the committed
// dossiers already carry, so the completeness check sees full coverage. The
// governing capability (cap.apply_policy) is surfaced deliberately even though
// the brief never states it, because that surfacing is what makes the gap
// visible downstream.
const REFUND_CAPABILITY_GRAPH: CapabilityGraph = {
  brief: REFUND_BRIEF,
  domain: "ecommerce_customer_support_refunds",
  capabilities: [
    {
      id: "cap.read_inbox",
      verb: "read and triage inbound support messages",
      acceptance: "can list open requests, read full thread, reply, set status",
      necessity: "core",
    },
    {
      id: "cap.lookup_order",
      verb: "resolve a customer or message to its order and payment",
      acceptance: "given email or order number, return order and linked payment id",
      necessity: "core",
    },
    {
      id: "cap.issue_refund",
      verb: "move money back to the customer",
      acceptance: "can issue full or partial refund against a real payment object",
      necessity: "core",
    },
    {
      id: "cap.assess_fraud",
      verb: "obtain a risk signal on the payment or customer",
      acceptance: "given a payment id, return a risk indicator",
      necessity: "supporting",
    },
    {
      id: "cap.apply_policy",
      verb: "decide whether a refund is allowed under policy",
      acceptance: "given order and request, return allow, deny, or escalate with reason",
      necessity: "governing",
    },
  ],
  open_questions: [
    "Is there an approval threshold above which a human must sign off?",
    "What is the refund window? The brief does not say.",
  ],
};

// Project a committed dossier to the candidate-tool record the bundle records.
// The candidate is the vendor-named, discovery-stage view of the tool: its id,
// the capabilities it binds, its kind, and its home. The policy_store dossier is
// a none-internal candidate (a file in the sandbox), which is the honest answer
// for the governing capability that has no off-the-shelf product (doc 07
// section 3.2). Discovery scores are set at the committed-pick level, all above
// the fetchability gate, since these are the tools that were committed.
function candidateFromDossier(dossier: ToolDossier): CandidateTool {
  const isNoneInternal = dossier.tool_id === "policy_store";
  return {
    tool_id: dossier.tool_id,
    capability_bindings: [...dossier.capability_bindings],
    kind: isNoneInternal ? "none_internal" : "external_api",
    base_url: dossier.base_url,
    source_urls: [],
    popularity: isNoneInternal ? 0.3 : 0.8,
    fit: 0.8,
    coverage: 0.7,
    fetchability: isNoneInternal ? 0.6 : 0.9,
  };
}

// Pull the ground-truth policies out of the committed dossiers' intent layer.
// Each business_rules_not_enforced entry is a policy that governs the task and
// becomes the Judge's ground truth; its confidence carries over from the
// dossier (the intent layer is the system's weakest artifact, gated by the
// human-review step). These never enter the harness instructions.
function policiesFromDossiers(dossiers: ToolDossier[]): IntakePolicy[] {
  const policies: IntakePolicy[] = [];
  const seen = new Set<string>();
  for (const dossier of dossiers) {
    for (const op of dossier.operations) {
      for (const rule of op.business_rules_not_enforced) {
        if (seen.has(rule.id)) continue;
        seen.add(rule.id);
        policies.push({
          id: rule.id,
          intent: rule.intent,
          ground_truth_signal: rule.ground_truth_signal,
          confidence: rule.confidence,
        });
      }
    }
  }
  return policies;
}

// The human-review record for the reproduction: every business rule in the
// committed set was confirmed against the live docs and kept (doc 07 section
// 3.5 and 3.6). The record is the audit trail; the dossiers are unchanged
// because every disposition is keep.
function keepAllReviews(dossiers: ToolDossier[]): RuleReview[] {
  const reviews: RuleReview[] = [];
  for (const dossier of dossiers) {
    for (const op of dossier.operations) {
      for (const rule of op.business_rules_not_enforced) {
        reviews.push({
          tool_id: dossier.tool_id,
          rule_id: rule.id,
          disposition: "keep",
        });
      }
    }
  }
  return reviews;
}

// Build the keyless reproduction ResearchBundle from the committed refund
// dossiers. The bundle is schema-valid, carries the five expected tools with the
// enforced/not-enforced split intact, and freezes itself with a content hash so
// a replayed reproduction is byte-identical. The downstream generation pass
// reads this exactly as it would read a live bundle.
export function reproduceRefundBundle(): ResearchBundle {
  const dossiers = REFUND_DOSSIERS;
  const committedTools = dossiers.map(candidateFromDossier);
  const groundTruthPolicies = policiesFromDossiers(dossiers);
  const ruleReviews = keepAllReviews(dossiers);

  // The reproduction commits at the fixed point the refund trace reaches (doc 07
  // section 3.6): two real iterations, then a fixed point with full coverage.
  const completeness = completenessCheck({
    graph: REFUND_CAPABILITY_GRAPH,
    dossiers,
    iterations: 2,
  });

  const bundle = commitResearchBundle({
    pack_id: REFUND_PACK_ID,
    brief: REFUND_BRIEF,
    capability_graph: REFUND_CAPABILITY_GRAPH,
    committed_tools: committedTools,
    dossiers,
    ground_truth_policies: groundTruthPolicies,
    completeness,
    rule_reviews: ruleReviews,
    origin: "reproduction",
  });

  // Validate before returning, so the reproduction can never emit a bundle the
  // downstream would reject; a schema violation fails loudly here.
  return ResearchBundleSchema.parse(bundle);
}
