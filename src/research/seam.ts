// The research seam: the single interface every web or model call in the
// pipeline goes through. It mirrors the credential gate the live harness and the
// tool persona already use, so the research path engages the network only when a
// real run can reach it. With no model credential and no asserted web access the
// seam is unavailable, and every stage that needs it throws a typed
// MissingResearchCapabilityError before any network call is attempted. This is
// the no-network-keyless guarantee, stated as a constructor gate rather than a
// hope: a keyless process can build, typecheck, and run the reproduction path,
// and the live stages fail fast and clearly the moment they are asked to reach
// the network without a key.
//
// The three operations the seam exposes map one-to-one to the Agent SDK and its
// web tools, grounded in the real API (doc 07 sources): web search via the
// WebSearch tool, document fetch via the WebFetch tool, and a structured model
// call via query(). The seam carries only the shapes the stages need; the live
// implementation is constructed by createLiveResearchCapability, which wires the
// SDK behind the same interface. The keyless build never constructs it.

import {
  createSdkMcpServer,
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

// The model the research stages drive. Pinned to Opus to match the live harness
// and the tool persona; the pipeline never downgrades the model for a stage.
const DEFAULT_RESEARCH_MODEL = "claude-opus-4-8";

// One web search result the discovery stage ranks. The shape is the subset of a
// WebSearch result the stages consume: the page title, its url, and a snippet.
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

// One fetched document the acquisition stage parses. `prompt` is the extraction
// instruction the WebFetch tool runs over the fetched content, so the returned
// text is already the model's read of the page against that instruction, not raw
// HTML the stage would have to parse itself.
export interface FetchedDocument {
  url: string;
  // The model's extraction of the fetched content against the acquisition
  // prompt: the operations, constraints, and intent it found.
  content: string;
}

// The seam every web or model call in the pipeline goes through. Each method is
// async because the live implementation makes a network call; the keyless build
// never holds an instance, because the seam is unavailable without a credential.
export interface ResearchCapability {
  // Whether the seam can reach the network. Always true for a live instance;
  // the keyless build never constructs one, so a stage consults the factory's
  // gate, not this flag, to decide whether to proceed.
  readonly available: true;
  // Issue one web search and return the ranked results (doc 07 section 3.2).
  webSearch(input: {
    query: string;
    allowed_domains?: string[];
  }): Promise<WebSearchResult[]>;
  // Fetch one document and extract against the prompt (doc 07 section 3.3).
  webFetch(input: { url: string; prompt: string }): Promise<FetchedDocument>;
  // One structured model call: a system prompt plus a user prompt, returning the
  // model's text. Stages parse the text as JSON against their own schema. This
  // is the decomposition, intent-extraction, and completeness call surface.
  complete(input: {
    system: string;
    prompt: string;
    maxTurns?: number;
  }): Promise<string>;
}

// Thrown before any network call when no usable research credential or web
// access is present. Every live stage gates on the seam's availability and
// raises this rather than emitting an opaque transport error, so a keyless
// environment fails fast with a clear, actionable message.
export class MissingResearchCapabilityError extends Error {
  override readonly name = "MissingResearchCapabilityError";
  constructor(stage: string) {
    super(
      `Research stage "${stage}" requires web access and a model credential. ` +
        "Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN and assert web " +
        "access via RESEARCH_WEB_ACCESS=1, or run reproduceRefundBundle() for " +
        "the keyless refund reproduction. No credential was found, so no " +
        "network call was made.",
    );
  }
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0;
}

// Whether a usable model credential is present without making any network call.
// Mirrors the live harness and tool persona gates so the research path engages
// only when a real run can reach the model. Reads only the environment.
export function hasResearchCredential(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    nonEmpty(env.ANTHROPIC_API_KEY) ||
    nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN) ||
    nonEmpty(env.CLAUDE_AGENT_SDK_AMBIENT_AUTH)
  );
}

// Whether web access is asserted for this process. Web research is a separate
// grant from the model credential: a process may hold a key yet run in a
// network-isolated context where WebSearch and WebFetch cannot reach out, so the
// pipeline requires an explicit assertion before it attempts a web call.
export function hasWebAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  return nonEmpty(env.RESEARCH_WEB_ACCESS);
}

// Whether the full research capability is available: a model credential and an
// asserted web grant. The factory consults this before constructing a live
// instance; a stage consults it before proceeding. Reads only the environment,
// so it is safe to call keyless.
export function hasResearchCapability(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return hasResearchCredential(env) && hasWebAccess(env);
}

