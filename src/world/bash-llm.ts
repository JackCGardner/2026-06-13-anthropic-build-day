// The LLM-backed Bash substrate: an alternative implementation of the same
// BashSubstrate seam the local-exec stand-in (bash-local.ts) and the live Vercel
// Sandbox (bash-vercel.ts) implement. Instead of running a command on a real
// shell, this substrate hands the command to a Claude Agent SDK agent that
// SIMULATES a shell: the agent keeps an evolving virtual filesystem and process
// state inside its own session, and for each command returns a plausible
// { exitCode, stdout, stderr } consistent with everything it has produced so far
// in that session (doc 11 M2, the LLM-bash discussion).
//
// This is for exploration and human use, not for scored runs. The substrate
// decision for scored runs stands: real execution is the point, so bash-local
// and bash-vercel remain the default substrates the World Runner and the bash
// tool use. The LLM-bash substrate is selected explicitly, by a flag or a human
// REPL choosing to "use bash like an LLM". It implements the identical
// BashSubstrate.runCommand surface, so the bash tool, the trace hops, and the
// gateway egress contract are all unchanged above this file.
//
// Egress still resolves to the synthetic tools. The simulated shell is told,
// through its system prompt, that it lives behind the same egress gateway: a
// command that makes an outbound HTTP call (curl, a generated client) is one the
// agent must NOT answer from its own imagination. It emits a sentinel that this
// substrate intercepts and dispatches through the real gateway/egress contract,
// so a network call from inside LLM-bash reaches the deterministic kernels exactly
// as it would from a real substrate, and the kernel stays the source of truth for
// state and money. With no sentinel, a pure-filesystem command is simulated by the
// model alone.
//
// Auth is read from env only. A keyless construction throws a typed
// MissingApiKeyError BEFORE any network call, so a keyless environment fails loud
// and never reaches the model, exactly like the Vercel substrate's auth gate.

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { EgressRequest, ToolResponse } from "@/engine";

// ---------------------------------------------------------------------------
// Result and seed shapes, matching the BashSubstrate seam and the sibling
// substrates exactly so a fixture's command reads identically on every path.
// ---------------------------------------------------------------------------

// The result of one simulated command: the same shape the seam and the real
// substrates' BashResult / VercelBashResult carry.
export interface LlmBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// A seed file to materialize in the simulated filesystem before any command runs.
// The agent is told these files exist with this content; subsequent commands see
// them. The local equivalent of provisioning the working directory.
export interface LlmSeedFile {
  // Path inside the simulated filesystem, e.g. "/work/refund.sh" or "refund.sh".
  path: string;
  contents: string;
  // Optional POSIX mode the simulated shell should report, e.g. 0o755.
  mode?: number;
}

// ---------------------------------------------------------------------------
// Egress bridge: how a simulated outbound call reaches the real synthetic tools.
// ---------------------------------------------------------------------------

// The dispatch contract the LLM-bash substrate uses to send an outbound HTTP call
// the simulated shell produced into the real egress path. It is the same
// EgressRequest -> ToolResponse contract the gateway and the kernels speak, so a
// curl from inside LLM-bash resolves to the deterministic kernel, not the model's
// imagination. The bridge is async because the live egress path may run a persona
// enrichment before returning. When no bridge is supplied, the substrate runs in
// pure-simulation mode and the agent is told there is no network.
export type LlmBashEgressBridge = (req: EgressRequest) => Promise<ToolResponse>;

// ---------------------------------------------------------------------------
// Construction options.
// ---------------------------------------------------------------------------

