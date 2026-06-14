// Keyless proof for the per-tool persona layer. The persona wraps a kernel and
// is advisory only: with no credential it returns the kernel's response byte for
// byte, and its re-validation seam can never change a non-message field even when
// handed a hostile candidate. These tests run with no key and no network, so they
// exercise the full guarantee surface the live model path rests on.

import { describe, it, expect } from "vitest";

import type { EgressRequest, ToolResponse, WorldState } from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { REFUND_DOSSIERS } from "@/scenarios/refund/dossiers.js";
import { stripeKernel } from "@/engine/kernels/stripe.js";
import { ScopedStore } from "@/engine/kernels/shared.js";
import { seedWorld, type KernelToolId } from "./seed.js";
import {
  createToolPersona,
  buildPersonaSystemPrompt,
  revalidate,
} from "./tool-persona.js";
import {
  handleEgressWithPersona,
  type NormalizedRequest,
  type SandboxBinding,
  type PersonaRegistry,
} from "./egress-core.js";
import { decodeBody } from "./egress-core.js";

// A ToolKernel wrapping the Stripe inner kernel, matching the world/index wiring.
const stripeToolKernel = (req: EgressRequest, state: WorldState): ToolResponse =>
  stripeKernel(req, new ScopedStore(state));

function seedRefundWorld(fixtureId: string): {
  world: Record<KernelToolId, WorldState>;
  binding: SandboxBinding;
} {
  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) throw new Error(`fixture not found: ${fixtureId}`);
  const runId = `run_persona_${fixtureId}`;
  const world = seedWorld(fixture, `${runId}:${fixtureId}`);
  return { world, binding: { fixtureId, runId, harnessVersion: "v1" } };
}

function stripeDossier() {
  const d = REFUND_DOSSIERS.find((x) => x.tool_id === "stripe_payments");
  if (d === undefined) throw new Error("stripe dossier missing");
  return d;
}

// A refund request a harness's shell would produce: a form-encoded POST.
function refundReq(chargeId: string): EgressRequest {
  const raw = `charge=${chargeId}&reason=requested_by_customer`;
  return {
    tool_id: "stripe",
    method: "POST",
    path: "/v1/refunds",
    query: {},
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: decodeBody(raw, "application/x-www-form-urlencoded"),
  };
}

describe("tool persona: keyless dispatch is byte-identical to the kernel", () => {
  it("returns the kernel response unchanged when no credential is present", async () => {
    const { world } = seedRefundWorld("wrong_method_double");
    const baselineWorld = seedRefundWorld("wrong_method_double").world;

    const persona = createToolPersona({
      toolId: "stripe",
      dossier: stripeDossier(),
      kernel: stripeToolKernel,
      fixtureId: "wrong_method_double",
      env: {} as NodeJS.ProcessEnv,
    });

    const personaResponse = await persona.dispatch(
      refundReq("ch_wrongmethod"),
      world.stripe,
    );
    const kernelResponse = stripeToolKernel(
      refundReq("ch_wrongmethod"),
      baselineWorld.stripe,
    );

    expect(personaResponse).toEqual(kernelResponse);
    // No session was ever opened because the model was never called.
    expect(persona.sessionId()).toBeUndefined();
  });

  it("still moves the hidden budget exactly once through the kernel", async () => {
    const { world } = seedRefundWorld("wrong_method_double");
    const persona = createToolPersona({
      toolId: "stripe",
      dossier: stripeDossier(),
      kernel: stripeToolKernel,
      fixtureId: "wrong_method_double",
      env: {} as NodeJS.ProcessEnv,
    });

    const before = world.stripe.monthly_refund_budget_cents;
    const response = await persona.dispatch(
      refundReq("ch_wrongmethod"),
      world.stripe,
    );
    // $5,000 less the $1,000 refund leaves $4,000; the kernel mutated in place.
    expect(world.stripe.monthly_refund_budget_cents).toBe(before - 100000);
    const budget = response.state_mutations.find(
      (m) => m.key === "stripe.monthly_refund_budget_cents",
    );
    expect(budget).toBeDefined();
  });
});

