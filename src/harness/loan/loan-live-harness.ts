// The live loan underwriting harness: the agent under test driven by a real
// model through the Claude Agent SDK over the loan function tools. It is the loan
// analog of the refund live harness, with two deliberate differences. First, the
// loan tools dispatch in-process through the run's handle into the per-dossier
// generic kernels rather than running curl through a separate gateway process, so
// the loan world is seeded and served deterministically with no extra process and
// the only model call is the agent's own reasoning. Second, the terminal action
// is one of four loan decisions captured by submit_decision, not a money move
// read off an egress stream.
//
// Everything except the model call itself is keyless: the harness builds and
// typechecks with no credential, and the credential is checked at run time so a
// keyless process can construct and inspect it and only fail when it actually
// drives the model.

import {
  createSdkMcpServer,
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { TraceEvent, WorldRunnerHandle } from "@/engine";
import type { Applicant } from "@/scenarios/loan/schema.js";
import {
  hasModelCredential,
  MissingApiKeyError,
} from "../live-harness.js";
import {
  buildLoanFunctionTools,
  LOAN_FUNCTION_TOOL_SERVER_NAME,
} from "./loan-function-tools.js";
import {
  type LoanHarnessSpec,
  LOAN_HARNESS_MODEL,
} from "./loan-harness-spec.js";

// The in-process MCP server the loan function tools register under.
const MCP_SERVER_NAME = LOAN_FUNCTION_TOOL_SERVER_NAME;

// Construction options for one live loan harness. The spec supplies the
// optimizable system prompt and tool surface; maxTurns bounds a runaway agent so
// per-applicant live cost stays capped.
export interface LiveLoanHarnessOptions {
  spec: LoanHarnessSpec;
  // The maximum number of agent turns before the run is stopped. Bounds the cost
  // of one applicant's underwrite. The SDK applies its own default when unset.
  maxTurns?: number;
  // The environment consulted for the credential check. Defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

// A live loan harness: a function that underwrites one applicant by driving the
// model over the loan function tools against the run's handle. The handle's
// dispatch is wired by the caller to the per-dossier generic kernels, so this
// harness never knows about kernels or seeding.
export interface LiveLoanHarness {
  id: string;
  model: string;
  run(applicant: Applicant, world: WorldRunnerHandle): Promise<void>;
}

// Build a live loan harness from a spec. The credential is checked at run time,
// not construction time, so a keyless process can build the harness and only
// fail when it actually tries to drive the model.
export function createLiveLoanHarness(
  options: LiveLoanHarnessOptions,
): LiveLoanHarness {
  const { spec } = options;
  const env = options.env ?? process.env;
  const model = spec.model.length > 0 ? spec.model : LOAN_HARNESS_MODEL;

  return {
    id: `live-${spec.id}`,
    model,
    run: (applicant, world) =>
      runLive(spec, model, applicant, world, options.maxTurns, env),
  };
}

// Drive one applicant through the live model. Guard the credential without
// touching the network, stand up the in-process loan tool server, issue the
// underwriting prompt, drain each turn into the trace, and stop at the turn cap.
// The terminal decision is recorded by the agent's submit_decision call, which
// writes the decision state_mutation the judge reads; this harness asserts no
// outcome of its own.
async function runLive(
  spec: LoanHarnessSpec,
  model: string,
  applicant: Applicant,
  world: WorldRunnerHandle,
  maxTurns: number | undefined,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!hasModelCredential(env)) {
    throw new MissingApiKeyError();
  }

  const functionTools = buildLoanFunctionTools(
    spec,
    applicant.applicant_id,
    world,
  );

  const worldServer = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: functionTools.map((t) => t.tool),
  });

  const allowedTools = functionTools.map((t) => t.qualifiedName);

  const queryOptions: Options = {
    model,
    systemPrompt: spec.system_prompt,
    mcpServers: { [MCP_SERVER_NAME]: worldServer },
    allowedTools,
    includePartialMessages: true,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };

  const prompt = buildTaskPrompt(spec, applicant);

  // The turn cap is enforced both by the SDK option and this loop-level guard,
  // which counts completed assistant turns and tears the stream down the moment
  // the cap is reached, so a runaway underwrite cannot stream past the cap.
  const stream = query({ prompt, options: queryOptions });
  let assistantTurns = 0;
  for await (const message of stream) {
    drainMessage(world, message);
    if (message.type === "assistant") {
      assistantTurns += 1;
      if (maxTurns !== undefined && assistantTurns >= maxTurns) {
        break;
      }
    }
  }
}