export interface LlmBashSubstrateOptions {
  // The synthetic sandbox tag this simulated shell is bound to, carried into the
  // EgressRequest the bridge dispatches so the gateway resolves (fixtureId, runId)
  // exactly as it would for a real substrate's outbound call.
  sandboxTag: string;
  // The egress bridge into the real synthetic tools. Omit it to run a pure
  // filesystem simulation with no network (the agent is told the network is down).
  egress?: LlmBashEgressBridge;
  // The model the simulated shell runs on. Defaults to the pinned Opus id.
  model?: string;
  // The working directory the simulated shell starts in, surfaced to the agent so
  // its prompt and relative paths are consistent. Defaults to "/work".
  workingDirectory?: string;
  // The environment consulted for the credential check and passed to the SDK.
  // Defaults to process.env.
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// Typed auth failure.
// ---------------------------------------------------------------------------

// The environment-variable names the substrate accepts as a usable model
// credential. ANTHROPIC_API_KEY is the primary; the OAuth token and the SDK's
// ambient-auth flag are accepted so a developer signed in to Claude Code can use
// the simulated shell without exporting a raw key.
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY" as const;
export const CLAUDE_CODE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN" as const;
export const CLAUDE_AGENT_SDK_AMBIENT_AUTH_ENV =
  "CLAUDE_AGENT_SDK_AMBIENT_AUTH" as const;

// Thrown when no model credential is present in env. Raised from the env-only
// auth check BEFORE any query() runs, so a keyless construction fails loud and
// never reaches the network, mirroring the Vercel substrate's auth gate.
export class MissingApiKeyError extends Error {
  readonly code = "missing_api_key" as const;
  constructor(message?: string) {
    super(
      message ??
        `Missing model credential: set ${ANTHROPIC_API_KEY_ENV}, or ` +
          `${CLAUDE_CODE_OAUTH_TOKEN_ENV}, or ${CLAUDE_AGENT_SDK_AMBIENT_AUTH_ENV}. ` +
          `The LLM-backed Bash substrate cannot simulate a shell without a credential.`,
    );
    this.name = "MissingApiKeyError";
    // Preserve the prototype chain so `instanceof` works after transpilation.
    Object.setPrototypeOf(this, MissingApiKeyError.prototype);
  }
}

// Whether a usable model credential is present, without making any network call.
// Reads only the environment, so it is safe to call keyless.
export function hasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    nonEmpty(env[ANTHROPIC_API_KEY_ENV]) ||
    nonEmpty(env[CLAUDE_CODE_OAUTH_TOKEN_ENV]) ||
    nonEmpty(env[CLAUDE_AGENT_SDK_AMBIENT_AUTH_ENV])
  );
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Defaults and the egress sentinel protocol.
// ---------------------------------------------------------------------------

// The model the simulated shell runs on. Pinned to Opus to match the live
// harness; a caller may override it per substrate.
const DEFAULT_MODEL = "claude-opus-4-8";

// The default working directory the simulated shell starts in.
const DEFAULT_WORKDIR = "/work";

// The simulated shell uses no tools: it neither runs real commands nor reaches
// the network itself. Outbound calls are surfaced as a sentinel this substrate
// intercepts and routes through the real egress bridge instead.
const SIMULATED_SHELL_DISALLOWED_TOOLS: string[] = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
];

// One simulated command is one agent turn: the agent reads the command and the
// running session state and emits the result. The cap guards against a runaway
// loop and keeps each command bounded.
const SIMULATE_MAX_TURNS = 1;

// The sentinel the simulated shell emits, on its own line, when a command would
// make an outbound HTTP call. The JSON after the marker is an EgressRequest-shaped
// object this substrate parses and dispatches through the real egress bridge,
// then feeds the kernel's wire-faithful response back into the session so the
// agent renders the command's stdout/stderr around the real result. This keeps
// network truth with the kernels and the model only in charge of shell framing.
const EGRESS_SENTINEL = "__SYNTH_EGRESS__";

// ---------------------------------------------------------------------------
// The substrate.
// ---------------------------------------------------------------------------

// The LLM-backed Bash substrate. One instance owns one simulated-shell session
// for the lifetime of one exploration; its session id threads every command so
// the virtual filesystem and process state evolve coherently. Implements the
// BashSubstrate seam, so the bash tool and the World Runner use it unchanged.
export class LlmBashSubstrate {
  private sessionId: string | undefined;
  private disposed = false;
  private readonly sandboxTag: string;
  private readonly bridge: LlmBashEgressBridge | undefined;
  private readonly model: string;
  private readonly workdir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly systemPromptText: string;
  // Seed files described to the agent on the FIRST command, then folded into its
  // session history. Held until the first command so a pure construction is
  // keyless and makes no network call.
  private pendingSeeds: LlmSeedFile[] = [];

