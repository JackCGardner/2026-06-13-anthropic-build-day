// A human "poke" CLI for the synthetic tool agents. A person can send a request
// to any tool in a fixture's world and see both the wire-faithful response the
// sandbox would receive AND the stripped observability channel (the state
// mutations and the enforced-invariant overlay) that never crosses the wire. One
// unified trace records every hop, exactly as a scored run does.
//
// Two persona modes:
//   - default (kernel only): the deterministic kernel serves the call. Keyless,
//     byte-identical to a scored run. This is always available.
//   - persona (--persona): each tool is wrapped in its Claude Agent SDK persona,
//     which may enrich the message prose in character. Engages only when a model
//     credential is present; the re-validation seam keeps money and state fixed.
//
// Two interaction modes:
//   - single shot: pass METHOD and PATH on the command line, with an optional
//     --body, and the response prints once.
//   - interactive (--repl): type "<tool> <METHOD> <path> [body]" lines and read
//     the response and observability for each, with the persona session threading
//     across calls so an earlier refund is visible to a later read.
//
// Usage:
//   tsx scripts/poke-tool.ts --fixture <id> <METHOD> <path> [--body '<raw>'] [--persona]
//   tsx scripts/poke-tool.ts --fixture <id> --repl [--persona]
//   tsx scripts/poke-tool.ts --list

import { createInterface } from "node:readline";

import type {
  HarnessVersion,
  ToolDossier,
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
  type NormalizedRequest,
  type SandboxBinding,
  type PersonaRegistry,
} from "@/world/egress-core.js";
import {
  buildToolPersonas,
  hasPersonaCredential,
} from "@/world/tool-persona.js";

// The dossier for each kernel tool id, resolved from the committed refund pack.
const DOSSIER_FOR_TOOL: Record<KernelToolId, string> = {
  stripe: "stripe_payments",
  orders: "orders",
  customers: "customers",
  policy: "policy_store",
  zendesk: "zendesk_support",
};

interface Args {
  fixture: string | undefined;
  method: string | undefined;
  path: string | undefined;
  body: string | undefined;
  persona: boolean;
  repl: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    fixture: undefined,
    method: undefined,
    path: undefined,
    body: undefined,
    persona: false,
    repl: false,
    list: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--persona") out.persona = true;
    else if (arg === "--repl") out.repl = true;
    else if (arg === "--list") out.list = true;
    else if (arg === "--fixture") out.fixture = argv[++i];
    else if (arg === "--body") out.body = argv[++i];
    else if (arg !== undefined) positional.push(arg);
  }
  out.method = positional[0];
  out.path = positional[1];
  return out;
}

// Resolve the dossiers keyed by kernel tool id from the refund pack.
function dossiersByToolId(): Record<string, ToolDossier> {
  const out: Record<string, ToolDossier> = {};
  for (const toolId of KERNEL_TOOL_IDS) {
    const dossierId = DOSSIER_FOR_TOOL[toolId];
    const dossier = REFUND_DOSSIERS.find((d) => d.tool_id === dossierId);
    if (dossier !== undefined) out[toolId] = dossier;
  }
  return out;
}

function listFixtures(): void {
  const pack = loadRefundPack();
  process.stdout.write("Fixtures in the refund pack:\n");
  for (const f of pack.fixtures) {
    process.stdout.write(`  ${f.id}  -  ${f.ticket.subject}\n`);
  }
  process.stdout.write(
    "\nTools: " + KERNEL_TOOL_IDS.join(", ") + "\n",
  );
}

// One in-process trace writer assigning seq and ts, exactly as the World Runner
// does. It collects every hop so the CLI can print the observability channel.
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

// Build the normalized request from a method, a path, and an optional raw body.
// A body is decoded the same way the gateway decodes it, so a form-encoded Stripe
// call and a JSON internal call both parse correctly.
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

