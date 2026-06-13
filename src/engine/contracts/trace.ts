// The unified trace: the single source of truth for the Judge and the viewer.
// One append-only JSONL line per event, written only by the World Runner so
// that `seq` is a total order. `parent_seq` reconstructs the causal chain
// shell -> egress -> tool_dispatch -> state_mutation. The schema is frozen:
// every component in the system builds against exactly these shapes.

import { z } from "zod";

// Schema version, frozen. Bump only with a coordinated migration.
export const TRACE_SCHEMA_VERSION = 1 as const;

// Who emitted an event. A tool actor is "tool:<id>", e.g. "tool:stripe".
export const ActorSchema = z.union([
  z.literal("world"),
  z.literal("harness"),
  z.literal("bash"),
  z.custom<`tool:${string}`>(
    (val) => typeof val === "string" && val.startsWith("tool:"),
    { message: "tool actor must be of the form tool:<id>" },
  ),
]);
export type Actor = z.infer<typeof ActorSchema>;

// The kind of event. Determines the payload variant.
export const TraceKindSchema = z.enum([
  "run",
  "agent_turn",
  "tool_invocation",
  "shell",
  "egress",
  "tool_dispatch",
  "tool_call",
  "state_mutation",
  "judge",
]);
export type TraceKind = z.infer<typeof TraceKindSchema>;

// A span groups a begin/end pair (or a single point) under one id.
export const SpanPhaseSchema = z.enum(["begin", "end", "point"]);
export type SpanPhase = z.infer<typeof SpanPhaseSchema>;

export const SpanSchema = z.object({
  id: z.string(),
  phase: SpanPhaseSchema,
});
export type Span = z.infer<typeof SpanSchema>;

export const HarnessVersionSchema = z.enum(["v1", "v2"]);
export type HarnessVersion = z.infer<typeof HarnessVersionSchema>;

// A terminal decision a harness reached for a single fixture. Resolution
// explicitly includes escalation and policy-block so the technical-pass line
// stays flat when a tightened harness blocks bad refunds.
export const TerminalDecisionSchema = z.enum([
  "refunded",
  "escalated",
  "blocked",
  "errored",
]);
export type TerminalDecision = z.infer<typeof TerminalDecisionSchema>;

// ---------------------------------------------------------------------------
// Payload variants, keyed by kind. Each kind carries a begin payload and an
// end payload; a "point" event carries the begin payload shape.
// ---------------------------------------------------------------------------

// run (actor: world)
export const RunBeginPayloadSchema = z.object({
  harness_version: HarnessVersionSchema,
  fixture_id: z.string(),
  model: z.string(),
});
export const RunEndPayloadSchema = z.object({
  terminal_decision: TerminalDecisionSchema,
  duration_ms: z.number(),
});

// agent_turn (actor: harness)
export const AgentTurnBeginPayloadSchema = z.object({
  // Partial assistant text or thinking, present when includePartialMessages is on.
  text: z.string().optional(),
});
export const AgentTurnEndPayloadSchema = z.object({
  stop_reason: z.string().nullable(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
  cost_usd: z.number().optional(),
});

// tool_invocation (actor: harness) the harness calling its bash tool
export const ToolInvocationBeginPayloadSchema = z.object({
  tool_name: z.string(),
  input: z.unknown(),
});
export const ToolInvocationEndPayloadSchema = z.object({
  tool_result: z.string(),
  is_error: z.boolean(),
});

// shell (actor: bash)
export const ShellBeginPayloadSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
});
export const ShellEndPayloadSchema = z.object({
  exit_code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  // Long output is truncated; the hash lets a replay verify fidelity.
  truncated: z.boolean().optional(),
  output_hash: z.string().optional(),
});

// egress (actor: bash) the outbound HTTP call the shell produced
export const EgressBeginPayloadSchema = z.object({
  method: z.string(),
  url: z.string(),
  request_headers: z.record(z.string(), z.string()),
  request_body: z.unknown(),
});
export const EgressEndPayloadSchema = z.object({
  status: z.number(),
  url: z.string(),
  response_headers: z.record(z.string(), z.string()).optional(),
  response_body: z.unknown(),
  // The enforced invariants the kernel actually checked, for the demo overlay.
  enforced_invariants_checked: z.array(z.string()).optional(),
});

// tool_dispatch (actor: tool:*) the gateway invoking a Tool Agent
export const ToolDispatchBeginPayloadSchema = z.object({
  tool_id: z.string(),
  request: z.unknown(), // EgressRequest, validated by the egress module
});
export const ToolDispatchEndPayloadSchema = z.object({
  status: z.number(),
  body: z.unknown(),
});

// tool_call (actor: tool:*) a Tool Agent reading/writing its scoped state
export const ToolCallBeginPayloadSchema = z.object({
  op: z.string(),
  args: z.unknown(),
});
export const ToolCallEndPayloadSchema = z.object({
  returned: z.unknown(),
});

// state_mutation (actor: tool:*) an explicit, traced hidden-state delta
export const StateMutationPayloadSchema = z.object({
  key: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string(),
});

// judge (actor: world) one dimension score for one fixture
export const JudgePayloadSchema = z.object({
  dimension: z.string(),
  score: z.number(),
  dollar_impact_cents: z.number().optional(),
  rationale: z.string(),
  failure_tags: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// The envelope. The payload is left as an open record at the schema level so a
// single writer can emit any of the above shapes; helper guards below narrow
// it by (kind, phase). This keeps the JSONL line schema-validatable without
// forcing a discriminated union over nine kinds times three phases.
// ---------------------------------------------------------------------------

export const TraceEventSchema = z.object({
  v: z.literal(TRACE_SCHEMA_VERSION),
  run_id: z.string(),
  fixture_id: z.string(),
  harness_version: HarnessVersionSchema,
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  parent_seq: z.number().int().nonnegative().nullable(),
  actor: ActorSchema,
  kind: TraceKindSchema,
  span: SpanSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// Convenience payload type aliases for producers and consumers.
export type RunBeginPayload = z.infer<typeof RunBeginPayloadSchema>;
export type RunEndPayload = z.infer<typeof RunEndPayloadSchema>;
export type AgentTurnBeginPayload = z.infer<typeof AgentTurnBeginPayloadSchema>;
export type AgentTurnEndPayload = z.infer<typeof AgentTurnEndPayloadSchema>;
export type ToolInvocationBeginPayload = z.infer<
  typeof ToolInvocationBeginPayloadSchema
>;
export type ToolInvocationEndPayload = z.infer<
  typeof ToolInvocationEndPayloadSchema
>;
export type ShellBeginPayload = z.infer<typeof ShellBeginPayloadSchema>;
export type ShellEndPayload = z.infer<typeof ShellEndPayloadSchema>;
export type EgressBeginPayload = z.infer<typeof EgressBeginPayloadSchema>;
export type EgressEndPayload = z.infer<typeof EgressEndPayloadSchema>;
export type ToolDispatchBeginPayload = z.infer<
  typeof ToolDispatchBeginPayloadSchema
>;
export type ToolDispatchEndPayload = z.infer<
  typeof ToolDispatchEndPayloadSchema
>;
export type ToolCallBeginPayload = z.infer<typeof ToolCallBeginPayloadSchema>;
export type ToolCallEndPayload = z.infer<typeof ToolCallEndPayloadSchema>;
export type StateMutationPayload = z.infer<typeof StateMutationPayloadSchema>;
export type JudgePayload = z.infer<typeof JudgePayloadSchema>;