  constructor(options: LlmBashSubstrateOptions) {
    // Resolve auth from env BEFORE anything else so a keyless construction is a
    // loud, early MissingApiKeyError rather than a deferred query failure. A
    // caller that has already gated on hasApiKey gets the same guarantee here.
    this.env = options.env ?? process.env;
    if (!hasApiKey(this.env)) {
      throw new MissingApiKeyError();
    }
    this.sandboxTag = options.sandboxTag;
    this.bridge = options.egress;
    this.model =
      options.model !== undefined && options.model.length > 0
        ? options.model
        : DEFAULT_MODEL;
    this.workdir =
      options.workingDirectory !== undefined && options.workingDirectory.length > 0
        ? options.workingDirectory
        : DEFAULT_WORKDIR;
    this.systemPromptText = buildShellSystemPrompt({
      workdir: this.workdir,
      hasNetwork: this.bridge !== undefined,
    });
  }

  // The working directory the simulated shell reports, surfaced on the shell hop
  // for the viewer the same way the local substrate exposes its temp directory.
  get workingDirectory(): string {
    return this.workdir;
  }

  // The system prompt the simulated shell was constructed with. Exposed so a
  // human CLI can show what shell the agent is playing.
  systemPrompt(): string {
    return this.systemPromptText;
  }

  // The session id the simulated shell threads its filesystem state on, or
  // undefined before the first command. Exposed for observability and tests.
  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  // Queue seed files to materialize in the simulated filesystem before the first
  // command runs. They are described to the agent on the first command and then
  // live in its session. Keyless and side-effect-free until the first command.
  async writeSeedFiles(files: LlmSeedFile[]): Promise<void> {
    this.pendingSeeds.push(...files);
  }

