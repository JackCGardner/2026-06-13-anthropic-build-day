// Per-tool persona agents: the "society of agents" layer wrapped around each
// deterministic kernel. Every synthetic tool gains its own Claude Agent SDK
// agent with its own session, threaded across calls so a refund issued earlier
// is visible to a later list call on the same tool. The persona is strictly
// ADVISORY: it may enrich the human-readable message prose on a response (a
// faithful error string, an in-character support voice), but it can never change
// the dollar figure, the state mutation, the status code, or which invariants
// were enforced.
//
// The flow per request follows the kernel-first contract:
//   1. the KERNEL runs first and computes the authoritative ToolResponse plus
//      every state_mutation. This is the single source of truth for state, money,
//      and the enforced invariants. It runs unconditionally.
//   2. only if a model credential is present AND persona mode is on, an Agent SDK
//      query() with the dossier-derived system prompt is given the kernel's
//      response and may propose a richer message string.
//   3. a re-validation seam then rebuilds the response from the kernel's values
//      for every non-message field, splicing in only the persona's message text.
//      Status, body data, headers, and state_mutations are taken verbatim from
//      the kernel, so the model is structurally incapable of moving money or
//      mutating state.
//
// With no key, or with persona mode off, dispatch returns the kernel's response
// unchanged and never touches the network, so the keyless world is byte-identical
// to a raw kernel call. The egress core selects this path only when explicitly
// enabled and a credential exists.

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  EgressRequest,
  ToolDossier,
  ToolKernel,
  ToolResponse,
  WorldState,
} from "@/engine";

// The model the personas run on. Pinned to Opus to match the live harness; a
// persona is a prose enrichment, not a reasoning agent, so it runs cheaply with
// a tight turn budget and no tools.
const DEFAULT_PERSONA_MODEL = "claude-opus-4-8";

// A persona never uses tools. It receives the kernel's already-computed response
// and returns prose; giving it no tools keeps it on the single message-shaping
// turn and prevents it from reaching the network or the filesystem.
const PERSONA_DISALLOWED_TOOLS: string[] = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
];

// One persona turn is all that is needed: the agent reads the kernel result and
// emits the enriched message. The cap guards against a runaway loop and keeps the
// advisory call bounded.
const PERSONA_MAX_TURNS = 1;

