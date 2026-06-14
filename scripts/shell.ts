// The human shell: an interactive REPL that lets a person "enter" the synthetic
// company directly. Two modes, both key-gated:
//
//   1. LLM-bash (default): you drop into the LLM-backed bash substrate for a
//      fixture and type shell commands, exactly as the model would. The simulated
//      shell keeps its own evolving filesystem in its session; a command that
//      makes an outbound HTTP call is bridged into the real synthetic tools, so
//      a `curl` to the refunds endpoint moves the same kernel-owned money a scored
//      run would. You are using bash like an LLM, against the real kernels.
//
//   2. Tool persona (--tool <id>): you chat with one synthetic tool in character.
//      Each line you type is a request (`<METHOD> <path> [body]`) the tool's
//      persona serves: the kernel computes the authoritative outcome and any money
//      movement, and the persona rewrites only the human-readable message in the
//      service's voice. The dollar figure, the state, and the status are the
//      kernel's; the prose is the persona's.
//
// Both modes need a model credential. With none, the REPL prints a clear no-key
// message pointing at the keyless proofs and exits 0 WITHOUT calling the API.
//
// One unified trace records everything you do here. Every bridged egress hop is
// stamped with origin "human" (LLM-bash) or "persona" (tool chat) so the trace
// tells your session apart from a scored harness run.
//
// Usage:
//   npm run shell -- --fixture <id>            enter the LLM-bash for a fixture
//   npm run shell -- --fixture <id> --tool stripe   chat with a tool persona
//   npm run shell -- --list                    list fixtures and tools

import { createInterface } from "node:readline";

import type {
  EgressRequest,
  HarnessVersion,
  ToolDossier,
  ToolResponse,
  TraceEvent,
  WorldState,
} from "@/engine";
import { loadRefundPack } from "@/scenarios/refund/index.js";
import { REFUND_DOSSIERS } from "@/scenarios/refund/dossiers.js";
import { KERNELS } from "@/engine/kernels/index.js";
import { seedWorld, KERNEL_TOOL_IDS, type KernelToolId } from "@/world/seed.js";
import {
  handleEgressWithPersona,
  decodeBody,
  createToolPersona,
  hasPersonaCredential,
  createLlmBashSubstrate,
  hasApiKey,
  type NormalizedRequest,
  type SandboxBinding,
  type WireResponse,
  type LlmBashEgressBridge,
} from "@/world/index.js";

// The dossier tool id each kernel service is described by, for persona prompts.
const DOSSIER_FOR_TOOL: Record<KernelToolId, string> = {
  stripe: "stripe_payments",
  orders: "orders",
  customers: "customers",
  policy: "policy_store",
  zendesk: "zendesk_support",
};

interface Args {
  fixture: string | undefined;
  tool: string | undefined;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { fixture: undefined, tool: undefined, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") out.list = true;
    else if (arg === "--fixture") out.fixture = argv[++i];
    else if (arg === "--tool") out.tool = argv[++i];
  }
  return out;
}

function dossierForTool(toolId: KernelToolId): ToolDossier | undefined {
  const dossierId = DOSSIER_FOR_TOOL[toolId];
  return REFUND_DOSSIERS.find((d) => d.tool_id === dossierId);
}

function listFixtures(): void {
  const pack = loadRefundPack();
  process.stdout.write("Fixtures in the refund pack:\n");
  for (const f of pack.fixtures) {
    process.stdout.write(`  ${f.id}  -  ${f.ticket.subject}\n`);
  }
  process.stdout.write("\nTools (for --tool): " + KERNEL_TOOL_IDS.join(", ") + "\n");
}

// One in-process trace writer assigning seq and ts, exactly as the World Runner
// does. It is the single unified trace for this human session.
function makeTrace(): {
  events: TraceEvent[];
  write: (event: Omit<TraceEvent, "v" | "seq" | "ts">) => TraceEvent;
} {
  const events: TraceEvent[] = [];
  let seq = 0;
  const write = (event: Omit<TraceEvent, "v" | "seq" | "ts">): TraceEvent => {
    const full: TraceEvent = {
      v: 1,
      seq: seq++,
      ts: new Date().toISOString(),
      ...event,
    };
    events.push(full);
    return full;
  };
  return { events, write };
}