  // Run one command against the simulated shell. The command is sent to the agent
  // along with any pending seed description; the agent returns the result, and if
  // the command made an outbound HTTP call it emits the egress sentinel, which we
  // dispatch through the real bridge and feed back so the agent frames the real
  // kernel response as the command's output. A disposed substrate reports the
  // kill uniformly rather than throwing, matching the sibling substrates.
  async runCommand(input: {
    cmd: string;
    args: string[];
  }): Promise<LlmBashResult> {
    if (this.disposed) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: "LlmBashSubstrate: substrate disposed",
      };
    }

    const commandLine = composeCommandLine(input.cmd, input.args);
    if (commandLine.trim().length === 0) {
      return { exitCode: 2, stdout: "", stderr: "LlmBashSubstrate: empty command" };
    }

    const seedPreamble = this.takeSeedPreamble();
    const firstPrompt = `${seedPreamble}${buildCommandPrompt(commandLine)}`;

    // First turn: ask the simulated shell to run the command. It either returns a
    // result JSON or emits the egress sentinel for an outbound call.
    const first = await this.turn(firstPrompt);
    const sentinel = extractEgressRequest(first.text, this.sandboxTag);
    if (sentinel === undefined) {
      return parseResult(first.text);
    }

    // The command makes a network call. Dispatch it through the real egress
    // bridge so the deterministic kernel answers (and mutates money/state), never
    // the model. With no bridge the simulated network is down and we report a
    // connection failure, which is itself a faithful command outcome.
    if (this.bridge === undefined) {
      return {
        exitCode: 7,
        stdout: "",
        stderr: `curl: (7) Failed to connect to ${sentinel.host}: network unavailable`,
      };
    }
    const response = await this.bridge(sentinel.request);

    // Second turn: hand the real kernel response back so the agent renders the
    // command's stdout/stderr and exit code around the actual wire bytes. The
    // session is resumed so the simulated filesystem state is preserved across
    // this two-step exchange.
    const second = await this.turn(buildEgressResultPrompt(response));
    return parseResult(second.text);
  }

  // Retire the substrate. Idempotent; the SDK session is dropped, so a later
  // command after dispose reports the kill uniformly.
  async dispose(): Promise<void> {
    this.disposed = true;
    this.sessionId = undefined;
    this.pendingSeeds = [];
  }

  // Drain the queued seed files into a one-time preamble for the next command,
  // describing each file so the simulated filesystem starts populated. Returns an
  // empty string once the seeds have been folded into the session.
  private takeSeedPreamble(): string {
    if (this.pendingSeeds.length === 0) {
      return "";
    }
    const files = this.pendingSeeds;
    this.pendingSeeds = [];
    const lines: string[] = [
      "Before this command runs, your simulated filesystem already contains these",
      "files. Treat them as present with exactly this content for every command:",
    ];
    for (const f of files) {
      const mode = f.mode !== undefined ? ` (mode ${f.mode.toString(8)})` : "";
      lines.push(
        "",
        `--- file: ${f.path}${mode} ---`,
        f.contents,
        `--- end file: ${f.path} ---`,
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  // Run one agent turn over the session, capturing the assistant text and the
  // session id to resume on the next turn. The first turn opens the session; every
  // subsequent turn resumes it so the simulated filesystem state persists.
  private async turn(prompt: string): Promise<{ text: string }> {
    const options: Options = {
      model: this.model,
      systemPrompt: this.systemPromptText,
      disallowedTools: SIMULATED_SHELL_DISALLOWED_TOOLS,
      maxTurns: SIMULATE_MAX_TURNS,
      env: this.env,
      // Thread the simulated shell's own session so its evolving filesystem and
      // process state are in context for every later command.
      ...(this.sessionId !== undefined ? { resume: this.sessionId } : {}),
    };

    let text = "";
    for await (const message of query({ prompt, options })) {
      if (message.session_id.length > 0) {
        this.sessionId = message.session_id;
      }
      if (message.type === "assistant") {
        text += extractAssistantText(message);
      }
    }
    return { text };
  }
}

// Construct an LLM-bash substrate. The auth check runs in the constructor, so a
// keyless call throws MissingApiKeyError before any network call is reached.
export function createLlmBashSubstrate(
  options: LlmBashSubstrateOptions,
): LlmBashSubstrate {
  return new LlmBashSubstrate(options);
}

// ---------------------------------------------------------------------------
// Prompt construction.
// ---------------------------------------------------------------------------

// Build the system prompt that turns the agent into a faithful simulated shell.
// It fixes the contract: maintain an evolving virtual filesystem in the session,
// answer every command with a strict result JSON, and surface any outbound HTTP
// call as the egress sentinel rather than inventing a network response. The
// network clause flips on whether an egress bridge is wired.
function buildShellSystemPrompt(input: {
  workdir: string;
  hasNetwork: boolean;
}): string {
  const lines: string[] = [
    "You are simulating a POSIX bash shell on Amazon Linux. You maintain a single,",
    "coherent, evolving virtual filesystem and process state across the whole",
    "session: every command you run can see the effects of every command before it.",
    `The shell starts in the working directory ${input.workdir}.`,
    "",
    "For each command you are given, decide what a real bash shell would do given",
    "the current state of your simulated filesystem, then update that state and",
    "report the outcome. Be plausible and internally consistent: a file written by",
    "an earlier command exists for a later one; an exit code reflects what happened.",
    "",
    "Reply with EXACTLY one JSON object and nothing else, on a single line, of the",
    'shape {"exitCode": <number>, "stdout": <string>, "stderr": <string>}. Do not',
    "wrap it in code fences and do not add any prose around it.",
  ];

  if (input.hasNetwork) {
    lines.push(
      "",
      "Network: you are behind an egress gateway. You must NEVER invent the result",
      "of an outbound HTTP call (curl, wget, a generated API client, or any request",
      "that leaves the machine). When a command makes such a call, do NOT produce",
      "the result JSON. Instead reply with EXACTLY one line of the shape:",
      `${EGRESS_SENTINEL} {"host": <string>, "method": <string>, "path": <string>,`,
      ' "query": <object of string->string>, "headers": <object of string->string>,',
      ' "body": <string|object|null>}',
      "describing the outbound request the command would send. The gateway will",
      "execute it for real and hand you the response on the next turn, which you",
      "then render as the command's stdout/stderr and exit code in the result JSON.",
      "Only one outbound call per command; emit the sentinel for the first one.",
    );
  } else {
    lines.push(
      "",
      "Network: there is no network. Any command that tries to make an outbound",
      "HTTP call (curl, wget, an API client) fails with a connection error and a",
      "non-zero exit code, reported in the result JSON like any other failure.",
    );
  }

  return lines.join("\n");
}

// The prompt for one command turn: just the command line, framed so the agent
// runs it against the current simulated state.
function buildCommandPrompt(commandLine: string): string {
  return [
    "Run this command in the simulated shell and report the result:",
    "",
    commandLine,
  ].join("\n");
}

// The prompt that hands the real kernel response back after an egress dispatch,
// so the agent frames it as the command's output. The wire response is given as
// the gateway returned it; the agent renders the bytes a tool like curl would
// print and chooses the exit code curl would set.
function buildEgressResultPrompt(response: ToolResponse): string {
  const bodyText = stringifyBody(response.body);
  return [
    "The egress gateway executed that outbound call and returned this real HTTP",
    "response. Render the command's output as the client (e.g. curl) would print",
    "it, and set the exit code as that client would. Reply with the result JSON.",
    "",
    `HTTP status: ${response.status}`,
    `Headers: ${stringifyBody(response.headers)}`,
    "Body:",
    bodyText,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Parsing helpers.
// ---------------------------------------------------------------------------

// Parse the simulated shell's result JSON into an LlmBashResult. A reply that is
// not the agreed shape is reported as a non-zero result with the raw text on
// stderr, so a malformed turn is a visible failure rather than a silent default.
function parseResult(text: string): LlmBashResult {
  const json = extractJsonObject(text);
  if (json === undefined) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `LlmBashSubstrate: shell did not return a result JSON: ${text.trim()}`,
    };
  }
  const exitCode = typeof json.exitCode === "number" ? json.exitCode : 1;
  const stdout = typeof json.stdout === "string" ? json.stdout : "";
  const stderr = typeof json.stderr === "string" ? json.stderr : "";
  return { exitCode, stdout, stderr };
}

// Detect and parse the egress sentinel line into an EgressRequest the bridge can
// dispatch. Returns undefined when the reply is not an egress sentinel, in which
// case the reply is a normal result JSON. The sandbox tag is stamped onto the
// request as the binding the gateway resolves; the model never supplies it.
function extractEgressRequest(
  text: string,
  sandboxTag: string,
): { host: string; request: EgressRequest } | undefined {
  const idx = text.indexOf(EGRESS_SENTINEL);
  if (idx < 0) {
    return undefined;
  }
  const after = text.slice(idx + EGRESS_SENTINEL.length);
  const json = extractJsonObject(after);
  if (json === undefined) {
    return undefined;
  }
  const host = typeof json.host === "string" ? json.host : "";
  const method = typeof json.method === "string" ? json.method : "GET";
  const path = typeof json.path === "string" ? json.path : "/";
  const query = asStringRecord(json.query);
  const headers = asStringRecord(json.headers);
  // The tool_id is left empty: the gateway/egress core resolves the tool from the
  // host and path exactly as it does for a real substrate's intercepted call. The
  // binding tag rides along so the gateway maps it to (fixtureId, runId).
  const request: EgressRequest = {
    tool_id: "",
    sandbox_id: sandboxTag,
    method: method.toUpperCase(),
    path,
    query,
    headers,
    body: json.body ?? null,
  };
  return { host, request };
}

// Extract the first balanced top-level JSON object from a string. The simulated
// shell is instructed to emit a bare JSON object, but a stray prose wrapper is
// tolerated by scanning for the first balanced { ... } and parsing it.
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          return isRecord(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

// Coerce an unknown into a flat string->string record, dropping non-string
// values, for the query and header maps the EgressRequest carries.
function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) {
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") {
      out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    }
  }
  return out;
}

// Compose a program and its argv into a single command line, matching the sibling
// substrates so a fixture's command reads identically across every path.
function composeCommandLine(cmd: string, args: string[]): string {
  if (args.length === 0) {
    return cmd;
  }
  return [cmd, ...args.map(shellQuote)].join(" ");
}

// Single-quote one argument for POSIX shells, escaping embedded single quotes.
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

// ---------------------------------------------------------------------------
// SDK message helpers, narrowed to the variants this substrate reads.
// ---------------------------------------------------------------------------

function extractAssistantText(
  message: Extract<SDKMessage, { type: "assistant" }>,
): string {
  const content = message.message.content;
  if (!Array.isArray(content)) {
    return "";
  }
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