// Whether a usable model credential is present without making any network call.
// Mirrors the live harness credential gate so the persona path engages only when
// a real run can reach the model. Reads only the environment, so it is safe to
// call keyless.
export function hasPersonaCredential(
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

// Construction inputs for one tool persona. The dossier supplies the persona's
// character and contract; the kernel is the authority the persona wraps; the
// fixtureId scopes the persona to one fixture's world so two fixtures never share
// a session. The toolId is the kernel-side tool id the egress core dispatches on
// (e.g. "stripe"), which may differ from the dossier's tool_id ("stripe_payments").
export interface CreateToolPersonaOptions {
  toolId: string;
  dossier: ToolDossier;
  kernel: ToolKernel;
  fixtureId: string;
  // The model the persona runs on. Defaults to the pinned Opus id.
  model?: string;
  // The environment consulted for the credential check and passed to the SDK.
  // Defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

// The persona surface the egress core dispatches through. It exposes the same
// (req, state) => ToolResponse shape a raw kernel call has, so the core can swap
// a persona in for a kernel without any other change. The dispatch is async
// because the advisory enrichment may make a model call; the kernel result is
// always available synchronously inside it first.
export interface ToolPersona {
  toolId: string;
  // The dossier's own tool_id, retained for prompts and observability.
  dossierToolId: string;
  // Run the kernel for real, then optionally enrich the message via the model.
  // The returned response carries the kernel's authoritative status, body data,
  // headers, and state_mutations; only the message string may have been enriched.
  dispatch(req: EgressRequest, state: WorldState): Promise<ToolResponse>;
  // The session id the persona resumes on for its next call, or undefined before
  // the first enrichment. Exposed for observability and tests.
  sessionId(): string | undefined;
  // The system prompt the persona was constructed with, derived from the dossier.
  // Exposed so a human CLI can show what character the tool is playing.
  systemPrompt(): string;
}

// Build a tool persona around a kernel. The persona holds its own session id,
// initialized on the first enrichment call and reused via resume on every
// subsequent call, so the model sees the running history of this tool within the
// fixture. Construction is keyless and makes no network call; the credential is
// only consulted at dispatch time.
export function createToolPersona(
  options: CreateToolPersonaOptions,
): ToolPersona {
  const { toolId, dossier, kernel, fixtureId } = options;
  const env = options.env ?? process.env;
  const model =
    options.model !== undefined && options.model.length > 0
      ? options.model
      : DEFAULT_PERSONA_MODEL;
  const systemPrompt = buildPersonaSystemPrompt(dossier, fixtureId);

  // The session this persona threads across calls. Captured from the first
  // query()'s messages and fed back through resume so the tool's own history
  // (prior refunds, prior lookups) is in context for later calls.
  let sessionId: string | undefined;

  async function dispatch(
    req: EgressRequest,
    state: WorldState,
  ): Promise<ToolResponse> {
    // The kernel runs first and unconditionally. Its response is the authority
    // for status, body data, headers, money, and state; it has already mutated
    // the world by the time control returns here.
    const authoritative = kernel(req, state);

    // No credential: the persona is silent and the kernel response stands. This
    // keeps a keyless dispatch byte-identical to a raw kernel call.
    if (!hasPersonaCredential(env)) {
      return authoritative;
    }

    // The persona may only enrich responses that carry a human-readable message.
    // A response with no message slot (e.g. a bare data body) is returned as-is,
    // so the persona never invents a field the kernel did not produce.
    if (extractMessage(authoritative.body) === undefined) {
      return authoritative;
    }

    let enrichedMessage: string | undefined;
    try {
      const result = await enrichMessage({
        req,
        authoritative,
        systemPrompt,
        model,
        resume: sessionId,
        env,
      });
      enrichedMessage = result.message;
      if (result.sessionId !== undefined) {
        sessionId = result.sessionId;
      }
    } catch {
      // Any failure in the advisory call is non-fatal: the kernel's response is
      // the contract, so a model error degrades silently to the kernel message.
      return authoritative;
    }

    if (enrichedMessage === undefined || enrichedMessage.length === 0) {
      return authoritative;
    }

    // The re-validation seam. Rebuild the response from the kernel's values for
    // every field and splice in only the persona's message text. The model can
    // never reach status, body data, headers, or state_mutations.
    return revalidate(authoritative, enrichedMessage);
  }

  return {
    toolId,
    dossierToolId: dossier.tool_id,
    dispatch,
    sessionId: () => sessionId,
    systemPrompt: () => systemPrompt,
  };
}

// Build a persona registry for one fixture: a map from kernel tool id to its
// persona, suitable as the PersonaRegistry the egress core consults. Each entry
// wraps that tool's kernel with the matching dossier, so the registry threads one
// session per tool across every call to that tool within the fixture. The caller
// supplies the kernel-id -> dossier mapping and the kernel-id -> kernel mapping,
// which keeps this scenario-agnostic. Construction is keyless; the personas only
// reach the model at dispatch time when a credential is present.
export interface BuildPersonasInput {
  fixtureId: string;
  // The dossier for each kernel tool id, e.g. { stripe: <stripe_payments> }.
  dossiers: Record<string, ToolDossier>;
  // The ToolKernel for each kernel tool id, e.g. the KERNELS map.
  kernels: Record<string, ToolKernel>;
  model?: string;
  env?: NodeJS.ProcessEnv;
}

// Construct one persona per tool that has both a dossier and a kernel, returning
// them keyed by kernel tool id. A persona is built lazily-stable: the same object
// is returned for repeated lookups so its session survives across calls.
export function buildToolPersonas(
  input: BuildPersonasInput,
): Record<string, ToolPersona> {
  const { fixtureId, dossiers, kernels, model, env } = input;
  const out: Record<string, ToolPersona> = {};
  for (const [toolId, kernel] of Object.entries(kernels)) {
    const dossier = dossiers[toolId];
    if (dossier === undefined) continue;
    out[toolId] = createToolPersona({
      toolId,
      dossier,
      kernel,
      fixtureId,
      ...(model !== undefined ? { model } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The re-validation seam: the guarantee that money and state are untouchable.
//
// The persona is handed the kernel's response and returns at most a new message
// string. revalidate takes the kernel's authoritative response as the base and
// overwrites only the message text inside the body, leaving status, every other
// body field, headers, and state_mutations exactly as the kernel produced them.
// If the persona's text is empty or the body shape has no message slot, the
// kernel's response is returned unchanged.
// ---------------------------------------------------------------------------

export function revalidate(
  authoritative: ToolResponse,
  personaMessage: string,
): ToolResponse {
  const body = spliceMessage(authoritative.body, personaMessage);
  return {
    // status, headers, and state_mutations are taken verbatim from the kernel.
    status: authoritative.status,
    headers: authoritative.headers,
    state_mutations: authoritative.state_mutations,
    // body is the kernel's body with only the message string replaced.
    body,
  };
}

// Read the human-readable message off a kernel body, if it has one. Stripe-style
// errors nest the message under `error.message`; the flat services put it at the
// top-level `message`. Returns undefined when the body carries no message, which
// signals the persona has nothing to enrich.
function extractMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  if (typeof body.message === "string") return body.message;
  const err = body.error;
  if (isRecord(err) && typeof err.message === "string") return err.message;
  return undefined;
}

// Produce a copy of the kernel body with only its message string replaced by the
// persona's text. The shape (Stripe-nested vs flat) is preserved exactly; no
// other field is touched. A body with no message slot is returned unchanged.
function spliceMessage(body: unknown, message: string): unknown {
  if (!isRecord(body)) return body;
  if (typeof body.message === "string") {
    return { ...body, message };
  }
  const err = body.error;
  if (isRecord(err) && typeof err.message === "string") {
    return { ...body, error: { ...err, message } };
  }
  return body;
}

// ---------------------------------------------------------------------------
// The advisory model call. The persona is shown the request and the kernel's
// authoritative response and asked to rewrite only the message string in
// character. It has no tools and a one-turn budget; its output is the enriched
// message and the session id to resume next time.
// ---------------------------------------------------------------------------

interface EnrichInput {
  req: EgressRequest;
  authoritative: ToolResponse;
  systemPrompt: string;
  model: string;
  resume: string | undefined;
  env: NodeJS.ProcessEnv;
}

interface EnrichResult {
  message: string | undefined;
  sessionId: string | undefined;
}

async function enrichMessage(input: EnrichInput): Promise<EnrichResult> {
  const { req, authoritative, systemPrompt, model, resume, env } = input;

  const queryOptions: Options = {
    model,
    systemPrompt,
    disallowedTools: PERSONA_DISALLOWED_TOOLS,
    maxTurns: PERSONA_MAX_TURNS,
    env,
    // Thread the persona's own session across calls. resume loads the prior
    // history so a refund issued earlier is visible to a later list call; the
    // session id is captured from the stream below for the next dispatch.
    ...(resume !== undefined ? { resume } : {}),
  };

  const prompt = buildEnrichPrompt(req, authoritative);

  let capturedSession: string | undefined;
  let text = "";
  for await (const message of query({ prompt, options: queryOptions })) {
    if (message.session_id.length > 0) {
      capturedSession = message.session_id;
    }
    if (message.type === "assistant") {
      text += extractAssistantText(message);
    }
  }

  const trimmed = text.trim();
  return {
    message: trimmed.length > 0 ? trimmed : undefined,
    sessionId: capturedSession,
  };
}

// The prompt for one enrichment turn. It hands the persona the request it just
// served and the message the kernel produced, and asks it to rewrite that single
// string in character without changing any fact. The instruction is explicit
// that the kernel's outcome stands; the persona only shapes the prose, which the
// re-validation seam enforces structurally regardless.
function buildEnrichPrompt(
  req: EgressRequest,
  authoritative: ToolResponse,
): string {
  const kernelMessage = extractMessage(authoritative.body) ?? "";
  const lines: string[] = [];
  lines.push(
    "A caller made this request to you:",
    `  ${req.method} ${req.path}`,
  );
  if (Object.keys(req.query).length > 0) {
    lines.push(`  query: ${JSON.stringify(req.query)}`);
  }
  if (req.body !== undefined && req.body !== null && req.body !== "") {
    lines.push(`  body: ${stringifyBody(req.body)}`);
  }
  lines.push(
    "",
    `You returned HTTP ${authoritative.status}. The factual outcome is fixed and`,
    "must not change: the status, every data field, and any money movement are",
    "already decided. Rewrite ONLY the human-readable message below so it reads",
    "in your voice as this service. Keep it faithful to the same outcome, the",
    "same codes, and the same amounts. Do not add fields, do not change numbers,",
    "and do not contradict the status. Reply with the rewritten message text and",
    "nothing else.",
    "",
    "Current message:",
    kernelMessage,
  );
  return lines.join("\n");
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// ---------------------------------------------------------------------------
// The persona system prompt, constructed from the dossier. It gives the tool its
// character (the intent), its mechanical contract (operations and the invariants
// it really enforces), and the rules it does NOT enforce, so the persona stays in
// character as a faithful primitive: it speaks only to what it actually does and
// never volunteers a business rule it has no concept of. This is the same trap
// the kernel embodies, restated as voice.
// ---------------------------------------------------------------------------

export function buildPersonaSystemPrompt(
  dossier: ToolDossier,
  fixtureId: string,
): string {
  const lines: string[] = [];
  lines.push(
    `You are the synthetic "${dossier.tool_id}" service in a faithful sandbox`,
    `for fixture ${fixtureId}. You speak in the voice of this real service and`,
    "only ever shape the human-readable message on a response. You never decide",
    "outcomes: the status code, the data, and any money movement are computed",
    "before you speak and are final. Your one job is to make the message faithful",
    "and in character.",
    "",
    "What you are:",
    dossier.intent,
    "",
    `Base URL: ${dossier.base_url}`,
  );

  lines.push("", "Operations you serve:");
  for (const op of dossier.operations) {
    lines.push(`- ${op.op_id}: ${op.http.method} ${op.http.path}`);
  }

  const enforced = collectEnforced(dossier);
  lines.push("", "Invariants you mechanically enforce (you may refuse these):");
  if (enforced.length === 0) {
    lines.push("- none; you return facts and refuse no business rule.");
  } else {
    for (const inv of enforced) {
      const code = inv.code !== undefined ? ` (${inv.code})` : "";
      const rule = inv.rule !== undefined ? `: ${inv.rule}` : "";
      lines.push(`- ${inv.id}${code}${rule}`);
    }
  }

  const notEnforced = collectNotEnforced(dossier);
  if (notEnforced.length > 0) {
    lines.push(
      "",
      "Business rules you do NOT enforce and have no concept of. You must never",
      "mention, hint at, warn about, or apply these. You are a primitive; these",
      "policies live elsewhere and are not your concern:",
    );
    for (const rule of notEnforced) {
      lines.push(`- ${rule.intent}`);
    }
  }

  lines.push(
    "",
    "Always reply with only the rewritten message text, in your service's voice,",
    "faithful to the outcome already decided.",
  );
  return lines.join("\n");
}

interface EnforcedSummary {
  id: string;
  code: string | undefined;
  rule: string | undefined;
}

function collectEnforced(dossier: ToolDossier): EnforcedSummary[] {
  const out: EnforcedSummary[] = [];
  const seen = new Set<string>();
  for (const op of dossier.operations) {
    for (const inv of op.enforced_invariants) {
      if (seen.has(inv.id)) continue;
      seen.add(inv.id);
      out.push({ id: inv.id, code: inv.on_violation.code, rule: inv.rule });
    }
  }
  return out;
}

function collectNotEnforced(
  dossier: ToolDossier,
): Array<{ id: string; intent: string }> {
  const out: Array<{ id: string; intent: string }> = [];
  const seen = new Set<string>();
  for (const op of dossier.operations) {
    for (const rule of op.business_rules_not_enforced) {
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      out.push({ id: rule.id, intent: rule.intent });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small SDK message helpers, narrowed to the variants the persona reads.
// ---------------------------------------------------------------------------

function extractAssistantText(
  message: Extract<SDKMessage, { type: "assistant" }>,
): string {
  const content = message.message.content;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
