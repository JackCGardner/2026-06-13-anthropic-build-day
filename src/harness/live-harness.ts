// The live harness: the agent under test driven by a real model through the
// Claude Agent SDK. It fills the same Harness seam the scripted v1/v2 harnesses
// fill, so the World Runner, kernels, and Judge run unchanged whether the agent
// is scripted or live. The only thing the live path needs that the scripted path
// does not is a key for the model call at run time; everything else (the spec
// wiring, the bash tool exposure, the trace drain, the no-key guard) is built
// and typechecked keyless.
//
// How it drives the world: the harness exposes a clean set of named function
// tools (get_ticket, lookup_order, lookup_customer, read_policy, issue_refund,
// escalate_to_human) built from the spec's tool_manifest, plus the raw `bash`
// tool for genuine computation. The agent no longer has to hand-write curl or
// guess service addresses: each function tool composes the exact HTTP call it
// represents and runs it through the same bash-tool callable, which executes it
// on the run's BashSubstrate and emits the tool_invocation and shell trace hops.
// The command's outbound HTTP reaches the egress gateway exactly as it does on
// the scripted bash path, so the gateway writes the egress -> tool_dispatch ->
// state_mutation chain and the hidden money moves the same way. issue_refund
// therefore still hits the Stripe kernel and is gated only by its real mechanical
// invariants. The model never sees the kernels or the gateway: it calls named
// tools and reads their wire-faithful output, which is the whole point of the
// synthetic world.
//
// How it fills the trace: the harness drains the query() stream and writes one
// agent_turn per assistant turn (and per partial stream delta when
// includePartialMessages surfaces text), plus a run/end frame carrying the
// terminal decision, the model's stop reason, token usage, and cost. The bash
// tool hops are written by the bash-tool callable inside the MCP handler, so the
// full causal chain is present without this file knowing anything about the
// network.

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type {
  Fixture,
  Harness,
  HarnessVersion,
  TraceEvent,
  WorldRunnerHandle,
} from "@/engine";
import { createBashTool, type BashTool } from "@/world/bash-tool.js";
import {
  buildFunctionTools,
  FUNCTION_TOOL_SERVER_NAME,
  qualifiedToolName,
} from "./function-tools.js";
import type { HarnessSpec } from "./specs/types.js";

// The name the in-process MCP server registers under and the tools it exposes.
// The fully qualified tool name the SDK addresses is `mcp__<server>__<tool>`,
// which is what `allowedTools` must list. The bash tool stays available for
// genuine computation alongside the named function tools the spec manifest
// drives; both register under the same server.
const MCP_SERVER_NAME = FUNCTION_TOOL_SERVER_NAME;
const BASH_TOOL_NAME = "bash";
const QUALIFIED_BASH_TOOL = qualifiedToolName(BASH_TOOL_NAME);

// The model the live harness drives. Pinned to Opus; a spec may override it, but
// the live path is built around the Opus 4.8 id.
const DEFAULT_MODEL = "claude-opus-4-8";

// Thrown before any model call when no usable credential is present. The live
// harness never reaches the network without a key, so a keyless environment
// fails fast and clearly rather than emitting an opaque transport error.
export class MissingApiKeyError extends Error {
  override readonly name = "MissingApiKeyError";
  constructor() {
    super(
      "Live harness requires a model credential: set ANTHROPIC_API_KEY or " +
        "CLAUDE_CODE_OAUTH_TOKEN, or run inside an authenticated Claude Code " +
        "session. No credential was found, so the model was not called.",
    );
  }
}

// Whether a usable credential is present without making any network call. A live
// run is permitted when an explicit key or OAuth token is set, or when the
// caller asserts an ambient Claude Code login via CLAUDE_AGENT_SDK_AMBIENT_AUTH.
// The check reads only the environment, so it is safe to run keyless.
export function hasModelCredential(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    nonEmpty(env.ANTHROPIC_API_KEY) ||
    nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN) ||
    nonEmpty(env.CLAUDE_AGENT_SDK_AMBIENT_AUTH)
  );
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