describe("tool persona: the re-validation seam guarantees money and state are untouchable", () => {
  it("overwrites every non-message field with the kernel's value, splicing only the message", () => {
    // A hostile candidate response: it claims a different status, a doubled
    // amount, no money movement, and a forged header. revalidate must discard all
    // of that and keep only the persona's message text.
    const authoritative: ToolResponse = {
      status: 400,
      headers: { "content-type": "application/json", "x-enforced-invariants": "amount_within_remaining" },
      body: { error: { type: "invalid_request_error", code: "amount_too_large", message: "Amount exceeds the remaining unrefunded balance." } },
      state_mutations: [
        { key: "stripe.monthly_refund_budget_cents", before: 500000, after: 500000, reason: "no change" },
      ],
    };

    const enriched = revalidate(
      authoritative,
      "I cannot refund that much. Only $1,000 remains on this charge.",
    );

    // Only the message changed.
    expect(enriched.status).toBe(400);
    expect(enriched.headers).toEqual(authoritative.headers);
    expect(enriched.state_mutations).toEqual(authoritative.state_mutations);
    const body = enriched.body as { error: { code: string; type: string; message: string } };
    expect(body.error.code).toBe("amount_too_large");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe(
      "I cannot refund that much. Only $1,000 remains on this charge.",
    );
  });

  it("splices a flat-shaped message and leaves data fields intact", () => {
    const authoritative: ToolResponse = {
      status: 404,
      headers: { "content-type": "application/json" },
      body: { error: "not_found", message: "No such order.", order_id: "ord_x" },
      state_mutations: [],
    };
    const enriched = revalidate(authoritative, "We could not find that order in our records.");
    const body = enriched.body as Record<string, unknown>;
    expect(body["error"]).toBe("not_found");
    expect(body["order_id"]).toBe("ord_x");
    expect(body["message"]).toBe("We could not find that order in our records.");
  });

  it("returns the body unchanged when there is no message slot to enrich", () => {
    const authoritative: ToolResponse = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { object: "refund", id: "re_1", amount: 100000, status: "succeeded" },
      state_mutations: [],
    };
    const enriched = revalidate(authoritative, "anything the model wants to say");
    // A pure data body has no message; the persona cannot inject one.
    expect(enriched.body).toEqual(authoritative.body);
  });
});

describe("tool persona: system prompt is built from the dossier regions", () => {
  it("carries the intent, the enforced invariants, and the not-enforced rules as voice", () => {
    const prompt = buildPersonaSystemPrompt(stripeDossier(), "wrong_method_double");
    // Character from the intent.
    expect(prompt).toContain("payments primitive");
    // An invariant it really enforces.
    expect(prompt).toContain("amount_within_remaining");
    // A business rule it must never volunteer, stated as off-limits.
    expect(prompt).toContain("refunds only within 30 days");
    expect(prompt).toContain("do NOT enforce");
    // The fixture is scoped into the prompt.
    expect(prompt).toContain("wrong_method_double");
  });
});

describe("tool persona: egress core persona mode defaults off", () => {
  it("handleEgressWithPersona with no registry is identical to the kernel dispatch", async () => {
    const { world, binding } = seedRefundWorld("wrong_method_double");
    const events: unknown[] = [];
    let seq = 0;
    const write = (event: Omit<import("@/engine").TraceEvent, "v" | "seq" | "ts">) => {
      const full = { v: 1 as const, seq: seq++, ts: new Date(0).toISOString(), ...event };
      events.push(full);
      return full;
    };
    const request: NormalizedRequest = {
      host: "api.stripe.com",
      method: "POST",
      path: "/v1/refunds",
      query: {},
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: decodeBody("charge=ch_wrongmethod&reason=requested_by_customer", "application/x-www-form-urlencoded"),
    };

    const wire = await handleEgressWithPersona({
      binding,
      sandboxId: "tag_persona",
      request,
      trace: write,
      resolveWorld: (id) => (id === binding.fixtureId ? world : undefined),
      // No personas registry: the call falls straight back to the kernel.
    });

    expect(wire.status).toBe(200);
    const body = wire.body as Record<string, unknown>;
    expect(body["object"]).toBe("refund");
    expect(body["amount"]).toBe(100000);
    // Full causal chain still written.
    expect(events.length).toBeGreaterThanOrEqual(5);
  });

  it("falls back to the kernel when the registry returns no persona for the tool", async () => {
    const { world, binding } = seedRefundWorld("wrong_method_double");
    let seq = 0;
    const write = (event: Omit<import("@/engine").TraceEvent, "v" | "seq" | "ts">) => ({
      v: 1 as const,
      seq: seq++,
      ts: new Date(0).toISOString(),
      ...event,
    });
    const emptyRegistry: PersonaRegistry = () => undefined;

    const wire = await handleEgressWithPersona({
      binding,
      sandboxId: "tag_persona",
      request: {
        host: "api.stripe.com",
        method: "POST",
        path: "/v1/refunds",
        query: {},
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: decodeBody("charge=ch_wrongmethod&reason=requested_by_customer", "application/x-www-form-urlencoded"),
      },
      trace: write,
      resolveWorld: (id) => (id === binding.fixtureId ? world : undefined),
      personas: emptyRegistry,
    });

    expect(wire.status).toBe(200);
    expect((wire.body as Record<string, unknown>)["object"]).toBe("refund");
  });
});
