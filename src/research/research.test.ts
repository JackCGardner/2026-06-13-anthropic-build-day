// Keyless proof for the research pipeline (item 2). Two properties are asserted
// with no model credential and no web access:
//
//   1. reproduceRefundBundle() yields a valid ResearchBundle: schema-valid, the
//      five expected tools, the enforced/not-enforced split intact, the
//      capability graph that decomposes the refund brief, and a content hash that
//      is stable across replays. The bundle also drives the existing generation
//      pass's consistency gates, so the downstream is exercisable keyless.
//
//   2. Every live stage throws the typed MissingResearchCapabilityError with no
//      capability and makes no network call. The Agent SDK's query is replaced
//      with a spy that throws if it is ever invoked, so any stage that reaches
//      the network fails this test loudly. The seam factory throws keyless too.
//
// The query spy is registered before the modules under test import the SDK, so
// both bind to the spied query and the no-network guarantee is an assertion.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the Agent SDK so any network-bound call is observable. The spy throws
// if invoked: a keyless path that reaches it fails the test. Created inside
// vi.hoisted so it exists when the hoisted vi.mock factory runs.
const { querySpy } = vi.hoisted(() => ({
  querySpy: vi.fn(() => {
    throw new Error("query() was called on a keyless research path");
  }),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: querySpy,
  createSdkMcpServer: vi.fn(() => ({})),
}));

import {
  reproduceRefundBundle,
  ResearchBundleSchema,
  MissingResearchCapabilityError,
  createLiveResearchCapability,
  hasResearchCapability,
  intakeInterview,
  decomposeCapabilities,
  discoverCandidates,
  acquireContracts,
  reviewBusinessRules,
  completenessCheck,
  commitResearchBundle,
  contentHash,
} from "./index.js";
import { generate, runConsistencyGates } from "@/harness/generator.js";
import { REFUND_DOSSIERS } from "@/scenarios/refund/index.js";

// An environment with no model credential and no web grant of any kind.
const KEYLESS_ENV = {} as NodeJS.ProcessEnv;

beforeEach(() => {
  querySpy.mockClear();
});