// Construction options for one live harness. The spec supplies the system prompt
// and tool surface; the version tags every trace event so the Judge attributes
// the run correctly. The harness is otherwise interchangeable with the scripted
// harness behind the Harness seam.
export interface LiveHarnessOptions {
  spec: HarnessSpec;
  // The harness version stamped on the run and used by the Harness seam. Defaults
  // to the spec's own version.
  version?: HarnessVersion;
  // The maximum number of agent turns before the run is stopped, a guard against
  // a runaway loop. Optional; the SDK applies its own default when unset.
  maxTurns?: number;
  // The environment consulted for the credential check. Defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

// Build a live harness from a pinned spec. The returned object is a Harness: the
// World Runner calls run(fixture, world) with the same handle it hands the
// scripted harness. The credential is checked at run time, not construction time,
// so a keyless process can build the harness, inspect it, and only fail when it
// actually tries to drive the model.
export function createLiveHarness(options: LiveHarnessOptions): Harness {
  const { spec } = options;
  const version: HarnessVersion = options.version ?? spec.version;
  const env = options.env ?? process.env;

  return {
    id: `live-${spec.id}`,
    version,
    run: (fixture, world) => runLive(spec, world, fixture, options.maxTurns, env),
  };
}

// Drive one fixture through the live model. The flow is:
//   1. guard the credential without calling the API,
//   2. stand up the in-process bash MCP server wrapping the run's bash tool,
//   3. issue the task prompt and stream the model's turns,
//   4. drain each SDK message into the trace,
//   5. close the run with the terminal decision read from the trace.
// Every tool the model invokes runs through the bash-tool callable, so the world
// is driven entirely by shell commands the model composes.
async function runLive(
  spec: HarnessSpec,
  world: WorldRunnerHandle,
  fixture: Fixture,
  maxTurns: number | undefined,
  env: NodeJS.ProcessEnv,
): Promise<TraceEvent[]> {
  if (!hasModelCredential(env)) {
    throw new MissingApiKeyError();
  }

  // The bash tool the named function tools and the model drive the world
  // through: the same callable the scripted bash path uses, bound to this run's
  // handle and substrate so its hops land in this fixture's trace and its egress
  // reaches the gateway.
  const bash: BashTool = createBashTool({
    world,
    substrate: world.bash,
  });

  // The named function tools the spec's manifest describes, each composing the
  // exact HTTP call it represents and running it through the bash tool. The agent
  // calls these instead of hand-writing curl; the bash tool stays registered for
  // genuine computation.
  const functionTools = buildFunctionTools(spec, fixture, bash);

  const worldServer = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [defineBashTool(bash), ...functionTools.map((t) => t.tool)],
  });

  const allowedTools = [
    QUALIFIED_BASH_TOOL,
    ...functionTools.map((t) => t.qualifiedName),
  ];

  const queryOptions: Options = {
    model: spec.model.length > 0 ? spec.model : DEFAULT_MODEL,
    systemPrompt: spec.system_prompt,
    mcpServers: { [MCP_SERVER_NAME]: worldServer },
    allowedTools,
    includePartialMessages: true,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };

  const prompt = buildTaskPrompt(spec, fixture);

  // The turn cap is enforced two ways: the SDK's own maxTurns option above, and
  // this loop-level guard, which counts completed assistant turns and stops the
  // stream the moment the cap is reached. The belt-and-braces guard keeps a
  // runaway agent from streaming past the cap even if the SDK option is not
  // honored by a given transport.
  const stream = query({ prompt, options: queryOptions });
  let assistantTurns = 0;
  for await (const message of stream) {
    drainMessage(world, message);
    if (message.type === "assistant") {
      assistantTurns += 1;
      if (maxTurns !== undefined && assistantTurns >= maxTurns) {
        // Breaking the for-await loop drives the generator's return path, which
        // tears the query down cleanly. This is the loop-level cap that holds
        // even when the SDK's own maxTurns is not enforced by the transport.
        break;
      }
    }
  }

  // The live harness does not write its own run/end frame. The terminal decision
  // is a property of what the run did to the world, which the World Runner reads
  // off the trace it owns; letting the runner close the run keeps the live and
  // scripted paths classified by the same writer, with no ground truth consulted
  // by the harness. The Judge derives cash burned and the pass/fail verdict from
  // the state_mutation hops the gateway wrote, independent of any run/end label.
  return [];
}

