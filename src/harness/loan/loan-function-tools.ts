// The loan harness function tools: the clean, named tool surface the live
// underwriting agent calls. Five read tools, one per loan dossier, plus the
// submit_decision capture tool that records the agent's terminal action and
// rationale. Unlike the refund function tools, which run curl through a separate
// gateway process, the loan tools dispatch in-process through the run's handle
// straight into the per-dossier generic kernels. The world is seeded
// deterministically per applicant, so the loan path is keyless-faithful and
// cost-bounded: the only model call is the agent's own reasoning, not the world.
//
// The handlers embed no lending policy. Each read tool composes the exact
// EgressRequest the dossier operation describes and dispatches it; the generic
// kernel returns the seeded record verbatim, exactly as a real bureau, bank, or
// fraud vendor would. submit_decision writes a single state_mutation on the
// applicant's decision key, which is the trace fact the loan terminal-decision
// derivation and the multi-objective judge read the action and rationale off of.

import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type {
  EgressRequest,
  ToolResponse,
  WorldRunnerHandle,
} from "@/engine";
import { LoanDecisionSchema } from "@/scenarios/loan/schema.js";
import {
  type LoanHarnessSpec,
  type LoanToolManifestEntry,
} from "./loan-harness-spec.js";

// The same erasure boundary the refund function tools use: a freshly built tool
// carries a specific argument-schema generic the SDK's handler is contravariant
// in, so the heterogeneous definitions are erased to one open type at this single
// boundary, mirroring the SDK's own Array<SdkMcpToolDefinition> server input.
type AnyFunctionTool = SdkMcpToolDefinition;

function asAnyFunctionTool<S extends z.ZodRawShape>(
  def: SdkMcpToolDefinition<S>,
): AnyFunctionTool {
  return def as unknown as AnyFunctionTool;
}

// The MCP server the loan function tools register under, shared with the loan
// live harness so the fully qualified tool names it allow-lists resolve.
export const LOAN_FUNCTION_TOOL_SERVER_NAME = "loan_world" as const;

// The decision-record key prefix the submit_decision tool writes under. The
// terminal-decision derivation and the judge read the action and rationale off a
// state_mutation on this key, one per applicant.
export const LOAN_DECISION_KEY_PREFIX = "decision";

// One built loan function tool plus the qualified name the SDK addresses it by.
export interface BuiltLoanFunctionTool {
  tool: AnyFunctionTool;
  qualifiedName: string;
}

// The fully qualified name the SDK addresses a loan function tool by:
// mcp__<server>__<tool>.
export function loanQualifiedToolName(name: string): string {
  return `mcp__${LOAN_FUNCTION_TOOL_SERVER_NAME}__${name}`;
}

// Build the loan function tools for one applicant from the spec's manifest plus
// the submit_decision capture tool. Every read tool the manifest names becomes a
// function tool that dispatches into the matching dossier's generic kernel; an
// entry whose op the harness has no actuation for is skipped rather than guessed.
export function buildLoanFunctionTools(
  spec: LoanHarnessSpec,
  applicantId: string,
  world: WorldRunnerHandle,
): BuiltLoanFunctionTool[] {
  const built: BuiltLoanFunctionTool[] = [];

  for (const entry of spec.tool_manifest) {
    const def = defineReadTool(entry, applicantId, world);
    if (def !== undefined) {
      built.push({ tool: def, qualifiedName: loanQualifiedToolName(entry.name) });
    }
  }

  built.push({
    tool: defineSubmitDecision(applicantId, world),
    qualifiedName: loanQualifiedToolName("submit_decision"),
  });

  return built;
}

