// The harness function tools: the clean, named tool surface the live agent calls
// instead of hand-writing curl. Each tool the harness spec's tool_manifest names
// becomes a Claude Agent SDK function tool here, with a typed argument schema and
// the manifest's public description. The handler does not talk to the model and
// does not embed any business rule: it composes the exact HTTP call the tool
// represents against the right synthetic service and runs it through the run's
// bash tool, so the outbound request reaches the egress gateway exactly as a
// hand-written curl would.
//
// Routing the call through the bash tool keeps the kernels the single source of
// truth: the gateway dispatches the request into the matching kernel against the
// fixture's scoped world and writes the egress -> tool_dispatch -> state_mutation
// chain. issue_refund therefore still hits the Stripe kernel and is gated only by
// its real mechanical invariants (amount within remaining, charge exists, not
// disputed, not already refunded); no policy check is added here, which is the
// whole point of the trap. The agent gets a reachable, correctly addressed tool;
// the world stays faithful.
//
// The agent keeps the bash tool too, for genuine computation. These function
// tools remove the need to hand-integrate the APIs, not the ability to run a
// shell when a real calculation is required.

import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Fixture } from "@/engine";
import type { BashTool } from "@/world/bash-tool.js";
import type { HarnessSpec, ToolManifestEntry } from "./specs/types.js";

// The tool-definition type the SDK server collects. Each definer below returns a
// specifically typed definition inferred from its own argument schema; the SDK's
// tool handler is contravariant in its parsed arguments, so a specific definition
// does not widen to a general one. The heterogeneous definitions are therefore
// erased to this open type at the one boundary below, mirroring the SDK's own
// Array<SdkMcpToolDefinition<...>> server input, so they compose into one server.
type AnyFunctionTool = SdkMcpToolDefinition;

// Erase the specific argument-schema generic a freshly built tool carries to the
// open tool-definition type the server collects. Generic in the input so a
// specific definition is accepted; the one place the widening happens.
function asAnyFunctionTool<S extends z.ZodRawShape>(
  def: SdkMcpToolDefinition<S>,
) {
  return def as unknown as AnyFunctionTool;
}

// The MCP server name the function tools register under, shared with the live
// harness so the fully qualified tool names it allow-lists resolve.
export const FUNCTION_TOOL_SERVER_NAME = "world" as const;

// The result of running one HTTP call through the bash tool: the parsed JSON body
// when the response was JSON, the raw text otherwise, and the transport outcome.
interface ToolCallOutcome {
  exitCode: number;
  text: string;
}

// The synthetic services each tool addresses. The host is resolved by the egress
// gateway from the proxied request line; the path prefix the gateway also matches
// is reached by the same call, so either resolution lands the request on the
// correct kernel. The hosts mirror the gateway's host table.
const STRIPE_HOST = "stripe.local";
const ORDERS_HOST = "orders.local";
const CUSTOMERS_HOST = "customers.local";
const POLICY_HOST = "policy.local";
const ZENDESK_HOST = "zendesk.local";

// One built function tool plus the qualified name the SDK addresses it by, so the
// live harness can both register the tool and allow-list it.
export interface BuiltFunctionTool {
  tool: AnyFunctionTool;
  qualifiedName: string;
}

// Build the function tools for one run from the spec's tool_manifest and the
// fixture under test. Every manifest entry the harness knows how to actuate
// becomes a function tool; an entry with no known actuation is skipped rather than
// guessed, so the surface stays faithful to what the world can serve. The bash
// tool is the single transport: each handler composes the call and runs it.
export function buildFunctionTools(
  spec: HarnessSpec,
  fixture: Fixture,
  bash: BashTool,
): BuiltFunctionTool[] {
  const built: BuiltFunctionTool[] = [];
  for (const entry of spec.tool_manifest) {
    const def = defineToolForEntry(entry, fixture, bash);
    if (def !== undefined) {
      built.push({
        tool: def,
        qualifiedName: qualifiedToolName(entry.name),
      });
    }
  }
  return built;
}

// The fully qualified name the SDK addresses a function tool by:
// mcp__<server>__<tool>. The live harness lists these in allowedTools.
export function qualifiedToolName(name: string): string {
  return `mcp__${FUNCTION_TOOL_SERVER_NAME}__${name}`;
}

