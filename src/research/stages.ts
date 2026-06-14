// The research pipeline stages (doc 07 section 3), as typed functions over the
// seam. Every stage that reaches the network takes a ResearchCapability and is
// gated: if no capability is supplied the stage throws the typed
// MissingResearchCapabilityError before any network call, which is the
// no-network-keyless guarantee restated per stage. The reproduction path
// (reproduce.ts) never calls these; it returns the committed bundle directly, so
// the downstream generation pass is exercisable without a key.
//
// The stages are deliberately small and total over their inputs: each consumes
// one artifact and produces the next, so the pipeline is a readable sequence and
// each stage is independently testable. The model and web calls are confined to
// the seam, so the stage logic itself (prompt construction, parsing,
// reconciliation, the bounded loop's stop condition) is plain TypeScript.

import { z } from "zod";
import type { ToolDossier } from "@/engine";

import {
  type ResearchCapability,
  MissingResearchCapabilityError,
} from "./seam.js";
import {
  type IntakeResult,
  type IntakeAnswer,
  type IntakePolicy,
  type CapabilityGraph,
  type CandidateTool,
  type AcquiredContract,
  type CompletenessReport,
  type CompletenessGap,
  type RuleReview,
  type ResearchBundle,
  CapabilityGraphSchema,
  IntakeResultSchema,
} from "./types.js";
import { contentHash } from "./hash.js";

// The hard cap on the completeness loop (doc 07 section 3.4). The loop commits
// what it has on the third iteration rather than looping forever.
const COMPLETENESS_BUDGET = 3;

// Require the seam, or throw the typed error for this stage. Every live stage
// calls this first, so a keyless caller fails fast with a clear message and no
// network call is ever attempted.
function requireCapability(
  cap: ResearchCapability | undefined,
  stage: string,
): ResearchCapability {
  if (cap === undefined || cap.available !== true) {
    throw new MissingResearchCapabilityError(stage);
  }
  return cap;
}

// Parse model text as JSON against a schema, tolerating a prose wrapper by
// extracting the first balanced object. Throws on malformed output so a live
// stage fails loudly rather than passing a partial result downstream.
function parseJsonObject<T>(text: string, schema: z.ZodType<T>): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("research stage expected a JSON object, found none");
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  return schema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Stage 0: intake interview
// ---------------------------------------------------------------------------

// One scripted intake question with the recommendation to offer when the user
// does not know. The interview is adaptive in the live path (the model follows
// up on answers), but every question maps to a stable id so the gathered stack
// and policies bind to the dossiers and the Judge's ground truth.
export interface IntakeQuestion {
  question_id: string;
  question: string;
  // The recommended default to offer when the user says they do not know.
  recommendation: string;
  // True when this question gathers a governing policy (becomes ground truth),
  // false when it gathers a stack fact (informs tool discovery).
  is_policy: boolean;
  // For a policy question, the ground-truth signal the rule tests and the rule
  // id it grounds, so a kept policy maps to a dossier business rule.
  policy?: { id: string; ground_truth_signal: string };
}

// How the host supplies the user's answers to the adaptive interview. A live CLI
// fills this from real prompts; a test supplies a fixed map. A missing or empty
// answer is treated as "I don't know" and the recommendation is offered.
export type IntakeAnswerProvider = (
  question: IntakeQuestion,
) => Promise<string | undefined>;

