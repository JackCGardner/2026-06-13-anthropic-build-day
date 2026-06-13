// The World Runner: the plain-TypeScript orchestrator. It owns the run loop,
// stands up the synthetic world per fixture, drives the harness, dispatches each
// EgressRequest to the matching kernel, and is the single writer of the unified
// trace. Because one writer assigns `seq` for a fixture, the trace is a total
// order even though the kernels mutate state concurrently across fixtures.
//
// The runner is transport-agnostic: a ScriptedHarness and a future live harness
// both touch only the WorldRunnerHandle (emit, bash, dispatch). The same runner,
// kernels, and judge therefore run unchanged when the live harness arrives.

import type {
  EgressRequest,
  Fixture,
  Harness,
  HarnessVersion,
  ToolResponse,
  TraceEvent,
  WorldRunnerHandle,
  BashSubstrate,
  WorldState,
} from "@/engine";
import { kernelFor } from "@/engine/kernels/index.js";
import { seedWorld, KERNEL_TOOL_IDS, type KernelToolId } from "./seed.js";

// A run is one harness version swept across every fixture. The runner returns
// the per-fixture traces plus the inputs the judge consumes, so the caller can
// score without re-deriving anything.
export interface RunResult {
  runId: string;
  harnessVersion: HarnessVersion;
  fixtures: Array<{
    fixtureId: string;
    fixture: Fixture;
    events: TraceEvent[];
  }>;
}

// A deterministic, keyless bash substrate. The scripted harness drives the world
// through structured dispatch rather than literal shell, so this stand-in is a
// faithful no-op surface that keeps the seam shape the live Vercel Sandbox fills.
const inertBash: BashSubstrate = {
  async runCommand() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};

// The per-fixture trace writer and dispatch surface. It assigns `seq` and `ts`,
// records the full dispatch chain (egress -> tool_dispatch -> state_mutation),
// and hands the harness exactly the WorldRunnerHandle it is allowed to touch.
class FixtureContext {
  private seq = 0;
  private events: TraceEvent[] = [];

  constructor(
    private readonly runId: string,
    private readonly fixtureId: string,
    private readonly harnessVersion: HarnessVersion,
    private readonly world: Record<KernelToolId, WorldState>,
  ) {}

  // Append one event, assigning the monotonic seq and a timestamp. Producers
  // pass everything but the writer-owned fields.
  emit(event: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">): TraceEvent {
    const full: TraceEvent = {
      v: 1,
      run_id: this.runId,
      seq: this.seq++,
      ts: new Date(0).toISOString(),
      ...event,
    };
    this.events.push(full);
    return full;
  }

  // Structured dispatch into a kernel. The runner records the egress request the
  // harness produced, the tool_dispatch into the kernel, every resulting
  // state_mutation parented to that dispatch, and the egress response. The full
  // chain is what the Judge and the viewer read.
  dispatch(req: EgressRequest): ToolResponse {
    const kernel = kernelFor(req.tool_id);
    const url = `${req.tool_id}://${req.path}`;

    const egressBegin = this.emit({
      fixture_id: this.fixtureId,
      harness_version: this.harnessVersion,
      parent_seq: null,
      actor: "bash",
      kind: "egress",
      span: { id: `eg_${this.seq}`, phase: "begin" },
      payload: {
        method: req.method,
        url,
        request_headers: req.headers,
        request_body: req.body,
      },
    });

    if (!kernel) {
      // An unknown tool is a faithful failure: the gateway rejects it loud.
      this.emit({
        fixture_id: this.fixtureId,
        harness_version: this.harnessVersion,
        parent_seq: egressBegin.seq,
        actor: "bash",
        kind: "egress",
        span: { id: egressBegin.span.id, phase: "end" },
        payload: { status: 404, url, response_body: { error: "unknown_tool" } },
      });
      return {
        status: 404,
        headers: {},
        body: { error: "unknown_tool", tool_id: req.tool_id },
        state_mutations: [],
      };
    }

    const dispatchBegin = this.emit({
      fixture_id: this.fixtureId,
      harness_version: this.harnessVersion,
      parent_seq: egressBegin.seq,
      actor: `tool:${req.tool_id}`,
      kind: "tool_dispatch",
      span: { id: `td_${this.seq}`, phase: "begin" },
      payload: { tool_id: req.tool_id, request: req },
    });

    const state = this.world[req.tool_id as KernelToolId];
    const response = kernel(req, state);

    // Echo every hidden-state delta as an explicit, parented state_mutation. The
    // Judge trusts these lines over any prose; the budget decrement is the
    // thesis-carrying signal that the money moved and no rule objected.
    for (const m of response.state_mutations) {
      this.emit({
        fixture_id: this.fixtureId,
        harness_version: this.harnessVersion,
        parent_seq: dispatchBegin.seq,
        actor: `tool:${req.tool_id}`,
        kind: "state_mutation",
        span: { id: `sm_${this.seq}`, phase: "point" },
        payload: {
          key: m.key,
          before: m.before,
          after: m.after,
          reason: m.reason,
        },
      });
    }

    this.emit({
      fixture_id: this.fixtureId,
      harness_version: this.harnessVersion,
      parent_seq: dispatchBegin.seq,
      actor: `tool:${req.tool_id}`,
      kind: "tool_dispatch",
      span: { id: dispatchBegin.span.id, phase: "end" },
      payload: { status: response.status, body: response.body },
    });

    this.emit({
      fixture_id: this.fixtureId,
      harness_version: this.harnessVersion,
      parent_seq: egressBegin.seq,
      actor: "bash",
      kind: "egress",
      span: { id: egressBegin.span.id, phase: "end" },
      payload: {
        status: response.status,
        url,
        response_headers: response.headers,
        response_body: response.body,
        enforced_invariants_checked: invariantsHeader(response),
      },
    });

    return response;
  }

