// The loan synthetic world: seeding and in-process dispatch for one applicant.
// It is the loan analog of seed.ts plus the World Runner's dispatch chain, scoped
// to a single applicant and driven entirely through the generic kernel. Where the
// refund runner maps descriptive dossier ids to short hand-kernel ids and seeds a
// shared monthly budget, the loan world needs neither: every loan tool is served
// by createGenericKernel straight from its dossier, and the per-applicant hidden
// state is keyed exactly as the generic kernel reads it (report:{id},
// cashflow:{id}, application:{id}, signal:{id}, guidelines:body).
//
// One LoanApplicantWorld exposes a dispatch(req) that runs the matching dossier's
// generic kernel against the applicant's scoped slice and writes the same
// egress -> tool_dispatch -> state_mutation trace chain the runner writes, so the
// loan judge counts tool reads off the identical event shapes. The kernels are
// pure over their state, so repeated dispatch against the same applicant is
// deterministic.

import {
  type Applicant,
  type LoanScenarioPack,
} from "@/scenarios/loan/schema.js";
import { LENDING_GUIDELINES_MARKDOWN } from "@/scenarios/loan/guidelines.js";
import type {
  EgressRequest,
  ToolDossier,
  ToolKernel,
  ToolResponse,
  WorldRunnerHandle,
  WorldState,
} from "@/engine";
import { createGenericKernel } from "@/engine/kernels/index.js";

// The guidelines record key the lending_guidelines dossier serves as a singleton
// read. The population seeds the four id-keyed tools; the guidelines body is the
// one shared document, seeded here from the pack's markdown so the read tool
// stays a pure read with no embedded text.
const GUIDELINES_RECORD_KEY = "guidelines:body";

// One applicant's loan world: a generic kernel per dossier and a scoped
// WorldState per tool, with a dispatch surface that runs the right kernel and
// writes the trace chain through the run's handle.
export interface LoanApplicantWorld {
  dispatch(world: WorldRunnerHandle, req: EgressRequest): ToolResponse;
}

// Build the per-dossier generic kernels once for a pack. The kernels are pure
// functions of (request, state), so one set is reused across every applicant;
// only the seeded state differs per applicant.
export function buildLoanKernels(
  pack: LoanScenarioPack,
): Record<string, ToolKernel> {
  const kernels: Record<string, ToolKernel> = {};
  for (const dossier of pack.dossiers) {
    kernels[dossier.tool_id] = createGenericKernel(dossier as ToolDossier);
  }
  return kernels;
}

// Seed one applicant's scoped WorldState per loan dossier tool. The four id-keyed
// tools take their slice from the applicant's hidden_state verbatim; the
// guidelines tool is seeded from the shared markdown. Records are copied so a run
// never mutates the pack's seed objects (the loan reads mutate nothing, but the
// copy keeps the invariant the refund seeder also holds).
export function seedLoanWorld(
  pack: LoanScenarioPack,
  applicant: Applicant,
): Record<string, WorldState> {
  const world: Record<string, WorldState> = {};
  const seed = `loan:${applicant.applicant_id}`;

  for (const dossier of pack.dossiers) {
    const toolId = dossier.tool_id;
    const slice = applicant.hidden_state[toolId];
    const records: Record<string, Record<string, unknown>> = {};

    if (slice) {
      for (const [key, value] of Object.entries(slice.records)) {
        records[key] = { ...value };
      }
    }

    // The guidelines tool serves the one shared document; seed it if the
    // applicant slice did not carry it (the population keys the id tools, not the
    // guidelines body).
    if (toolId === "lending_guidelines" && records[GUIDELINES_RECORD_KEY] === undefined) {
      records[GUIDELINES_RECORD_KEY] = { body: LENDING_GUIDELINES_MARKDOWN };
    }

    world[toolId] = {
      fixture_id: applicant.applicant_id,
      tool_id: toolId,
      seed,
      version: 0,
      records,
      idempotency: {},
      counters: {},
      // The loan tools move no money; the budget field is unused but the
      // WorldState shape requires it, so it stays zero.
      monthly_refund_budget_cents: 0,
    };
  }

  return world;
}

// Build the dispatch surface for one applicant. The returned dispatch runs the
// matching dossier's generic kernel against the applicant's scoped slice and
// writes the egress -> tool_dispatch -> state_mutation -> egress chain through the
// run's handle, exactly as the World Runner does for the refund pack, so the
// trace the loan judge reads is shaped identically.
export function createLoanApplicantWorld(
  kernels: Record<string, ToolKernel>,
  state: Record<string, WorldState>,
): LoanApplicantWorld {
  return {
    dispatch(world: WorldRunnerHandle, req: EgressRequest): ToolResponse {
      const kernel = kernels[req.tool_id];
      const url = `${req.tool_id}://${req.path}`;

      const egressBegin = world.emit({
        fixture_id: world.fixtureId,
        harness_version: world.harnessVersion,
        parent_seq: null,
        actor: "bash",
        kind: "egress",
        span: { id: `eg_${req.tool_id}_${req.path}`, phase: "begin" },
        payload: {
          method: req.method,
          url,
          request_headers: req.headers,
          request_body: req.body,
        },
      });

      if (kernel === undefined) {
        world.emit({
          fixture_id: world.fixtureId,
          harness_version: world.harnessVersion,
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

      const dispatchBegin = world.emit({
        fixture_id: world.fixtureId,
        harness_version: world.harnessVersion,
        parent_seq: egressBegin.seq,
        actor: `tool:${req.tool_id}`,
        kind: "tool_dispatch",
        span: { id: `td_${req.tool_id}_${req.path}`, phase: "begin" },
        payload: { tool_id: req.tool_id, request: req },
      });

      const response = kernel(req, state[req.tool_id]!);

      for (const m of response.state_mutations) {
        world.emit({
          fixture_id: world.fixtureId,
          harness_version: world.harnessVersion,
          parent_seq: dispatchBegin.seq,
          actor: `tool:${req.tool_id}`,
          kind: "state_mutation",
          span: { id: `sm_${req.tool_id}_${m.key}`, phase: "point" },
          payload: { key: m.key, before: m.before, after: m.after, reason: m.reason },
        });
      }

      world.emit({
        fixture_id: world.fixtureId,
        harness_version: world.harnessVersion,
        parent_seq: dispatchBegin.seq,
        actor: `tool:${req.tool_id}`,
        kind: "tool_dispatch",
        span: { id: dispatchBegin.span.id, phase: "end" },
        payload: { status: response.status, body: response.body },
      });

      world.emit({
        fixture_id: world.fixtureId,
        harness_version: world.harnessVersion,
        parent_seq: egressBegin.seq,
        actor: "bash",
        kind: "egress",
        span: { id: egressBegin.span.id, phase: "end" },
        payload: {
          status: response.status,
          url,
          response_headers: response.headers,
          response_body: response.body,
        },
      });

      return response;
    },
  };
}
