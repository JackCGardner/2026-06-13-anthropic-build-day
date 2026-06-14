// Loan harness tests. Keyless: they exercise the loan harness spec, the loan
// function tools dispatching in-process through the generic kernels, the decision
// capture, and the loan terminal-decision derivation, all without a model or a
// credential. The live model call itself is the only thing not covered here; it
// is gated by the same credential guard the refund live harness uses.

import { describe, it, expect } from "vitest";

import type {
  EgressRequest,
  ToolResponse,
  TraceEvent,
  WorldRunnerHandle,
} from "@/engine";
import {
  LOAN_HARNESS_SPEC_SEED,
  loadLoanHarnessSpec,
  buildLoanFunctionTools,
  loanQualifiedToolName,
  LOAN_DECISION_KEY_PREFIX,
} from "./index.js";
import { createLiveLoanHarness } from "./loan-live-harness.js";
import {
  buildLoanKernels,
  seedLoanWorld,
  createLoanApplicantWorld,
} from "@/world/loan-world.js";
import { deriveLoanTerminalDecision } from "@/engine/loan-terminal-decision.js";
import { loadLoanPack } from "@/scenarios/loan/index.js";

const pack = loadLoanPack();
const applicant = pack.applicants[0]!;

// A credential-free environment for the keyless tests. The project's ProcessEnv
// type carries required keys, so it is built from process.env with every model
// credential explicitly cleared.
const NO_KEY: NodeJS.ProcessEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
  CLAUDE_AGENT_SDK_AMBIENT_AUTH: undefined,
};