// Build a NormalizedRequest from a method, path, and optional raw body, decoding
// the body exactly as the gateway would so a form-encoded Stripe call and a JSON
// internal call both parse.
function buildRequest(
  method: string,
  path: string,
  body: string | undefined,
): NormalizedRequest {
  const isJson = body !== undefined && body.trim().startsWith("{");
  const contentType = isJson
    ? "application/json"
    : "application/x-www-form-urlencoded";
  return {
    host: undefined,
    method: method.toUpperCase(),
    path,
    query: {},
    headers: body !== undefined ? { "content-type": contentType } : {},
    body: body !== undefined ? decodeBody(body, contentType) : null,
  };
}

// The friendly no-key exit shared by both modes. The shell is the only human path
// that needs a model credential; without one it prints where the keyless proofs
// live and returns false so main() exits 0 without ever calling the API.
function guardCredential(): boolean {
  if (hasApiKey() && hasPersonaCredential()) {
    return true;
  }
  process.stdout.write(
    "\n  The human shell needs ANTHROPIC_API_KEY or a Claude Code login.\n" +
      "  The keyless proofs are: npm run sweep / npm run sweep:bash, and you can\n" +
      "  drive the kernels keyless with: npm run poke -- --fixture <id> <M> <path>.\n\n",
  );
  return false;
}

// ---------------------------------------------------------------------------
// Mode 1: the LLM-bash REPL.
// ---------------------------------------------------------------------------