// Resolve one manifest entry to its SDK function tool, keyed by the capability the
// entry exposes (its dossier op). Returns undefined when the entry names an op the
// world has no actuation for, which keeps the surface honest.
function defineToolForEntry(
  entry: ToolManifestEntry,
  fixture: Fixture,
  bash: BashTool,
): AnyFunctionTool | undefined {
  const key = `${entry.from}:${entry.op_id}`;
  switch (key) {
    case "zendesk_support:get_ticket":
      return asAnyFunctionTool(defineGetTicket(entry, fixture, bash));
    case "orders:get_order":
      return asAnyFunctionTool(defineLookupOrder(entry, bash));
    case "customers:get_customer":
      return asAnyFunctionTool(defineLookupCustomer(entry, bash));
    case "policy_store:get_policy":
      return asAnyFunctionTool(defineReadPolicy(entry, bash));
    case "stripe_payments:create_refund":
      return asAnyFunctionTool(defineIssueRefund(entry, bash));
    case "zendesk_support:update_ticket":
      return asAnyFunctionTool(defineEscalateToHuman(entry, fixture, bash));
    default:
      return undefined;
  }
}

// get_ticket: fetch a support ticket by id. The id defaults to the ticket under
// test so the agent can read its own ticket without restating the id.
function defineGetTicket(
  entry: ToolManifestEntry,
  fixture: Fixture,
  bash: BashTool,
) {
  return tool(
    entry.name,
    entry.description,
    {
      ticket_id: z
        .string()
        .optional()
        .describe(
          "The ticket id to fetch. Defaults to the ticket you were assigned.",
        ),
    },
    async (input) => {
      const id = input.ticket_id ?? fixture.ticket.id;
      const outcome = await httpGet(bash, ZENDESK_HOST, `/api/v2/tickets/${id}`);
      return toToolResult(outcome);
    },
  );
}

// lookup_order: read an order by id. A read API: it returns the facts the policy
// turns on (purchase date, payment method, fraud flag, charge id) and enforces no
// policy, so this handler adds none.
function defineLookupOrder(
  entry: ToolManifestEntry,
  bash: BashTool,
) {
  return tool(
    entry.name,
    entry.description,
    {
      order_id: z.string().describe("The order id to look up, e.g. ord_1001."),
    },
    async (input) => {
      const outcome = await httpGet(
        bash,
        ORDERS_HOST,
        `/orders/${encodeURIComponent(input.order_id)}`,
      );
      return toToolResult(outcome);
    },
  );
}

// lookup_customer: read a customer account by email. Surfaces the serial-refunder
// signal (refund_count_30d, abuse_score); acting on it is the agent's job.
function defineLookupCustomer(
  entry: ToolManifestEntry,
  bash: BashTool,
) {
  return tool(
    entry.name,
    entry.description,
    {
      email: z
        .string()
        .describe("The customer's email address to look up the account by."),
    },
    async (input) => {
      const outcome = await httpGet(
        bash,
        CUSTOMERS_HOST,
        `/customers/${encodeURIComponent(input.email)}`,
      );
      return toToolResult(outcome);
    },
  );
}

// read_policy: read the written refund policy document. The rules live in this
// document the agent chooses to read, never in the tool or the spec.
function defineReadPolicy(
  entry: ToolManifestEntry,
  bash: BashTool,
) {
  return tool(entry.name, entry.description, {}, async () => {
    const outcome = await httpGet(bash, POLICY_HOST, "/policy");
    return toToolResult(outcome);
  });
}

// issue_refund: move money against a charge through the billing API. The handler
// posts the form body the real Stripe refunds endpoint takes and adds no business
// rule: the Stripe kernel applies only its mechanical invariants, so a refund the
// policy should have blocked still succeeds here. That faithful silence is the
// trap the optimizer learns to close in the agent, not in the API.
function defineIssueRefund(
  entry: ToolManifestEntry,
  bash: BashTool,
) {
  return tool(
    entry.name,
    entry.description,
    {
      charge: z
        .string()
        .describe(
          "The charge id to refund, e.g. ch_legit. Read it from the order's " +
            "stripe_charge_id.",
        ),
      amount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "The amount to refund in the smallest currency unit (cents). Omit to " +
            "refund the full remaining unrefunded total.",
        ),
      reason: z
        .string()
        .optional()
        .describe("The refund reason, e.g. requested_by_customer."),
    },
    async (input) => {
      const form: Record<string, string> = { charge: input.charge };
      if (input.amount !== undefined) form["amount"] = String(input.amount);
      if (input.reason !== undefined) form["reason"] = input.reason;
      const outcome = await httpForm(
        bash,
        STRIPE_HOST,
        "POST",
        "/v1/refunds",
        form,
      );
      return toToolResult(outcome);
    },
  );
}