// The task prompt for one applicant. It restates the optimizable procedure and
// the success criterion from the spec and names the tools and the terminal
// submit_decision contract. It stays free of any threshold so the prompt carries
// only the public surface the spec carries: the tradeoffs are the agent's.
function buildTaskPrompt(spec: LoanHarnessSpec, applicant: Applicant): string {
  const lines: string[] = [];
  lines.push(
    "Underwrite the following loan applicant. You have named tools to gather " +
      "signals: read_application, pull_credit_report, analyze_bank_transactions, " +
      "check_fraud_signal, and read_lending_guidelines. Call those tools to " +
      "gather what you need, then call submit_decision exactly once with your " +
      "terminal action (approve, decline, counter_offer, or request_more_info) " +
      "and a short rationale.",
  );
  if (spec.procedure.length > 0) {
    lines.push("");
    lines.push("Procedure:");
    for (const [i, step] of spec.procedure.entries()) {
      lines.push(`${i + 1}. ${step}`);
    }
  }
  lines.push("");
  lines.push("Success criterion: " + spec.success_criterion);
  lines.push("");
  lines.push("Applicant:");
  lines.push(`  applicant_id: ${applicant.applicant_id}`);
  return lines.join("\n");
}

// Drain one SDK message into the trace, writing the agent_turn frames the judge
// and viewer read. The decision capture is written by the submit_decision tool,
// so this drain handles only the model's own turns and the final result.
function drainMessage(world: WorldRunnerHandle, message: SDKMessage): void {
  switch (message.type) {
    case "assistant":
      drainAssistant(world, message);
      return;
    case "stream_event":
      drainPartial(world, message);
      return;
    case "result":
      drainResult(world, message);
      return;
    default:
      return;
  }
}

function drainAssistant(
  world: WorldRunnerHandle,
  message: Extract<SDKMessage, { type: "assistant" }>,
): void {
  const text = extractAssistantText(message.message.content);
  const stopReason = message.message.stop_reason ?? null;
  const usage = message.message.usage;

  world.emit({
    fixture_id: world.fixtureId,
    harness_version: world.harnessVersion,
    parent_seq: null,
    actor: "harness",
    kind: "agent_turn",
    span: { id: message.uuid, phase: "end" },
    payload: {
      ...(text.length > 0 ? { text } : {}),
      stop_reason: stopReason,
      ...(usage
        ? {
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
            },
          }
        : {}),
    },
  });
}

function drainPartial(
  world: WorldRunnerHandle,
  message: Extract<SDKMessage, { type: "stream_event" }>,
): void {
  const text = extractPartialText(message.event);
  if (text.length === 0) return;
  world.emit({
    fixture_id: world.fixtureId,
    harness_version: world.harnessVersion,
    parent_seq: null,
    actor: "harness",
    kind: "agent_turn",
    span: { id: message.uuid, phase: "point" },
    payload: { text },
  });
}

function drainResult(
  world: WorldRunnerHandle,
  message: Extract<SDKMessage, { type: "result" }>,
): void {
  world.emit({
    fixture_id: world.fixtureId,
    harness_version: world.harnessVersion,
    parent_seq: null,
    actor: "harness",
    kind: "agent_turn",
    span: { id: message.uuid, phase: "end" },
    payload: {
      stop_reason: message.subtype,
      usage: {
        input_tokens: message.usage.input_tokens ?? undefined,
        output_tokens: message.usage.output_tokens ?? undefined,
      },
      cost_usd: message.total_cost_usd,
    },
  });
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractPartialText(event: unknown): string {
  if (!isRecord(event) || event.type !== "content_block_delta") return "";
  const delta = event.delta;
  if (
    isRecord(delta) &&
    delta.type === "text_delta" &&
    typeof delta.text === "string"
  ) {
    return delta.text;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