// Print the response and the stripped observability for one poke. The wire body
// is what the sandbox would see; the state mutations and the enforced-invariant
// overlay are the channel the gateway strips before the bytes cross.
function printOutcome(
  wire: { status: number; body: unknown },
  events: TraceEvent[],
): void {
  process.stdout.write(`\nHTTP ${wire.status}\n`);
  process.stdout.write(JSON.stringify(wire.body, null, 2) + "\n");

  const mutations = events.filter((e) => e.kind === "state_mutation");
  if (mutations.length > 0) {
    process.stdout.write("\n[observability] state mutations (stripped from wire):\n");
    for (const m of mutations) {
      const p = m.payload as { key?: unknown; before?: unknown; after?: unknown; reason?: unknown };
      process.stdout.write(
        `  ${String(p.key)}: ${JSON.stringify(p.before)} -> ${JSON.stringify(p.after)}  (${String(p.reason)})\n`,
      );
    }
  }
  const egressEnd = events.find(
    (e) => e.kind === "egress" && e.span.phase === "end",
  );
  const checked =
    egressEnd === undefined
      ? undefined
      : (egressEnd.payload as { enforced_invariants_checked?: unknown }).enforced_invariants_checked;
  if (Array.isArray(checked) && checked.length > 0) {
    process.stdout.write(
      `\n[observability] enforced invariants checked: ${checked.join(", ")}\n`,
    );
  }
  const origin =
    egressEnd === undefined
      ? undefined
      : (egressEnd.payload as { origin?: unknown }).origin;
  if (typeof origin === "string") {
    process.stdout.write(`\n[observability] trace origin: ${origin}\n`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    listFixtures();
    return;
  }

  if (args.fixture === undefined) {
    process.stderr.write(
      "poke-tool: --fixture <id> is required. Run with --list to see fixtures.\n",
    );
    process.exitCode = 1;
    return;
  }

  const pack = loadRefundPack();
  const fixture = pack.fixtures.find((f) => f.id === args.fixture);
  if (fixture === undefined) {
    process.stderr.write(`poke-tool: unknown fixture ${args.fixture}\n`);
    process.exitCode = 1;
    return;
  }

  const runId = `poke_${args.fixture}`;
  const version: HarnessVersion = "v1";
  const world: Record<KernelToolId, WorldState> = seedWorld(
    fixture,
    `${runId}:${args.fixture}`,
  );
  const binding: SandboxBinding = {
    fixtureId: args.fixture,
    runId,
    harnessVersion: version,
  };
  const trace = makeTrace();

  // Persona mode: build one persona per tool, but engage them only when a
  // credential is present. Without a key the registry is left undefined so the
  // kernel serves every call, byte-identical to a scored run.
  let personas: PersonaRegistry | undefined;
  if (args.persona) {
    if (!hasPersonaCredential()) {
      process.stdout.write(
        "[persona] requested but no model credential found; falling back to " +
          "kernel-only. Set ANTHROPIC_API_KEY to enable persona prose.\n",
      );
    } else {
      const registry = buildToolPersonas({
        fixtureId: args.fixture,
        dossiers: dossiersByToolId(),
        kernels: KERNELS,
      });
      personas = (fixtureId, toolId) =>
        fixtureId === binding.fixtureId ? registry[toolId] : undefined;
      process.stdout.write("[persona] engaged: tool prose may be enriched in character.\n");
    }
  }

  const resolveWorld = (id: string) =>
    id === binding.fixtureId ? world : undefined;

  async function poke(
    method: string,
    path: string,
    body: string | undefined,
  ): Promise<void> {
    const before = trace.events.length;
    const wire = await handleEgressWithPersona({
      binding,
      sandboxId: "poke",
      request: buildRequest(method, path, body),
      trace: trace.write,
      resolveWorld,
      // A poke is human-driven; the origin marks every hop so the unified trace
      // tells this apart from a scored run, even when a persona enriches the prose.
      origin: "human",
      ...(personas !== undefined ? { personas } : {}),
    });
    printOutcome(wire, trace.events.slice(before));
  }

  if (args.repl) {
    process.stdout.write(
      `Interactive poke for fixture ${args.fixture}. Type "<METHOD> <path> [body]".\n` +
        `Example: POST /v1/refunds charge=ch_x&reason=requested_by_customer\n` +
        `Type "quit" to exit.\n`,
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt("> ");
    rl.prompt();
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === "quit" || trimmed === "exit") break;
      if (trimmed.length === 0) {
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
        await poke(method, path, body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(`error: ${message}\n`);
      }
      rl.prompt();
    }
    rl.close();
    return;
  }

  if (args.method === undefined || args.path === undefined) {
    process.stderr.write(
      "poke-tool: pass METHOD and PATH, or use --repl. Run with --list for help.\n",
    );
    process.exitCode = 1;
    return;
  }

  await poke(args.method, args.path, args.body);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`poke-tool: ${message}\n`);
  process.exitCode = 1;
});