// The single bash tool the model can call. Its schema is a command string and an
// optional argv, matching the BashToolInput the bash-tool callable consumes. The
// handler runs the command for real and returns the process outcome as the tool
// result the model reads; the trace hops are emitted by the callable itself.
function defineBashTool(bash: BashTool) {
  return tool(
    BASH_TOOL_NAME,
    "Run a shell command inside the support agent's sandbox for genuine " +
      "computation, such as date math when checking a refund window. Prefer the " +
      "named tools (get_ticket, lookup_order, lookup_customer, read_policy, " +
      "issue_refund, escalate_to_human) for talking to the services; reach for " +
      "the shell only when a real calculation is required. Returns the command's " +
      "stdout, stderr, and exit code.",
    {
      command: z
        .string()
        .describe("The shell command line to run, e.g. a full curl invocation."),
      args: z
        .array(z.string())
        .optional()
        .describe(
          "Optional argv appended to the command; omit when the command line " +
            "is already complete.",
        ),
    },
    async (input) => {
      const result = await bash({
        cmd: input.command,
        args: input.args ?? [],
      });
      const body =
        result.stdout.length > 0 ? result.stdout : result.stderr;
      return {
        content: [
          {
            type: "text" as const,
            text: formatToolResult(result.exitCode, body),
          },
        ],
        isError: result.exitCode !== 0,
      };
    },
  );
}

// Render the command outcome for the model: the exit code first so a non-zero
// failure is unmistakable, then the captured output.
function formatToolResult(exitCode: number, body: string): string {
  const header = `exit_code=${exitCode}`;
  return body.length > 0 ? `${header}\n${body}` : header;
}

// The task prompt handed to the model for one ticket. It restates the procedure
// and success criterion from the spec and presents the visible ticket. It stays
// rule-silent: the prompt carries only the public surface the spec carries, so a
// v1 spec produces a v1 agent and a v2 spec a v2 agent, with no hidden rule text.
function buildTaskPrompt(spec: HarnessSpec, fixture: Fixture): string {
  const lines: string[] = [];
  lines.push(
    "Resolve the following support ticket. You have named tools for every step: " +
      "get_ticket, lookup_order, lookup_customer, read_policy, issue_refund, and " +
      "escalate_to_human. Call those tools directly; they reach the live services " +
      "for you, so you never need to hand-write HTTP or curl. Reach a terminal " +
      "decision: either issue_refund when the refund is clearly allowed, or " +
      "escalate_to_human to route the ticket to a person when it is not.",
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
  lines.push("Ticket:");
  lines.push(`  id: ${fixture.ticket.id}`);
  lines.push(`  subject: ${fixture.ticket.subject}`);
  lines.push(`  from: ${fixture.ticket.customer_email}`);
  if (fixture.ticket.order_id !== undefined) {
    lines.push(`  order_id: ${fixture.ticket.order_id}`);
  }
  lines.push(`  body: ${fixture.ticket.body}`);
  return lines.join("\n");
}

// Drain one SDK message into the trace, writing the agent_turn frames the viewer
// and Judge read. The tool hops are not written here: they are emitted by the
// bash-tool callable when the model's tool call runs, parented under the same
// run, so this drain only handles the model's own turns and the final result.
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
      // System, user-replay, status, and progress messages do not contribute a
      // turn frame; the bash tool hops already cover tool activity.
      return;
  }
}

// A completed assistant turn: emit one agent_turn carrying the turn's text and
// the model's stop reason and usage, mirroring an SDKAssistantMessage. Tool-use
// blocks in the same message drive the bash tool, whose hops are written by the
// callable, so they are not duplicated here.
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

// A partial assistant delta from includePartialMessages: when it carries a text
// delta, emit a point agent_turn so the viewer can stream the model's thinking.
// Non-text stream events (message_start, tool-use deltas, message_stop) carry no
// turn text and are skipped; the completed assistant message records the turn.
function drainPartial(
  world: WorldRunnerHandle,
  message: Extract<SDKMessage, { type: "stream_event" }>,
): void {
  const text = extractPartialText(message.event);
  if (text.length === 0) {
    return;
  }
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

// The final result message: it closes the conversation. The terminal decision is
// inferred from the run's own state mutations and the model's result, and the
// cost and usage are recorded on a closing agent_turn so the dashboard can show
// what the run spent.
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

// Pull the visible text from a completed assistant message's content blocks. The
// content is the model's BetaContentBlock array; only text blocks carry prose,
// and tool-use blocks are handled by the bash tool, so they are not stringified
// here.
function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

// Pull a text delta from a raw stream event. Only content_block_delta events
// with a text_delta carry streamed prose; every other event shape contributes
// no turn text.
function extractPartialText(event: unknown): string {
  if (!isRecord(event) || event.type !== "content_block_delta") {
    return "";
  }
  const delta = event.delta;
  if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