// The dossier operation paths the read tools dispatch to, keyed by the manifest
// op the entry exposes. The id-bearing reads carry the applicant id in the path
// (matching the dossier templates "/reports/{id}", "/cashflow/{id}",
// "/applications/{id}", "/signals/{id}"); the guidelines read is a singleton
// (path "/guidelines", no id), which the generic kernel serves from the one
// seeded record.
function pathForEntry(
  entry: LoanToolManifestEntry,
  applicantId: string,
): string | undefined {
  const id = encodeURIComponent(applicantId);
  switch (`${entry.tool_id}:${entry.op_id}`) {
    case "application:get_application":
      return `/applications/${id}`;
    case "credit_bureau:get_report":
      return `/reports/${id}`;
    case "bank_transactions:get_cashflow":
      return `/cashflow/${id}`;
    case "fraud_signal:get_signal":
      return `/signals/${id}`;
    case "lending_guidelines:get_guidelines":
      return "/guidelines";
    default:
      return undefined;
  }
}

// Define one read tool. The tool takes no arguments: every read is scoped to the
// applicant under decision, so the agent never has to pass the id. The handler
// dispatches the dossier's GET through the run's handle and returns the seeded
// record verbatim, the way a real read API would answer.
function defineReadTool(
  entry: LoanToolManifestEntry,
  applicantId: string,
  world: WorldRunnerHandle,
): AnyFunctionTool | undefined {
  const path = pathForEntry(entry, applicantId);
  if (path === undefined) return undefined;

  return asAnyFunctionTool(
    tool(entry.name, entry.description, {}, async () => {
      const req: EgressRequest = {
        tool_id: entry.tool_id,
        method: "GET",
        path,
        query: {},
        headers: {},
        body: undefined,
      };
      const response = world.dispatch(req);
      return toToolResult(response);
    }),
  );
}

// Define the submit_decision capture tool. The agent calls it once it has
// reached a terminal action; it records the action and rationale as an explicit
// state_mutation on the applicant's decision key, which is the single trace fact
// the terminal-decision derivation and the judge read. The decision enum and a
// non-empty rationale are required, so a malformed terminal action is refused at
// the tool boundary rather than silently mis-scored.
function defineSubmitDecision(
  applicantId: string,
  world: WorldRunnerHandle,
): AnyFunctionTool {
  return asAnyFunctionTool(
    tool(
      "submit_decision",
      "Submit the terminal underwriting decision for this applicant and the " +
        "rationale for it. Call this exactly once, after you have gathered the " +
        "signals you need. The decision is one of approve, decline, " +
        "counter_offer, or request_more_info; the rationale must name the " +
        "signals you relied on and be consistent with the action.",
      {
        decision: LoanDecisionSchema.describe(
          "The terminal action: approve, decline, counter_offer, or " +
            "request_more_info.",
        ),
        rationale: z
          .string()
          .min(1)
          .describe(
            "A short, signal-grounded justification consistent with the action.",
          ),
      },
      async (input) => {
        const key = `${LOAN_DECISION_KEY_PREFIX}:${applicantId}`;
        // The decision capture is emitted as a state_mutation so it rides the
        // same observability channel the judge already reads, parented to the
        // run. before is null (no prior decision); after carries the action and
        // rationale the derivation and the judge consume.
        world.emit({
          fixture_id: world.fixtureId,
          harness_version: world.harnessVersion,
          parent_seq: null,
          actor: "harness",
          kind: "state_mutation",
          span: { id: `decision_${applicantId}`, phase: "point" },
          payload: {
            key,
            before: null,
            after: { decision: input.decision, rationale: input.rationale },
            reason: "terminal underwriting decision submitted",
          },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Recorded decision ${input.decision} for ${applicantId}.`,
            },
          ],
          isError: false,
        };
      },
    ),
  );
}

// Render one dispatched read as the SDK tool result the model reads. A non-2xx
// status is surfaced as an error result so the agent can react, while the body is
// always returned verbatim so the agent sees the real API response.
function toToolResult(response: ToolResponse): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const isError = response.status < 200 || response.status >= 300;
  const text =
    typeof response.body === "string"
      ? response.body
      : JSON.stringify(response.body);
  return { content: [{ type: "text" as const, text }], isError };
}
