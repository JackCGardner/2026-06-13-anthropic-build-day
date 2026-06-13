// The seams: the interfaces that let a deterministic, keyless implementation
// and a future live implementation be interchangeable. A ScriptedHarness and a
// LiveHarness implement the same Harness contract; a deterministic ToolKernel
// and an LLM-persona kernel implement the same call signature; the CxScorer is
// a deterministic stub now and a live LLM call later.

import type { EgressRequest, ToolResponse } from "./egress.js";
import type { WorldState } from "./state.js";
import type { TraceEvent, HarnessVersion } from "./trace.js";
import type { Fixture } from "./scenario.js";

// A Tool Agent in M0: a pure-ish function of its scoped state and the request.
// It enforces only the dossier's enforcedInvariants, mutates state through the
// store, and returns a ToolResponse whose state_mutations echo every delta.
export type ToolKernel = (
  req: EgressRequest,
  state: WorldState,
) => ToolResponse;

// The bash substrate: a real microVM later, a deterministic stand-in now. The
// signature matches the Vercel Sandbox runCommand surface the live path uses.
export interface BashSubstrate {
  runCommand(input: {
    cmd: string;
    args: string[];
  }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

// The agent under test. A ScriptedHarness issues the same tool calls a naive
// v1 or tightened v2 harness would, with no LLM; a LiveHarness drives a real
// query() agent. Both yield the same trace events for one fixture.
export interface Harness {
  id: string;
  version: HarnessVersion;
  run(fixture: Fixture, world: WorldRunnerHandle): Promise<TraceEvent[]>;
}

// The handle the World Runner gives a harness for one fixture: the trace
// writer, the bash door, and the egress dispatch into the tool kernels. This
// is the single surface a harness touches, so scripted and live harnesses are
// interchangeable without either reaching into runner internals.
export interface WorldRunnerHandle {
  runId: string;
  fixtureId: string;
  harnessVersion: HarnessVersion;
  // Append one event to the trace; the runner assigns seq and ts.
  emit(event: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">): TraceEvent;
  // The bash door into the substrate.
  bash: BashSubstrate;
  // Structured dispatch to a tool kernel via the gateway, with state scoping.
  dispatch(req: EgressRequest): ToolResponse;
}

// The customer-experience scorer seam. The deterministic stub returns a fixed
// score with a templated rationale now; the live implementation makes one
// temperature-0 Claude call later. Both share this signature so the Judge does
// not change when the implementation is swapped.
export interface CxScorerInput {
  fixtureId: string;
  // The relevant slice of trace for the legitimate refund being scored.
  events: TraceEvent[];
}
export interface CxScorerResult {
  score: number;
  rationale: string;
}
export type CxScorer = (input: CxScorerInput) => Promise<CxScorerResult>;