// A minimal handle over an in-memory trace buffer, wired to one applicant's loan
// world, the same shape the evaluate bridge builds for a per-applicant run.
function makeWiredHandle(applicantId: string): {
  handle: WorldRunnerHandle;
  events: TraceEvent[];
} {
  const events: TraceEvent[] = [];
  const kernels = buildLoanKernels(pack);
  const state = seedLoanWorld(pack, applicant);
  const world = createLoanApplicantWorld(kernels, state);
  let seq = 0;
  const emit = (
    e: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">,
  ): TraceEvent => {
    const full: TraceEvent = {
      v: 1,
      run_id: "test",
      seq: seq++,
      ts: "2026-06-14T00:00:00.000Z",
      ...e,
    };
    events.push(full);
    return full;
  };
  const handle: WorldRunnerHandle = {
    runId: "test",
    fixtureId: applicantId,
    harnessVersion: "v2",
    emit,
    bash: {
      async runCommand() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    dispatch: (req: EgressRequest): ToolResponse => world.dispatch(handle, req),
  };
  return { handle, events };
}

// Invoke a built function tool by name with the given args, returning its text.
async function callTool(
  built: ReturnType<typeof buildLoanFunctionTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const entry = built.find((b) => b.qualifiedName === loanQualifiedToolName(name));
  if (entry === undefined) throw new Error(`tool ${name} not built`);
  // The SDK tool definition carries its handler under .handler; call it directly.
  const def = entry.tool as unknown as {
    handler: (
      args: unknown,
      extra: unknown,
    ) => Promise<{ content: Array<{ text: string }>; isError: boolean }>;
  };
  const result = await def.handler(args, {});
  return { text: result.content[0]!.text, isError: result.isError };
}

describe("loan harness spec", () => {
  it("validates the seed spec and exposes the optimizable surface", () => {
    const spec = loadLoanHarnessSpec(LOAN_HARNESS_SPEC_SEED);
    expect(spec.system_prompt.length).toBeGreaterThan(0);
    expect(spec.procedure.length).toBeGreaterThan(0);
    // Five read tools, one per loan dossier.
    expect(spec.tool_manifest).toHaveLength(5);
    const ids = spec.tool_manifest.map((t) => t.tool_id).sort();
    expect(ids).toEqual([
      "application",
      "bank_transactions",
      "credit_bureau",
      "fraud_signal",
      "lending_guidelines",
    ]);
  });

  it("rejects a malformed candidate spec", () => {
    expect(() => loadLoanHarnessSpec({ id: "x" })).toThrow();
  });

  it("constructs a live harness keylessly without calling the model", () => {
    // Construction is keyless; only run() needs a credential. The factory must
    // not throw with no key present at build time.
    const harness = createLiveLoanHarness({
      spec: LOAN_HARNESS_SPEC_SEED,
      maxTurns: 4,
      env: NO_KEY,
    });
    expect(harness.model).toBe(LOAN_HARNESS_SPEC_SEED.model);
  });

  it("run() throws MissingApiKeyError with no credential, touching no network", async () => {
    const harness = createLiveLoanHarness({
      spec: LOAN_HARNESS_SPEC_SEED,
      env: NO_KEY,
    });
    const { handle } = makeWiredHandle(applicant.applicant_id);
    await expect(harness.run(applicant, handle)).rejects.toThrow(
      /credential/i,
    );
  });
});

describe("loan function tools dispatch through the generic kernels", () => {
  it("each read tool returns the seeded record for the applicant", async () => {
    const { handle, events } = makeWiredHandle(applicant.applicant_id);
    const built = buildLoanFunctionTools(
      LOAN_HARNESS_SPEC_SEED,
      applicant.applicant_id,
      handle,
    );

    const app = await callTool(built, "read_application", {});
    expect(app.isError).toBe(false);
    expect(app.text).toContain("principal_cents");

    const credit = await callTool(built, "pull_credit_report", {});
    expect(credit.isError).toBe(false);
    expect(credit.text).toContain("credit_score");

    const bank = await callTool(built, "analyze_bank_transactions", {});
    expect(bank.isError).toBe(false);
    expect(bank.text).toContain("observed_monthly_income_cents");

    const fraud = await callTool(built, "check_fraud_signal", {});
    expect(fraud.isError).toBe(false);
    expect(fraud.text).toContain("fraud_score");

    const guidelines = await callTool(built, "read_lending_guidelines", {});
    expect(guidelines.isError).toBe(false);
    expect(guidelines.text.toLowerCase()).toContain("lending");

    // Each read wrote a tool_dispatch the judge counts as a distinct signal.
    const dispatched = new Set(
      events
        .filter((e) => e.kind === "tool_dispatch" && e.span.phase === "begin")
        .map((e) => (e.payload as { tool_id: string }).tool_id),
    );
    expect(dispatched.size).toBe(5);
  });

  it("the read tools embed no protected-class gate: the attribute is returned, not acted on", async () => {
    const { handle } = makeWiredHandle(applicant.applicant_id);
    const built = buildLoanFunctionTools(
      LOAN_HARNESS_SPEC_SEED,
      applicant.applicant_id,
      handle,
    );
    const app = await callTool(built, "read_application", {});
    // The application read returns the group attribute faithfully; the fairness
    // trap is that the signal is present and must not drive the decision.
    expect(app.text).toContain("protected_class");
  });
});

describe("submit_decision capture and terminal-decision derivation", () => {
  it("records the decision as a state_mutation the derivation reads back", async () => {
    const { handle, events } = makeWiredHandle(applicant.applicant_id);
    const built = buildLoanFunctionTools(
      LOAN_HARNESS_SPEC_SEED,
      applicant.applicant_id,
      handle,
    );

    await callTool(built, "submit_decision", {
      decision: "counter_offer",
      rationale: "Marginal credit score; counter at reduced exposure.",
    });

    const mutation = events.find(
      (e) =>
        e.kind === "state_mutation" &&
        (e.payload as { key: string }).key ===
          `${LOAN_DECISION_KEY_PREFIX}:${applicant.applicant_id}`,
    );
    expect(mutation).toBeDefined();

    const derived = deriveLoanTerminalDecision(
      applicant.applicant_id,
      events,
    );
    expect(derived.decision).toBe("counter_offer");
    expect(derived.rationale).toContain("reduced exposure");
  });

  it("a re-submitted decision resolves to the final action", async () => {
    const { handle, events } = makeWiredHandle(applicant.applicant_id);
    const built = buildLoanFunctionTools(
      LOAN_HARNESS_SPEC_SEED,
      applicant.applicant_id,
      handle,
    );
    await callTool(built, "submit_decision", {
      decision: "approve",
      rationale: "Strong file.",
    });
    await callTool(built, "submit_decision", {
      decision: "decline",
      rationale: "On reflection, cashflow is too thin.",
    });
    const derived = deriveLoanTerminalDecision(applicant.applicant_id, events);
    expect(derived.decision).toBe("decline");
  });

  it("falls back to a conservative decline with no rationale when nothing was submitted", () => {
    const derived = deriveLoanTerminalDecision("app_unknown", []);
    expect(derived.decision).toBe("decline");
    expect(derived.rationale).toBe("");
  });
});