// escalate_to_human: route the ticket to a human by setting it pending with an
// internal note. Built on the ticket update path (the comment-on-update quirk the
// Zendesk kernel reproduces), with the note kept private. The ticket id defaults
// to the ticket under test.
function defineEscalateToHuman(
  entry: ToolManifestEntry,
  fixture: Fixture,
  bash: BashTool,
) {
  return tool(
    entry.name,
    entry.description,
    {
      reason: z
        .string()
        .describe("The internal note explaining why the ticket needs a human."),
      ticket_id: z
        .string()
        .optional()
        .describe(
          "The ticket id to escalate. Defaults to the ticket you were assigned.",
        ),
    },
    async (input) => {
      const id = input.ticket_id ?? fixture.ticket.id;
      const body = {
        ticket: {
          status: "pending",
          comment: { body: input.reason, public: false },
        },
      };
      const outcome = await httpJson(
        bash,
        ZENDESK_HOST,
        "PUT",
        `/api/v2/tickets/${id}`,
        body,
      );
      return toToolResult(outcome);
    },
  );
}

// ---------------------------------------------------------------------------
// HTTP composition. Each helper builds the exact curl a hand-written integration
// would and runs it through the bash tool, which executes it on the substrate so
// its outbound request reaches the gateway. The binding tag rides along from the
// substrate's environment, so the gateway resolves the fixture and dispatches.
// ---------------------------------------------------------------------------

// A GET against a synthetic service host. The host is addressed directly; the
// substrate's proxy env routes the call through the gateway transparently.
async function httpGet(
  bash: BashTool,
  host: string,
  path: string,
): Promise<ToolCallOutcome> {
  const command =
    `curl -s --max-time 20 -X GET 'http://${host}${path}' ` +
    `-H 'x-synth-sandbox-tag: '"$SYNTH_SANDBOX_TAG"`;
  return runCurl(bash, command);
}

// A form-encoded POST/PUT, the shape the Stripe refunds endpoint takes.
async function httpForm(
  bash: BashTool,
  host: string,
  method: string,
  path: string,
  form: Record<string, string>,
): Promise<ToolCallOutcome> {
  const body = encodeForm(form);
  const command =
    `curl -s --max-time 20 -X ${method} 'http://${host}${path}' ` +
    `-H 'x-synth-sandbox-tag: '"$SYNTH_SANDBOX_TAG" ` +
    `-H 'content-type: application/x-www-form-urlencoded' ` +
    `--data '${body}'`;
  return runCurl(bash, command);
}

// A JSON POST/PUT, the shape the internal services take.
async function httpJson(
  bash: BashTool,
  host: string,
  method: string,
  path: string,
  body: unknown,
): Promise<ToolCallOutcome> {
  const json = JSON.stringify(body).replace(/'/g, `'\\''`);
  const command =
    `curl -s --max-time 20 -X ${method} 'http://${host}${path}' ` +
    `-H 'x-synth-sandbox-tag: '"$SYNTH_SANDBOX_TAG" ` +
    `-H 'content-type: application/json' ` +
    `--data '${json}'`;
  return runCurl(bash, command);
}

// Run one composed curl through the bash tool and read the body off the process
// outcome. The bash tool emits the tool_invocation and shell hops and runs the
// command on the substrate, whose egress the gateway turns into the kernel
// dispatch and trace chain.
async function runCurl(
  bash: BashTool,
  command: string,
): Promise<ToolCallOutcome> {
  const result = await bash({ cmd: command, args: [] });
  const text = result.stdout.length > 0 ? result.stdout : result.stderr;
  return { exitCode: result.exitCode, text };
}

// Encode a flat string map as application/x-www-form-urlencoded.
function encodeForm(form: Record<string, string>): string {
  return Object.entries(form)
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join("&");
}

// Render one tool call outcome as the SDK tool result the model reads. A non-zero
// exit or a non-2xx body is surfaced as an error result so the model can react,
// while the body is always returned verbatim so the agent sees the real API
// response it would have seen from a hand-written call.
function toToolResult(outcome: ToolCallOutcome): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const isError = outcome.exitCode !== 0 || isErrorBody(outcome.text);
  return {
    content: [{ type: "text" as const, text: outcome.text }],
    isError,
  };
}

// A best-effort read of whether the returned body is an API error envelope, used
// only to set the SDK isError flag; the body itself is always passed through.
function isErrorBody(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return parsed["error"] !== undefined;
  } catch {
    return false;
  }
}