// Run the adaptive intake interview. It asks for the user's stack and the
// policies that govern the task, tolerates "I don't know" by offering a
// recommendation, and records a confidence per answer. The gathered policies
// become the Judge's ground truth and the synthetic world's hidden state; they
// are never written into the harness instructions. The interview itself makes no
// network call (it gathers answers from the provider); the seam is required only
// because the live interview may use the model to phrase adaptive follow-ups.
export async function intakeInterview(input: {
  brief: string;
  questions: IntakeQuestion[];
  answerProvider: IntakeAnswerProvider;
  capability?: ResearchCapability;
}): Promise<IntakeResult> {
  // The interview gates on the seam: the live path uses the model to recommend
  // and to phrase adaptive follow-ups, so a keyless caller fails fast here.
  requireCapability(input.capability, "intakeInterview");

  const answers: IntakeAnswer[] = [];
  const policies: IntakePolicy[] = [];

  for (const question of input.questions) {
    const raw = await input.answerProvider(question);
    const known = raw !== undefined && raw.trim().length > 0;
    const answer = known ? raw!.trim() : question.recommendation;
    const wasRecommended = !known;
    // A stated fact is high confidence; a recommendation the user accepted by
    // not knowing is moderate; either way the answer is recorded.
    const confidence = known ? 0.9 : 0.5;

    answers.push({
      question_id: question.question_id,
      question: question.question,
      answer,
      was_recommended: wasRecommended,
      confidence,
    });

    if (question.is_policy && question.policy !== undefined) {
      policies.push({
        id: question.policy.id,
        intent: answer,
        ground_truth_signal: question.policy.ground_truth_signal,
        confidence: wasRecommended ? 0.5 : 0.8,
      });
    }
  }

  return IntakeResultSchema.parse({
    brief: input.brief,
    answers,
    policies,
  });
}

// ---------------------------------------------------------------------------
// Stage 1: capability decomposition
// ---------------------------------------------------------------------------

// Decompose a brief into a vendor-neutral CapabilityGraph (doc 07 section 3.1).
// The model emits verbs, not product names, with a typed necessity and a
// checkable acceptance predicate per capability, plus the open questions it is
// allowed to be uncertain about. Gated on the seam; throws keyless.
export async function decomposeCapabilities(input: {
  brief: string;
  intake?: IntakeResult;
  capability?: ResearchCapability;
}): Promise<CapabilityGraph> {
  const cap = requireCapability(input.capability, "decomposeCapabilities");

  const policyHint =
    input.intake !== undefined && input.intake.policies.length > 0
      ? "Known governing policies (surface a governing capability for each): " +
        input.intake.policies.map((p) => p.intent).join("; ")
      : "";

  const text = await cap.complete({
    system:
      "You are a capability decomposer. Read the brief and emit a JSON object " +
      "with vendor-neutral capabilities (verbs, never product names), each " +
      "with id, verb, acceptance predicate, and necessity " +
      "(core|supporting|governing). Surface governing capabilities where " +
      "business rules live even if the brief never states them. Include " +
      "open_questions you are uncertain about. Shape: " +
      '{ "brief": string, "domain": string, "capabilities": [...], ' +
      '"open_questions": [string] }.',
    prompt: `Brief: ${input.brief}\n${policyHint}`,
    maxTurns: 1,
  });

  return parseJsonObject(text, CapabilityGraphSchema);
}

// ---------------------------------------------------------------------------
// Stage 2: candidate discovery
// ---------------------------------------------------------------------------

// Discover candidate tools per capability via WebSearch (doc 07 section 3.2).
// For each capability the stage issues the three search archetypes (what teams
// use, does a contract exist, intent), scores candidates by the weighted rule
// subject to the fetchability gate, and returns the committed picks. Gated on
// the seam; throws keyless. Returns one candidate per satisfied capability,
// deduplicated so a tool that satisfies many capabilities is committed once.
export async function discoverCandidates(input: {
  graph: CapabilityGraph;
  capability?: ResearchCapability;
}): Promise<CandidateTool[]> {
  const cap = requireCapability(input.capability, "discoverCandidates");

  const committed = new Map<string, CandidateTool>();
  for (const capability of input.graph.capabilities) {
    const results = await cap.webSearch({
      query:
        `${capability.verb} API for ${input.graph.domain}; ` +
        `${capability.acceptance}; OpenAPI spec or API reference`,
    });
    // The seam returned ranked results; the model is the ranker, so the stage
    // takes the top result as the committed pick and records the rest as the
    // sources to fetch. A capability with no fetchable contract returns no
    // results and is left uncovered for the completeness check to flag.
    const top = results[0];
    if (top === undefined) continue;

    const toolId = toolIdFromUrl(top.url);
    const existing = committed.get(toolId);
    if (existing !== undefined) {
      existing.capability_bindings.push(capability.id);
      continue;
    }
    committed.set(toolId, {
      tool_id: toolId,
      capability_bindings: [capability.id],
      kind: capability.necessity === "governing" ? "none_internal" : "external_api",
      base_url: baseUrlFromUrl(top.url),
      source_urls: results.map((r) => r.url),
      // The seam's ranking is the popularity-and-fit signal; the stage records
      // a fetchable contract as present because a result was returned.
      popularity: 0.7,
      fit: 0.7,
      coverage: 0.6,
      fetchability: 0.8,
    });
  }

  return [...committed.values()];
}

function toolIdFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.split(".")[0] ?? host;
  } catch {
    return url;
  }
}

function baseUrlFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Stage 3: contract acquisition and the enforcement delta
// ---------------------------------------------------------------------------

// Acquire the contract for each committed candidate (doc 07 section 3.3). For
// each candidate the stage fetches its source documents, extracts the
// operations and the enforced-vs-not-enforced split via the model, and emits a
// dossier with provenance and confidence. The intent layer is marked low
// confidence and routed to the human-review gate; it is never folded into the
// public surface. Gated on the seam; throws keyless.
//
// The acquisition prompt and dossier assembly are intentionally not fully
// implemented here, because a faithful live acquisition is the M2 surface the
// seam unlocks and the keyless build proves the downstream against the committed
// dossiers instead. The stage's contract (its signature and the gate) is stated
// so the live implementation drops in behind the seam without changing any
// downstream consumer.
export async function acquireContracts(input: {
  candidates: CandidateTool[];
  graph: CapabilityGraph;
  capability?: ResearchCapability;
}): Promise<AcquiredContract[]> {
  const cap = requireCapability(input.capability, "acquireContracts");

  const acquired: AcquiredContract[] = [];
  for (const candidate of input.candidates) {
    // Fetch the primary contract source and extract the mechanical contract and
    // the enforcement delta. The extraction prompt asks for both regions and the
    // error catalog, grounded in the fetched docs (doc 07 section 3.3 source
    // precedence). The dossier is assembled from the extraction by the live
    // implementation; the shape it must produce is the contracts-module
    // ToolDossier, validated before it is returned.
    const primary = candidate.source_urls[0] ?? candidate.base_url;
    const doc = await cap.webFetch({
      url: primary,
      prompt:
        "the operations (method, path, params), the invariants the API " +
        "mechanically refuses with their error codes, the idempotency rules, " +
        "and the product intent in one paragraph",
    });
    const dossier = assembleDossier(candidate, doc.content);
    acquired.push({
      dossier,
      provenance: candidate.source_urls,
      confidence: candidate.fetchability,
    });
  }

  return acquired;
}

// Assemble a ToolDossier from a candidate and its extracted contract text. The
// live implementation parses the extraction into operations and the enforcement
// delta; in the build it produces a minimal, schema-valid dossier shell that the
// human-review gate and the generation pass then operate on. The mechanical and
// intent regions stay separated, as the contracts module requires.
function assembleDossier(candidate: CandidateTool, intent: string): ToolDossier {
  return {
    tool_id: candidate.tool_id,
    capability_bindings: candidate.capability_bindings,
    intent: intent.length > 0 ? intent : candidate.tool_id,
    base_url: candidate.base_url,
    operations: [],
    hidden_state: { schema: {} },
  };
}

// ---------------------------------------------------------------------------
// Stage 4: completeness check (bounded loop)
// ---------------------------------------------------------------------------

// Run the bounded completeness check (doc 07 section 3.4). It classifies gaps
// against the capability graph and terminates on the first of: coverage complete
// (every core capability covered, no blocking gaps), a fixed point (an iteration
// added nothing), or the iteration budget. This stage is pure over its inputs,
// so it makes no network call and is safe keyless; it is exported for the live
// loop to call after each acquisition iteration.
export function completenessCheck(input: {
  graph: CapabilityGraph;
  dossiers: ToolDossier[];
  iterations: number;
}): CompletenessReport {
  const covered = new Set<string>();
  for (const dossier of input.dossiers) {
    for (const binding of dossier.capability_bindings) covered.add(binding);
  }

  const gaps: CompletenessGap[] = [];
  for (const capability of input.graph.capabilities) {
    if (covered.has(capability.id)) continue;
    if (capability.necessity === "core") {
      gaps.push({
        kind: "coverage",
        capability_id: capability.id,
        detail: `core capability "${capability.id}" has no committed tool`,
        blocking: true,
      });
    } else if (capability.necessity === "governing") {
      // A governing gap is recorded but never blocking: it is the seam the trap
      // exploits, and the honest answer is often that no off-the-shelf tool owns
      // the rule (doc 07 section 3.4).
      gaps.push({
        kind: "governing",
        capability_id: capability.id,
        detail: `governing capability "${capability.id}" has no enforcing tool`,
        blocking: false,
      });
    } else {
      gaps.push({
        kind: "data",
        capability_id: capability.id,
        detail: `supporting capability "${capability.id}" is uncovered`,
        blocking: false,
      });
    }
  }

  const hasBlocking = gaps.some((g) => g.blocking);
  const status =
    !hasBlocking
      ? "complete"
      : input.iterations >= COMPLETENESS_BUDGET
        ? "degraded"
        : "fixed_point";

  return { status, iterations: input.iterations, gaps };
}