async function runLlmBashRepl(fixtureId: string): Promise<void> {
  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) {
    process.stderr.write(`shell: unknown fixture ${fixtureId}\n`);
    process.exitCode = 1;
    return;
  }

  const runId = `shell_${fixtureId}`;
  const version: HarnessVersion = "v1";
  const tag = `tag_${runId}`;
  const world: Record<KernelToolId, WorldState> = seedWorld(
    fixture,
    `${runId}:${fixtureId}`,
  );
  const binding: SandboxBinding = { fixtureId, runId, harnessVersion: version };
  const trace = makeTrace();
  const resolveWorld = (id: string) => (id === fixtureId ? world : undefined);

  // The egress bridge: a simulated outbound call from the LLM-bash session is
  // dispatched into the real synthetic tools through the same egress core a scored
  // run uses, so the kernel moves the money and writes the trace. The wire result
  // is handed back to the substrate to render as the command's output. The hop is
  // stamped origin "human" because a person is driving this shell.
  const bridge: LlmBashEgressBridge = async (
    req: EgressRequest,
  ): Promise<ToolResponse> => {
    const wire: WireResponse = await handleEgressWithPersona({
      binding,
      sandboxId: tag,
      request: {
        host: undefined,
        method: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers,
        body: req.body,
      },
      trace: trace.write,
      resolveWorld,
      origin: "human",
    });
    // The bridge contract returns a ToolResponse. The kernel has already mutated
    // state and the trace recorded each delta; the simulated shell only needs the
    // wire-faithful status, headers, and body to render the command's output, so
    // the stripped state_mutations are empty here by design.
    return {
      status: wire.status,
      headers: wire.headers,
      body: wire.body,
      state_mutations: [],
    };
  };

  const substrate = createLlmBashSubstrate({ sandboxTag: tag, egress: bridge });

  process.stdout.write(
    `\n  LLM-bash shell for fixture ${fixtureId}. Working dir ${substrate.workingDirectory}.\n` +
      "  Type shell commands; outbound HTTP is bridged to the real synthetic tools\n" +
      "  (the kernel owns the money). Type \"quit\" to exit.\n\n",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("$ ");
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "quit" || trimmed === "exit") break;
    if (trimmed.length === 0) {
      rl.prompt();
      continue;
    }
    try {
      const result = await substrate.runCommand({ cmd: trimmed, args: [] });
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (!result.stdout.endsWith("\n") && result.stdout.length > 0) {
        process.stdout.write("\n");
      }
      if (result.stderr.length > 0) {
        process.stdout.write(result.stderr);
        if (!result.stderr.endsWith("\n")) process.stdout.write("\n");
      }
      if (result.exitCode !== 0) {
        process.stdout.write(`[exit ${result.exitCode}]\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`shell error: ${message}\n`);
    }
    rl.prompt();
  }
  rl.close();
  await substrate.dispose();
}

// ---------------------------------------------------------------------------
// Mode 2: chat with a tool persona in character.
// ---------------------------------------------------------------------------

async function runPersonaChat(
  fixtureId: string,
  toolId: KernelToolId,
): Promise<void> {
  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) {
    process.stderr.write(`shell: unknown fixture ${fixtureId}\n`);
    process.exitCode = 1;
    return;
  }
  const dossier = dossierForTool(toolId);
  const kernel = KERNELS[toolId];
  if (dossier === undefined || kernel === undefined) {
    process.stderr.write(`shell: no persona for tool ${toolId}\n`);
    process.exitCode = 1;
    return;
  }

  const world = seedWorld(fixture, `shell_${fixtureId}:${fixtureId}`);
  const state = world[toolId];

  // One persona for this tool, threading its session across the chat so a refund
  // issued earlier is in context for a later request. The kernel inside it stays
  // the authority for status, money, and state; only the message is in character.
  const persona = createToolPersona({ toolId, dossier, kernel, fixtureId });

  process.stdout.write(
    `\n  Chatting with the synthetic "${dossier.tool_id}" service for fixture ${fixtureId}.\n` +
      "  Type a request as \"<METHOD> <path> [body]\"; the service answers in character\n" +
      "  while the kernel owns the outcome. Type \"prompt\" to see its persona, \"quit\" to exit.\n\n",
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(`${dossier.tool_id}> `);
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "quit" || trimmed === "exit") break;
    if (trimmed.length === 0) {
      rl.prompt();
      continue;
    }
    if (trimmed === "prompt") {
      process.stdout.write("\n" + persona.systemPrompt() + "\n\n");
      rl.prompt();
      continue;
    }
    const parts = trimmed.split(/\s+/);
    const method = parts[0];
    const path = parts[1];
    const body = parts.length > 2 ? parts.slice(2).join(" ") : undefined;
    if (method === undefined || path === undefined) {
      process.stdout.write('Expected "<METHOD> <path> [body]".\n');
      rl.prompt();
      continue;
    }
    try {
      const norm = buildRequest(method, path, body);
      const req: EgressRequest = {
        tool_id: toolId,
        sandbox_id: "shell",
        method: norm.method,
        path: norm.path,
        query: norm.query,
        headers: norm.headers,
        body: norm.body,
      };
      const response = await persona.dispatch(req, state);
      process.stdout.write(`\nHTTP ${response.status}\n`);
      process.stdout.write(JSON.stringify(response.body, null, 2) + "\n");
      if (response.state_mutations.length > 0) {
        process.stdout.write("\n[observability] state mutations (kernel-owned):\n");
        for (const m of response.state_mutations) {
          process.stdout.write(
            `  ${m.key}: ${JSON.stringify(m.before)} -> ${JSON.stringify(m.after)}  (${m.reason})\n`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`shell error: ${message}\n`);
    }
    rl.prompt();
  }
  rl.close();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    listFixtures();
    return;
  }

  if (args.fixture === undefined) {
    process.stderr.write(
      "shell: --fixture <id> is required. Run with --list to see fixtures.\n",
    );
    process.exitCode = 1;
    return;
  }

  if (!guardCredential()) {
    return;
  }

  if (args.tool !== undefined) {
    const toolId = args.tool as KernelToolId;
    if (!KERNEL_TOOL_IDS.includes(toolId)) {
      process.stderr.write(
        `shell: unknown tool ${args.tool}. Tools: ${KERNEL_TOOL_IDS.join(", ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    await runPersonaChat(args.fixture, toolId);
    return;
  }

  await runLlmBashRepl(args.fixture);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`shell: ${message}\n`);
  process.exitCode = 1;
});