// Build the live research capability, or throw if the credential or web grant is
// absent. The keyless build never calls this; the reproduction path returns a
// committed bundle with no seam at all. The live implementation wires the SDK's
// WebSearch and WebFetch tools and query() behind the seam interface, grounded
// in the real API per doc 07 sources.
export function createLiveResearchCapability(options?: {
  model?: string;
  env?: NodeJS.ProcessEnv;
}): ResearchCapability {
  const env = options?.env ?? process.env;
  if (!hasResearchCapability(env)) {
    throw new MissingResearchCapabilityError("createLiveResearchCapability");
  }
  const model =
    options?.model !== undefined && options.model.length > 0
      ? options.model
      : DEFAULT_RESEARCH_MODEL;

  return new LiveResearchCapability(model, env);
}

// The live seam implementation. Each call drives a bounded query() with the
// relevant built-in web tool allowed, drains the stream for the model's text or
// the tool's structured results, and returns the shape the stages consume. The
// model is pinned and the turn budget is tight, because each call is a single
// extraction step, not an open-ended agent loop.
class LiveResearchCapability implements ResearchCapability {
  readonly available = true as const;

  constructor(
    private readonly model: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async webSearch(input: {
    query: string;
    allowed_domains?: string[];
  }): Promise<WebSearchResult[]> {
    // Drive a single search turn with only the WebSearch tool allowed, then ask
    // the model to return the ranked results as JSON. The model is instructed to
    // emit nothing but the JSON array, which this method parses.
    const domains =
      input.allowed_domains !== undefined && input.allowed_domains.length > 0
        ? `Only include results from these domains: ${input.allowed_domains.join(", ")}.`
        : "";
    const text = await this.runQuery({
      system:
        "You are a tool-discovery researcher. Use WebSearch to find candidate " +
        "tools and contracts, then return ONLY a JSON array of " +
        '{ "title": string, "url": string, "snippet": string } objects, ' +
        "best matches first.",
      prompt: `Search for: ${input.query}. ${domains}`,
      allowedTools: ["WebSearch"],
      maxTurns: 4,
    });
    return parseJsonArray<WebSearchResult>(text);
  }

  async webFetch(input: {
    url: string;
    prompt: string;
  }): Promise<FetchedDocument> {
    const text = await this.runQuery({
      system:
        "You are a contract-acquisition researcher. Use WebFetch on the given " +
        "URL to extract exactly what the instruction asks for. Return only the " +
        "extracted content.",
      prompt: `Fetch ${input.url} and extract: ${input.prompt}`,
      allowedTools: ["WebFetch"],
      maxTurns: 4,
    });
    return { url: input.url, content: text };
  }

  async complete(input: {
    system: string;
    prompt: string;
    maxTurns?: number;
  }): Promise<string> {
    return this.runQuery({
      system: input.system,
      prompt: input.prompt,
      allowedTools: [],
      maxTurns: input.maxTurns ?? 1,
    });
  }

  // Drive one bounded query() and return the concatenated assistant text. The
  // allowed built-in tools are passed through so a search or fetch turn can use
  // WebSearch or WebFetch, and a pure structured call allows no tools at all.
  private async runQuery(input: {
    system: string;
    prompt: string;
    allowedTools: string[];
    maxTurns: number;
  }): Promise<string> {
    // An empty in-process MCP server keeps the query() surface uniform with the
    // rest of the codebase; the built-in web tools are enabled via allowedTools
    // and the `tools` preset, not through this server.
    const server = createSdkMcpServer({
      name: "research-seam",
      version: "1.0.0",
      tools: [],
    });

    const options: Options = {
      model: this.model,
      systemPrompt: input.system,
      mcpServers: { "research-seam": server },
      allowedTools: input.allowedTools,
      tools: input.allowedTools.length > 0 ? input.allowedTools : [],
      maxTurns: input.maxTurns,
      env: this.env as Record<string, string | undefined>,
    };

    const stream = query({ prompt: input.prompt, options });
    const parts: string[] = [];
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      if (message.type === "assistant") {
        parts.push(extractText(message.message.content));
      }
    }
    return parts.join("").trim();
  }
}

// Pull the visible text from a completed assistant message's content blocks.
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}

// Parse a JSON array from model text, tolerating a leading or trailing prose
// wrapper by extracting the first bracketed array. Throws on malformed output so
// a live stage fails loudly rather than passing a partial result downstream.
function parseJsonArray<T>(text: string): T[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("research seam expected a JSON array, found none");
  }
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("research seam expected a JSON array");
  }
  return parsed as T[];
}