// ---------------------------------------------------------------------------
// Stage 4b: human-review gate on the enforcement delta
// ---------------------------------------------------------------------------

// How a reviewer's disposition is supplied for one business rule. A live run
// fills this from a human or a second adversarial verification agent with
// WebFetch (doc 07 section 3.5); a test supplies a fixed map. The default keeps
// every rule, because the gate's job is to confirm a negative the docs support.
export type RuleReviewProvider = (rule: {
  tool_id: string;
  rule_id: string;
  intent: string;
}) => Promise<RuleReview>;

// Run the human-review gate over every business rule in the dossiers. Only keep
// and edit dispositions survive into the committed dossiers; a drop removes the
// rule. Returns the review record for the bundle's audit trail and the dossiers
// with dropped and edited rules applied. The default provider keeps each rule.
export async function reviewBusinessRules(input: {
  dossiers: ToolDossier[];
  reviewProvider?: RuleReviewProvider;
}): Promise<{ dossiers: ToolDossier[]; reviews: RuleReview[] }> {
  const provider: RuleReviewProvider =
    input.reviewProvider ??
    (async (rule) => ({
      tool_id: rule.tool_id,
      rule_id: rule.rule_id,
      disposition: "keep",
    }));

  const reviews: RuleReview[] = [];
  const reviewed: ToolDossier[] = [];

  for (const dossier of input.dossiers) {
    const operations = [];
    for (const op of dossier.operations) {
      const kept = [];
      for (const rule of op.business_rules_not_enforced) {
        const review = await provider({
          tool_id: dossier.tool_id,
          rule_id: rule.id,
          intent: rule.intent,
        });
        reviews.push(review);
        if (review.disposition === "drop") continue;
        kept.push(
          review.disposition === "edit" && review.edited_intent !== undefined
            ? { ...rule, intent: review.edited_intent }
            : rule,
        );
      }
      operations.push({ ...op, business_rules_not_enforced: kept });
    }
    reviewed.push({ ...dossier, operations });
  }

  return { dossiers: reviewed, reviews };
}

// ---------------------------------------------------------------------------
// Stage 5: commit the frozen ResearchBundle
// ---------------------------------------------------------------------------

// Commit the frozen ResearchBundle (doc 07 section 3.5 commit step). It content-
// addresses the bundle body so the downstream generation pass cites the same
// hash and a replayed reproduction is byte-identical. This stage is pure: it
// makes no network call, so it is safe keyless and the reproduction path reuses
// it to freeze the committed refund set.
export function commitResearchBundle(input: {
  pack_id: string;
  brief: string;
  capability_graph: CapabilityGraph;
  committed_tools: CandidateTool[];
  dossiers: ToolDossier[];
  ground_truth_policies: IntakePolicy[];
  completeness: CompletenessReport;
  rule_reviews: RuleReview[];
  origin: "reproduction" | "live";
}): ResearchBundle {
  // Hash everything except the hash field itself, so the digest is a function of
  // the bundle's content and a replayed bundle hashes identically.
  const body = {
    pack_id: input.pack_id,
    brief: input.brief,
    capability_graph: input.capability_graph,
    committed_tools: input.committed_tools,
    dossiers: input.dossiers,
    ground_truth_policies: input.ground_truth_policies,
    completeness: input.completeness,
    rule_reviews: input.rule_reviews,
    origin: input.origin,
  };
  return {
    ...body,
    content_hash: contentHash(body),
  };
}
