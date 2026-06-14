// Keyless gating proof for the two model-backed paths added in this milestone:
// the LLM-backed Bash substrate and the per-tool persona layer. With no model
// credential present, neither path may reach the network. The Agent SDK's query
// is replaced with a spy that throws the moment it is invoked, so any attempt to
// open a session fails this test loudly. The substrate must instead raise a typed
// MissingApiKeyError at construction, and the persona must fall back to the kernel
// response, both without ever calling query.

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { EgressRequest, ToolResponse, WorldState } from "@/engine";
import { stripeKernel } from "@/engine/kernels/stripe.js";
import { ScopedStore } from "@/engine/kernels/shared.js";
import { REFUND_DOSSIERS } from "@/scenarios/refund/dossiers.js";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { seedWorld, type KernelToolId } from "./seed.js";
import { decodeBody } from "./egress-core.js";

// Replace the Agent SDK so any network-bound call is observable. The query mock
// throws if it is ever invoked: a keyless path that reaches it fails the test,
// which is the no-network guarantee restated as an assertion. The spy is created
// inside vi.hoisted so it exists when the hoisted vi.mock factory runs.
const { querySpy } = vi.hoisted(() => ({
  querySpy: vi.fn(() => {
    throw new Error("query() was called on a keyless path");
  }),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: querySpy,
}));

// Imported after the mock is registered so both modules bind to the spied query.
import { createLlmBashSubstrate, MissingApiKeyError } from "./bash-llm.js";
import { createToolPersona } from "./tool-persona.js";

// An environment with no model credential of any accepted kind.
const KEYLESS_ENV = {} as NodeJS.ProcessEnv;

const stripeToolKernel = (req: EgressRequest, state: WorldState): ToolResponse =>
  stripeKernel(req, new ScopedStore(state));

function stripeDossier() {
  const d = REFUND_DOSSIERS.find((x) => x.tool_id === "stripe_payments");
  if (d === undefined) throw new Error("stripe dossier missing");
  return d;
}

function refundReq(chargeId: string): EgressRequest {
  return {
    tool_id: "stripe",
    method: "POST",
    path: "/v1/refunds",
    query: {},
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: decodeBody(
      `charge=${chargeId}&reason=requested_by_customer`,
      "application/x-www-form-urlencoded",
    ),
  };
}

function seedStripeWorld(fixtureId: string): Record<KernelToolId, WorldState> {
  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) throw new Error(`fixture not found: ${fixtureId}`);
  return seedWorld(fixture, `run_keyless_${fixtureId}:${fixtureId}`);
}

beforeEach(() => {
  querySpy.mockClear();
});

describe("LLM-bash substrate gates on the credential before any network call", () => {
  it("throws MissingApiKeyError at construction with no key", () => {
    expect(() =>
      createLlmBashSubstrate({ sandboxTag: "tag_keyless", env: KEYLESS_ENV }),
    ).toThrow(MissingApiKeyError);
  });

  it("never invokes the SDK query when constructed keyless", () => {
    try {
      createLlmBashSubstrate({ sandboxTag: "tag_keyless", env: KEYLESS_ENV });
    } catch {
      // expected: the constructor's auth gate fires before query is reached.
    }
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe("persona path is silent and makes no network call with no key", () => {
  it("returns the kernel response and never opens a session", async () => {
    const world = seedStripeWorld("wrong_method_double");
    const baseline = seedStripeWorld("wrong_method_double");

    const persona = createToolPersona({
      toolId: "stripe",
      dossier: stripeDossier(),
      kernel: stripeToolKernel,
      fixtureId: "wrong_method_double",
      env: KEYLESS_ENV,
    });

    const fromPersona = await persona.dispatch(
      refundReq("ch_wrongmethod"),
      world.stripe,
    );
    const fromKernel = stripeToolKernel(
      refundReq("ch_wrongmethod"),
      baseline.stripe,
    );

    // The keyless persona dispatch is byte-identical to the raw kernel call.
    expect(fromPersona).toEqual(fromKernel);
    // No session was opened and the SDK query was never reached.
    expect(persona.sessionId()).toBeUndefined();
    expect(querySpy).not.toHaveBeenCalled();
  });
});
