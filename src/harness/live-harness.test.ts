// Keyless tests for the live harness wiring. They prove the live path is built
// and inspectable with no model credential and no network: the credential guard
// throws MissingApiKeyError before any API call, construction fills the Harness
// seam and loads the spec, and the consistency gates accept the pinned specs the
// live harness is built from while rejecting a leaky one. None of these tests
// reach the network; the model is never called.

import { describe, it, expect } from "vitest";

import type {
  Fixture,
  TraceEvent,
  WorldRunnerHandle,
} from "@/engine";
import { REFUND_DOSSIERS, REFUND_PACK_ID } from "@/scenarios/refund/index.js";
import {
  createLiveHarness,
  hasModelCredential,
  MissingApiKeyError,
  loadPinnedRefundSpec,
  buildWorldManifest,
  runConsistencyGates,
  REFUND_HARNESS_SPEC_V1,
  REFUND_HARNESS_SPEC_V2,
  type HarnessSpec,
  type GenerationOutput,
} from "./index.js";

// A fixture is the only argument run() needs beyond the world handle. A minimal
// shape is enough: the live harness reads the visible ticket to build the prompt
// and never consults ground truth.
function fakeFixture(): Fixture {
  return {
    id: "out_of_window",
    ticket: {
      id: "tkt_1",
      subject: "Refund please",
      customer_email: "buyer@example.com",
      order_id: "ord_1",
      body: "I would like a refund for my order.",
    },
    visible_state: {},
    hidden_state: {},
  } as unknown as Fixture;
}

// A world handle that records emitted events and fails loudly if the world is
// ever driven. Because the credential guard runs first, run() throws before any
// of these are touched when no credential is present.
function fakeHandle(): WorldRunnerHandle {
  const events: TraceEvent[] = [];
  let seq = 0;
  return {
    runId: "run_test",
    fixtureId: "out_of_window",
    harnessVersion: "v1",
    emit: (event) => {
      const full: TraceEvent = {
        v: 1,
        run_id: "run_test",
        seq: seq++,
        ts: new Date(0).toISOString(),
        ...event,
      };
      events.push(full);
      return full;
    },
    bash: {
      async runCommand() {
        throw new Error("substrate must not run in a keyless test");
      },
    },
    dispatch: () => {
      throw new Error("dispatch must not run in a keyless test");
    },
  };
}

function outputFor(spec: HarnessSpec): GenerationOutput {
  return { spec, world: buildWorldManifest(REFUND_PACK_ID, REFUND_DOSSIERS) };
}

// A credential-free environment for the keyless tests. The project's ProcessEnv
// type carries required keys (e.g. NODE_ENV), so an env is built from those keys
// with every model credential explicitly cleared.
function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_AGENT_SDK_AMBIENT_AUTH: undefined,
    ...overrides,
  };
}
const NO_KEY = envWith();

describe("hasModelCredential", () => {
  it("is false for a credential-free environment", () => {
    expect(hasModelCredential(NO_KEY)).toBe(false);
  });

  it("is true when ANTHROPIC_API_KEY is set", () => {
    expect(hasModelCredential(envWith({ ANTHROPIC_API_KEY: "sk-test" }))).toBe(
      true,
    );
  });

  it("is true under an asserted ambient Claude Code login", () => {
    expect(
      hasModelCredential(envWith({ CLAUDE_AGENT_SDK_AMBIENT_AUTH: "1" })),
    ).toBe(true);
  });
});

describe("live harness: no-key guard", () => {
  it("throws MissingApiKeyError from run() when no credential is present", async () => {
    const harness = createLiveHarness({
      spec: loadPinnedRefundSpec("v1"),
      version: "v1",
      env: NO_KEY,
    });
    await expect(harness.run(fakeFixture(), fakeHandle())).rejects.toBeInstanceOf(
      MissingApiKeyError,
    );
  });

  it("never emits a trace event or drives the world before failing", async () => {
    const handle = fakeHandle();
    const harness = createLiveHarness({
      spec: loadPinnedRefundSpec("v1"),
      env: NO_KEY,
    });
    await expect(harness.run(fakeFixture(), handle)).rejects.toBeInstanceOf(
      MissingApiKeyError,
    );
    // The fakeHandle's bash.runCommand and dispatch throw if touched; reaching
    // here proves the guard ran before any world interaction.
  });
});

describe("live harness: construction wires the seam and the spec", () => {
  it("fills the Harness seam from the pinned v1 spec without calling the model", () => {
    const harness = createLiveHarness({
      spec: loadPinnedRefundSpec("v1"),
      env: NO_KEY,
    });
    expect(harness.id).toBe("live-refund-harness-v1");
    expect(harness.version).toBe("v1");
    expect(typeof harness.run).toBe("function");
  });

  it("defaults the version to the spec's version and honors an override", () => {
    const fromSpec = createLiveHarness({
      spec: loadPinnedRefundSpec("v2"),
      env: NO_KEY,
    });
    expect(fromSpec.version).toBe(REFUND_HARNESS_SPEC_V2.version);

    const overridden = createLiveHarness({
      spec: loadPinnedRefundSpec("v1"),
      version: "v2",
      env: NO_KEY,
    });
    expect(overridden.version).toBe("v2");
  });

  it("constructs both v1 and v2 live harnesses keyless and keeps them distinct", () => {
    const v1 = createLiveHarness({ spec: loadPinnedRefundSpec("v1"), env: NO_KEY });
    const v2 = createLiveHarness({ spec: loadPinnedRefundSpec("v2"), env: NO_KEY });
    expect(v1.id).toBe("live-refund-harness-v1");
    expect(v2.id).toBe("live-refund-harness-v2");
    expect(v1.id).not.toBe(v2.id);
  });
});

describe("live harness: the specs it is built from pass the consistency gates", () => {
  it("the pinned v1 spec passes every gate", () => {
    const result = runConsistencyGates(
      outputFor(REFUND_HARNESS_SPEC_V1),
      REFUND_DOSSIERS,
    );
    expect(result.ok).toBe(true);
  });

  it("the pinned v2 spec passes every gate", () => {
    const result = runConsistencyGates(
      outputFor(REFUND_HARNESS_SPEC_V2),
      REFUND_DOSSIERS,
    );
    expect(result.ok).toBe(true);
  });

  it("a leaky spec the live harness must never run fails the leak gate", () => {
    const leaky: HarnessSpec = {
      ...REFUND_HARNESS_SPEC_V1,
      id: "refund-harness-leaky",
      procedure: [
        "Read the ticket to understand the customer's request.",
        "Remember: refunds only within 30 days of purchase.",
        "Issue the requested refund through the billing API.",
      ],
    };
    const result = runConsistencyGates(outputFor(leaky), REFUND_DOSSIERS);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.gate === "leak")).toBe(true);
  });
});