describe("reproduceRefundBundle yields a valid ResearchBundle keyless", () => {
  it("is schema-valid", () => {
    const bundle = reproduceRefundBundle();
    expect(() => ResearchBundleSchema.parse(bundle)).not.toThrow();
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("carries the five expected committed tools", () => {
    const bundle = reproduceRefundBundle();
    const ids = bundle.committed_tools.map((t) => t.tool_id).sort();
    expect(ids).toEqual(
      [
        "customers",
        "orders",
        "policy_store",
        "stripe_payments",
        "zendesk_support",
      ].sort(),
    );
    expect(bundle.dossiers).toHaveLength(5);
  });

  it("keeps the enforced-vs-not-enforced split intact on the Stripe dossier", () => {
    const bundle = reproduceRefundBundle();
    const stripe = bundle.dossiers.find((d) => d.tool_id === "stripe_payments");
    expect(stripe).toBeDefined();
    const createRefund = stripe!.operations.find(
      (op) => op.op_id === "create_refund",
    );
    expect(createRefund).toBeDefined();
    // The mechanical contract enforces the real Stripe invariants.
    const enforcedIds = createRefund!.enforced_invariants.map((i) => i.id);
    expect(enforcedIds).toContain("charge_exists");
    expect(enforcedIds).toContain("amount_within_remaining");
    expect(enforcedIds).toContain("one_of_charge_or_pi");
    // The intent layer holds the five business rules, unenforced.
    const ruleIds = createRefund!.business_rules_not_enforced.map((r) => r.id);
    expect(ruleIds).toContain("refund_window_30d");
    expect(ruleIds).toContain("never_autorefund_chargeback");
    expect(createRefund!.business_rules_not_enforced.length).toBeGreaterThanOrEqual(5);
  });

  it("surfaces the governing capability and the ground-truth policies", () => {
    const bundle = reproduceRefundBundle();
    const governing = bundle.capability_graph.capabilities.find(
      (c) => c.necessity === "governing",
    );
    expect(governing?.id).toBe("cap.apply_policy");
    // Every business rule became a ground-truth policy for the Judge.
    const policyIds = bundle.ground_truth_policies.map((p) => p.id);
    expect(policyIds).toContain("refund_window_30d");
    expect(policyIds).toContain("manager_approval_over_500");
  });

  it("records a keep disposition for every reviewed rule", () => {
    const bundle = reproduceRefundBundle();
    expect(bundle.rule_reviews.length).toBeGreaterThanOrEqual(5);
    for (const review of bundle.rule_reviews) {
      expect(review.disposition).toBe("keep");
    }
  });

  it("commits at a fixed point with full core coverage", () => {
    const bundle = reproduceRefundBundle();
    expect(bundle.completeness.status).toBe("complete");
    // No blocking coverage gap remains; the governing gap is recorded but never
    // blocking, because it is the seam the trap exploits.
    const blocking = bundle.completeness.gaps.filter((g) => g.blocking);
    expect(blocking).toHaveLength(0);
  });

  it("freezes itself with a content hash that is stable across replays", () => {
    const a = reproduceRefundBundle();
    const b = reproduceRefundBundle();
    expect(a.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.content_hash).toBe(b.content_hash);
    // The hash is a function of the body, not the hash field itself.
    const { content_hash: _h, ...body } = a;
    expect(contentHash(body)).toBe(a.content_hash);
  });

  it("drives the existing generation pass and passes the consistency gates", () => {
    const bundle = reproduceRefundBundle();
    // The bundle's dossiers feed the deterministic generation pass unchanged.
    const output = generate({
      packId: bundle.pack_id,
      brief: bundle.brief,
      dossiers: bundle.dossiers,
    });
    const gates = runConsistencyGates(output, bundle.dossiers);
    expect(gates.ok).toBe(true);
    expect(gates.violations).toHaveLength(0);
    // The dossiers the bundle commits are the committed refund dossiers
    // (a validated copy, structurally equal to the source of truth).
    expect(bundle.dossiers).toEqual(REFUND_DOSSIERS);
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe("the seam factory and live stages gate on the credential keyless", () => {
  it("hasResearchCapability is false with no key and no web grant", () => {
    expect(hasResearchCapability(KEYLESS_ENV)).toBe(false);
  });

  it("createLiveResearchCapability throws the typed error keyless", () => {
    expect(() => createLiveResearchCapability({ env: KEYLESS_ENV })).toThrow(
      MissingResearchCapabilityError,
    );
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("intakeInterview throws the typed error with no capability", async () => {
    await expect(
      intakeInterview({
        brief: "anything",
        questions: [],
        answerProvider: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(MissingResearchCapabilityError);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("decomposeCapabilities throws the typed error with no capability", async () => {
    await expect(
      decomposeCapabilities({ brief: "anything" }),
    ).rejects.toBeInstanceOf(MissingResearchCapabilityError);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("discoverCandidates throws the typed error with no capability", async () => {
    await expect(
      discoverCandidates({
        graph: {
          brief: "b",
          domain: "d",
          capabilities: [],
          open_questions: [],
        },
      }),
    ).rejects.toBeInstanceOf(MissingResearchCapabilityError);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it("acquireContracts throws the typed error with no capability", async () => {
    await expect(
      acquireContracts({
        candidates: [],
        graph: {
          brief: "b",
          domain: "d",
          capabilities: [],
          open_questions: [],
        },
      }),
    ).rejects.toBeInstanceOf(MissingResearchCapabilityError);
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe("the pure stages run keyless without the seam", () => {
  it("completenessCheck flags an uncovered core capability as blocking", () => {
    const report = completenessCheck({
      graph: {
        brief: "b",
        domain: "d",
        capabilities: [
          {
            id: "cap.core",
            verb: "v",
            acceptance: "a",
            necessity: "core",
          },
        ],
        open_questions: [],
      },
      dossiers: [],
      iterations: 0,
    });
    expect(report.gaps.some((g) => g.blocking && g.kind === "coverage")).toBe(
      true,
    );
    expect(report.status).not.toBe("complete");
  });

  it("reviewBusinessRules drops a rule the reviewer rejects", async () => {
    const stripe = REFUND_DOSSIERS.find((d) => d.tool_id === "stripe_payments");
    expect(stripe).toBeDefined();
    const { dossiers, reviews } = await reviewBusinessRules({
      dossiers: [stripe!],
      reviewProvider: async (rule) => ({
        tool_id: rule.tool_id,
        rule_id: rule.rule_id,
        disposition: rule.rule_id === "refund_window_30d" ? "drop" : "keep",
      }),
    });
    const createRefund = dossiers[0]!.operations.find(
      (op) => op.op_id === "create_refund",
    );
    const ruleIds = createRefund!.business_rules_not_enforced.map((r) => r.id);
    expect(ruleIds).not.toContain("refund_window_30d");
    expect(reviews.some((r) => r.disposition === "drop")).toBe(true);
    // The drop did not mutate the committed dossier in place.
    const original = stripe!.operations.find(
      (op) => op.op_id === "create_refund",
    );
    expect(
      original!.business_rules_not_enforced.map((r) => r.id),
    ).toContain("refund_window_30d");
  });

  it("commitResearchBundle is pure and content-addresses its body", () => {
    const bundle = commitResearchBundle({
      pack_id: "p",
      brief: "b",
      capability_graph: {
        brief: "b",
        domain: "d",
        capabilities: [],
        open_questions: [],
      },
      committed_tools: [],
      dossiers: [],
      ground_truth_policies: [],
      completeness: { status: "complete", iterations: 0, gaps: [] },
      rule_reviews: [],
      origin: "reproduction",
    });
    expect(bundle.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(querySpy).not.toHaveBeenCalled();
  });
});