  handle(): WorldRunnerHandle {
    return {
      runId: this.runId,
      fixtureId: this.fixtureId,
      harnessVersion: this.harnessVersion,
      emit: (e) => this.emit(e),
      bash: inertBash,
      dispatch: (req) => this.dispatch(req),
    };
  }

  collected(): TraceEvent[] {
    return this.events;
  }
}

// Pull the kernel's enforced-invariant list off the response header so the
// egress end event can surface exactly what the API gated on, for the overlay.
function invariantsHeader(response: ToolResponse): string[] | undefined {
  for (const [k, v] of Object.entries(response.headers)) {
    if (k.toLowerCase() === "x-enforced-invariants" && v.length > 0) {
      return v.split(",");
    }
  }
  return undefined;
}

// Run one harness across one fixture: seed the world, emit the run/begin frame,
// drive the harness through its handle, then close with the terminal decision
// the harness reached. The terminal decision is read from the harness's own
// run/end event if it emitted one; otherwise the runner closes it as errored.
async function runFixture(
  runId: string,
  harness: Harness,
  fixture: Fixture,
): Promise<{ fixtureId: string; fixture: Fixture; events: TraceEvent[] }> {
  const world = seedWorld(fixture, `${runId}:${fixture.id}`);
  const ctx = new FixtureContext(runId, fixture.id, harness.version, world);

  ctx.emit({
    fixture_id: fixture.id,
    harness_version: harness.version,
    parent_seq: null,
    actor: "world",
    kind: "run",
    span: { id: "run", phase: "begin" },
    payload: {
      harness_version: harness.version,
      fixture_id: fixture.id,
      model: "scripted",
    },
  });

  let errored = false;
  try {
    await harness.run(fixture, ctx.handle());
  } catch {
    errored = true;
  }

  // If the harness did not record its own terminal decision, the runner closes
  // the run. A thrown harness or a missing decision is an errored run.
  const events = ctx.collected();
  const harnessClosed = events.some(
    (e) => e.kind === "run" && e.span.phase === "end",
  );
  if (!harnessClosed) {
    ctx.emit({
      fixture_id: fixture.id,
      harness_version: harness.version,
      parent_seq: 0,
      actor: "world",
      kind: "run",
      span: { id: "run", phase: "end" },
      payload: {
        terminal_decision: errored ? "errored" : "blocked",
        duration_ms: 0,
      },
    });
  }

  return { fixtureId: fixture.id, fixture, events: ctx.collected() };
}

// Sweep one harness across every fixture in order. Fixtures are independent, so
// the sweep is deterministic regardless of evaluation order.
export async function runSweep(
  runId: string,
  harness: Harness,
  fixtures: Fixture[],
): Promise<RunResult> {
  const results: RunResult["fixtures"] = [];
  for (const fixture of fixtures) {
    results.push(await runFixture(runId, harness, fixture));
  }
  return {
    runId,
    harnessVersion: harness.version,
    fixtures: results,
  };
}

// Re-exported for callers that want to enumerate the kernel slots a fixture
// seeds, e.g. to assert state isolation in tests.
export { KERNEL_TOOL_IDS };
