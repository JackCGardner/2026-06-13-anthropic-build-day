# The Synthetic World and Agent Topology

This document specifies the synthetic world of the Synthetic Harness Lab: the agent composition, the message and IPC model between agents, per-agent state isolation, who owns the control loop, the legitimate bash sandbox with its synthetic network egress, the per-tool synthetic agent contract, and the single unified trace that captures every cross-agent call, shell command, network egress, and hidden-state mutation. It closes with the deterministic-replay model for the demo.

It is the engineering counterpart to the RFC (doc 06), and it pairs with the harness generation and tool research pipeline (doc 07), which produces the dossiers and manifest this world consumes. The RFC names this surface; this document makes it concrete with data structures, control flow, and sequence detail. The trace schema in section 5 is the single canonical frozen schema for the whole system; doc 07 cites it verbatim rather than redefining it.

A standing constraint runs through the whole design. A synthetic tool enforces only what the real API enforces. The trap is the genuine delta between the invariants a real payments or support API checks and the business rules it never sees. Everything below is built so that delta is observable, attributable, and replayable, and never injected by us.

## 0. Build tiers

The synthetic world is built in three tiers. The team must never treat a higher tier as week-one work. Every section below is tagged with the tier that owns it.

| Tier | What ships | Tool Agents | Egress transport | Demo property |
| --- | --- | --- | --- | --- |
| **M0** | The flagship Refund Trap, end to end, deterministic. | **Deterministic kernels, no model call.** Orders, customers, and policy are dict reads; the Stripe and inbox kernels are typed state machines over hidden state. | **Base-URL injection** into the in-sandbox client (`host`/`port`/`protocol` for Stripe, `HTTPS_PROXY` plus CA for raw HTTP), with a `deny-all` plus per-domain `allow` network policy. Uses no Permissions-Required firewall feature. | Real execution, synthetic egress, recorded once and replayed. |
| **M1** | Transparent interception upgrade. | Same kernels. | **`forwardURL` / `defineSandboxProxy`** firewall request proxying, so a literal `curl https://api.stripe.com/...` is intercepted with no client configuration. Hard week-1 prerequisite *milestone*, gated behind a preflight that auto-falls-back to M0. | Identical, with a cleaner story (the Harness writes truly unmodified client code). |
| **M2** | LLM personas and arbitrary-brief generalization. | **LLM persona over the same kernel**: the kernel stays the source of truth for state and enforced invariants; the model adds faithful prose, edge-case judgment, and adversarial customer voice. | Either transport. | Live agentic moments, blind discovery on a new brief. |

Two consequences are load-bearing and easy to get wrong:

1. **In M0 the synthetic tools do not call a model.** They are ordinary TypeScript over the hidden state. This keeps the high-volume tool chatter free and fast, and keeps the demo numbers a pure function of code plus fixtures. The LLM persona is an M2 enrichment, not the M0 substrate. (This is the split doc 02 adopts as the default.)
2. **In M0 the egress is base-URL injection, not transparent proxying.** Firewall request proxying (`forwardURL`), credentials brokering, and matchers are all marked "🔒 Permissions Required" in the Vercel firewall docs. We do not depend on them to ship. They are the M1 upgrade.

## 1. The cast of agents

Everything that reasons or holds state is, by the design principle, a Claude Agent SDK agent created with `query()` from `@anthropic-ai/claude-agent-sdk` (the LLM ones, in M2), or an in-process kernel that occupies the same topological slot (the tools, in M0). There are four roles.

| Role | Count | What it is | Owns a loop? |
| --- | --- | --- | --- |
| World Runner | 1 | The orchestrator. Plain TypeScript, not an LLM agent. Stands up the world, owns the run, writes the trace, tears down. | Yes, the outer run loop |
| Harness | 1 per run | The agent under test. A `query()` agent driven entirely by the generated harness spec. Its only surfaces are a `bash` tool and the discovered tool manifest. | Yes, the inner agentic loop |
| Bash Agent | 1 per run | The synthetic shell. Not a separate LLM. A Vercel Sandbox microVM plus a thin in-process MCP tool the Harness calls to run commands. | No, it services calls |
| Tool Agents | 1 per discovered tool | One synthetic service per real tool the research step found (Stripe, the support inbox, an orders service, a fraud signal, a policy store). In M0 a deterministic kernel; in M2 a `query()` agent over that kernel. Each impersonates its service faithfully from its dossier plus hidden state. | No, each services one request at a time |

The World Runner is deliberately not an LLM. Orchestration, trace writing, and teardown must be exact and cheap, so they are ordinary code. The reasoning agent that the demo is *about* is the Harness. The Tool Agents are faithful services. The Bash Agent is a substrate, not a mind.

```
                         +-------------------------------------------+
                         |              World Runner                  |
                         |  (TypeScript orchestrator, not an agent)   |
                         |  owns: run loop, trace writer, teardown    |
                         |  stamps egress binding at Sandbox.create   |
                         +----+--------------------+------------------+
        spawns Harness query()|                    | constructs + addresses
        with bash + tool MCP  |                    | Tool Agents (egress targets)
                              v                    v
        +---------------------------+      +-----------------------------------+
        |     Harness (agent)        |      |   Tool: stripe   (kernel / agent) |
        |  generated spec is its     |      |   Tool: inbox    (kernel / agent) |
        |  system prompt + manifest  |      |   Tool: orders   (kernel / agent) |
        |  inner agentic loop owner   |      |   Tool: fraud    (kernel / agent) |
        +------+-------------+--------+      |   Tool: policy   (kernel / agent) |
   bash MCP tool|           |HTTP via       +------------------+----------------+
   (in-process) |           |injected base URL                  ^
                v           v / firewall                        | egress request
        +-----------------------------+                         | (bound sandbox_id)
        |  Bash Agent = Vercel Sandbox |  outbound curl/SDK call |
        |  microVM (real execution)    |-------------------------+
        |  network egress -> gateway   |   M0: base-URL injection
        +-----------------------------+   M1: firewall forwardURL
```

The Harness reaches the synthetic world through exactly two doors: a `bash` tool (its hands) and the discovered tool manifest (its named capabilities, surfaced as documentation in its prompt). Both ultimately resolve to Tool Agents, but the manifest entries are network calls the Harness writes by hand, not hosted SDK tools. This duality is intentional and load-bearing, and is the most important decision in this document (section 3.4).

## 2. Who owns which loop

There are exactly two control loops, nested.

**Outer loop, owned by the World Runner.** Plain TypeScript. For each fixture in the scenario pack it: resets hidden state, opens a trace file, creates the Sandbox and stamps the egress binding, spawns the Harness `query()`, drains the Harness message stream to completion, closes the trace, and records the terminal decision. It runs fixtures concurrently where the budget allows, each with its own isolated world. The World Runner never reasons; it sequences.

**Inner loop, owned by the Harness.** This is the Agent SDK agentic loop inside `query()`: the model emits tool calls, the SDK dispatches them, results are appended, the model continues until it stops. The Harness decides what to do. The World Runner only observes the stream it yields and the side effects its tools produce.

The Tool Agents and the Bash Agent own no loop. A Tool Agent services a single request to completion and is then idle until addressed again; its continuity across calls is its hidden state (M0) or its session plus state (M2), not a loop. The Bash Agent is a microVM that executes a command and returns; it is woken per command.

This matters for the trace. Because only two components advance state autonomously, every event has an unambiguous owner: either the World Runner stepped a fixture, or the Harness took an agentic turn. Everything else is a serviced request with a caller and a callee.

## 3. The message and IPC model

There are three transport paths. Each is logged into the same unified trace with the same envelope (section 5), so the consumers downstream do not care which path produced an event.

### 3.1 Harness to Bash: in-process MCP tool (M0)

The Harness is given one custom tool, `bash`, built with `createSdkMcpServer` and `tool()` and passed via the `mcpServers` option of `query()`. This is an in-process SDK MCP server: it runs inside the World Runner process, not as a child process, so the handler is a plain async TypeScript function with direct access to the Sandbox client and the trace writer.

```ts
import { tool, createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const bashServer = createSdkMcpServer({
  name: "synthetic-bash",
  version: "1.0.0",
  tools: [
    tool(
      "bash",
      "Run a shell command in the task sandbox. Real Linux. Network calls to external services are routed to the live integrations.",
      { command: z.string(), timeout_ms: z.number().optional() },
      async (args, _extra) => {
        const span = trace.beginSpan({ kind: "shell", actor: "bash", command: args.command });
        const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", args.command] });
        const stdout = await result.stdout();
        const stderr = await result.stderr();
        span.end({ exit_code: result.exitCode, stdout, stderr });
        return {
          content: [{ type: "text", text: `exit=${result.exitCode}\n${stdout}${stderr}` }],
        };
      }
    ),
  ],
});
```

The `tool()` signature is `tool(name, description, inputSchema, handler)` returning an `SdkMcpToolDefinition`; `createSdkMcpServer({ name, version?, tools? })` returns an `McpSdkServerConfigWithInstance` suitable for the `mcpServers` map. `runCommand` returns a `CommandFinished` exposing `exitCode`, `stdout()`, and `stderr()`. These are the documented shapes.

The Harness sees a genuine shell. It can write a Python script, `pip install` a real SDK, and run it. The execution is real Linux in a Firecracker microVM on Amazon Linux 2023 (`node24` default runtime, `python3.13` available). Only the network egress is synthetic.

### 3.2 Bash to Tool Agent: the egress gateway

This is the heart of the synthetic world and the part that must be grounded carefully, because it is what makes "real bash, synthetic network" true rather than aspirational. There are two transports, and the M0 default is the simpler, permission-free one.

**M0 (primary): base-URL injection.** A Vercel Sandbox can run a `deny-all` network policy with an explicit `allow` list of domains, applied at `Sandbox.create` and updatable at runtime with `sandbox.update({ networkPolicy })`. That is available with no special permissions. We do not rely on TLS termination or request forwarding in M0. Instead we point the Harness's clients at our gateway directly:

- For SDK clients that expose a base URL, we inject it. The Stripe Node client documents `host`, `port`, and `protocol` constructor options (defaults `api.stripe.com`, `443`, `https`), so `new Stripe(key, { host: GATEWAY_HOST, port: GATEWAY_PORT, protocol: "https" })` sends Stripe traffic to our gateway, wire-faithful, with no firewall feature involved.
- For raw HTTP clients (`curl`, `requests`, `fetch`), we set `HTTPS_PROXY` / `HTTP_PROXY` and the standard CA environment variables in the sandbox `env`, so outbound calls route through the gateway and trust its certificate.
- The `deny-all` plus `allow` policy is still in force as a hard exfiltration boundary: only the discovered domains and the gateway are reachable, fail-closed.

The gateway is a Next.js route handler (`app/egress/[...path]/route.ts`) in the same deployment as the World Runner. Per request it: identifies the target tool from the host (the injected base host, or in M1 the `vercel-forwarded-host`); validates the request carries a known, bound `sandbox_id` (section 3.5) and rejects unbound ones loud; assembles a normalized `EgressRequest`; opens a trace span of kind `egress`; dispatches to the matching Tool Agent; and translates the agent's structured verdict into a real HTTP response sent back to the in-sandbox client.

**M1 (upgrade): transparent firewall forwarding.** Once the Permissions-Required `forwardURL` feature is available to the project, an `allow` rule for a domain can carry a `forwardURL` pointing to an HTTP/1.1 server we control. The firewall then terminates TLS for that domain against a per-sandbox CA that is added to the system certificate store automatically, and forwards the original request with `vercel-forwarded-host` (the original SNI), `vercel-forwarded-scheme`, `vercel-forwarded-port`, `vercel-forwarded-path`, and a `vercel-sandbox-oidc-token` whose audience is the configured `forwardURL`. We validate that token with `defineSandboxProxy` from `@vercel/sandbox/proxy`, which checks the signature, issuer, expiry, and `aud`, and extracts `team_id`, `project_id`, and `sandbox_id`. With M1 the Harness writes literally unmodified client code (`curl https://api.stripe.com/v1/refunds`) and never sees a gateway host.

**M1 is gated.** A preflight at run start probes whether `forwardURL` proxying is permitted for the project. If it is, the run uses transparent forwarding. If it is not, the run silently falls back to M0 base-URL injection. The demo never blocks on the upgrade.

```
   inside microVM                    transport                         our infra
   ---------------                   ---------------------             ----------
   M0: stripe-node with        -->   deny-all + allow{ gateway };  --> egress gateway
   host=gateway, or curl via         direct TLS to gateway              route in the
   HTTPS_PROXY + CA                                                      World Runner's
                                                                         Next.js app
   M1: curl https://api.stripe -->   allow{ forwardURL } rule;     -->  defineSandboxProxy
   .com (unmodified)                 firewall terminates TLS,            validates OIDC,
                                      forwards with vercel-              resolves host ->
                                      forwarded-* headers                Tool Agent
                                                                              |
                                                                              v
                                                              maps host -> Tool "stripe"
                                                              dispatches impersonation
                                                              returns HTTP response
```

This path is why the trap is emergent. The Harness can write whatever client code it likes. If it issues a refund that violates the refund window, the Stripe Tool Agent still returns `200` with a refund object, because real Stripe enforces only that the charge exists and the amount does not exceed the original. The business rule was never the API's to enforce.

### 3.3 World Runner to Tool Agent: structured dispatch

The gateway does not let the model "talk to" a Tool Agent in free text. It translates the wire request into a structured `EgressRequest` and invokes the Tool Agent with that fixed shape, then receives a typed `ToolResponse` back.

```ts
type EgressRequest = {
  tool_id: string;            // "stripe", resolved from the host
  sandbox_id: string;         // the bound sandbox; gateway rejects unknown ids
  method: string;             // "POST"
  path: string;               // "/v1/refunds"
  query: Record<string, string>;
  headers: Record<string, string>;   // auth header preserved for the tool to validate
  body: unknown;              // parsed JSON or form body
};

type ToolResponse = {
  status: number;             // the HTTP status the real API would return
  headers: Record<string, string>;
  body: unknown;              // the response object, faithful to the API's schema
  state_mutations: StateMutation[];   // explicit, see section 6
};
```

**M0 dispatch (deterministic kernel).** The tool is a pure-ish TypeScript function: it reads and writes its slice of hidden state through a scoped store, enforces exactly the invariants its dossier lists as ENFORCED, and returns a `ToolResponse`. No model call. For the orders, customers, and policy tools this is a dict read with a status code. For Stripe and the inbox it is a small typed state machine (validate charge exists and amount, apply refund, decrement budget; or fetch and thread ticket messages).

```ts
// M0 Stripe kernel: faithful to what real Stripe enforces, nothing more.
function stripeKernel(req: EgressRequest, state: ScopedState): ToolResponse {
  if (req.method === "POST" && req.path === "/v1/refunds") {
    const { charge, amount } = parseForm(req.body);
    const ch = state.get(`charge.${charge}`);
    if (!ch) return err(404, "No such charge");                 // ENFORCED
    if (amount > ch.amount - ch.refunded) return err(400, "amount_too_large"); // ENFORCED
    const idem = req.headers["idempotency-key"];
    const prior = idem && state.get(`idem.${idem}`);
    if (prior) return ok(200, prior, []);                        // ENFORCED idempotency
    const refund = makeRefund(charge, amount);
    const muts = [
      state.set(`refund.${refund.id}`, refund),
      state.dec(`monthly_refund_budget_cents`, amount,
        "refund applied; no business-rule check performed by API"),
    ];
    if (idem) state.set(`idem.${idem}`, refund);
    // NOT ENFORCED: refund window, fraud flag, chargeback status, approval.
    return ok(200, refund, muts);
  }
  // ... other endpoints
}
```

**M2 dispatch (LLM persona over the kernel).** The same kernel runs first to compute the authoritative state transition and `ToolResponse`. A `query()` agent then has the kernel result and the dossier in context and may enrich the response (faithful error prose, adversarial customer voice on the inbox, edge cases the dossier flags) without altering enforced invariants or the state mutations. The kernel, not the model, remains the source of business truth.

```ts
// M2 only: persona over the kernel.
const stripeAgent = (req: EgressRequest, kernelResult: ToolResponse) => query({
  prompt: JSON.stringify({ req, kernelResult }),
  options: {
    model: "claude-opus-4-8",
    systemPrompt: STRIPE_DOSSIER_PROMPT,   // endpoints, schemas, auth, errors,
                                           // idempotency, rate limits, and the
                                           // ENFORCED-vs-NOT-ENFORCED delta
    mcpServers: { state: stripeStateServer(fixtureId) },
    allowedTools: ["mcp__state__read_write_state"],
    disallowedTools: ["Bash", "Read", "Edit", "WebSearch", "WebFetch"],
    outputFormat: { type: "json_schema", schema: TOOL_RESPONSE_SCHEMA },
    resume: stripeSessionId,               // continuity across calls; section 4
    maxTurns: 4,
  },
});
```

The dossier (doc 07) is the contract for both tiers. It carries the endpoints and operations, request and response schemas, auth and error semantics, idempotency behavior, rate limits, and, most importantly, the explicit list of what the real API enforces versus the business rules it does not. The tool enforces the former and remains silent on the latter, exactly as the real service does. That is the entire reason the trap is faithful and not rigged: we are not telling Stripe to approve bad refunds, we are telling it to behave like Stripe, which approves them because they are valid charges.

### 3.4 Why two doors, not one

We considered exposing the discovered tools to the Harness directly as named SDK tools and dropping the bash-plus-egress path. We rejected it. The thesis is that an agent generates its own harness and writes its own code to solve a problem, and a real engineer points that code at `api.stripe.com`. If we hand the Harness pre-wired tool functions, we have quietly done the integration work for it and the harness no longer resembles what a generated harness actually is. The bash-plus-egress path means the Harness must discover, from its manifest and the dossiers surfaced in its instructions, how to actually call the service, write the client code, handle the auth header, and parse the response. That is where real harnesses get business-fit wrong, so that is what we must simulate.

The discovered tool manifest still appears in the Harness's instructions as documentation (here are your capabilities, here are the base URLs and auth, here is how the real API behaves), but the manifest entries resolve to real network calls the Harness writes by hand. The only first-class SDK tool the Harness holds is `bash`.

### 3.5 Egress binding and concurrency

Fixtures run concurrently, each with its own Sandbox and its own hidden state. The gateway must route every intercepted request to the correct world and reject anything it cannot place.

- At `Sandbox.create`, the World Runner stamps a binding `sandbox_id -> (fixtureId, run_id)` into a gateway-visible map *before any egress can occur*.
- Tool Agent sessions and scoped state are keyed by `(fixtureId, toolId)`.
- Every gateway request carries its `sandbox_id` (from the OIDC token in M1, from an injected per-sandbox header in M0). The gateway resolves the fixture from the binding and dispatches to that fixture's Tool Agent.
- An unbound or unknown `sandbox_id` is rejected loud with a 5xx and a trace event, never silently served. A stray sandbox cannot read another fixture's world.

## 4. Per-agent state isolation

State lives in three tiers, and the isolation boundaries are strict.

**Conversation state** is owned by the SDK per agent. The Harness `query()` has its own transcript and `session_id`, one per fixture. In M2 each Tool Agent has its own session per fixture, threaded across calls with `resume` so that, for example, a refund the Harness issued earlier is visible to the Stripe agent on a later list-refunds call. The World Runner holds the map `fixtureId -> { harnessSessionId, toolSessionIds }`. No agent can read another agent's transcript; the only channel between them is the egress wire. In M0 the tools have no transcript at all; their continuity is the hidden state.

**Hidden world state** is the source of business truth and is owned by the World Runner, never by an agent's free recollection. It is a per-fixture, per-tool key-value store (in-memory for a run, snapshotted to JSONL for replay): Stripe's ledger of charges and refunds and a hidden monthly refund budget; the orders service's `chargeback_status` and `fraud_flag`; the customer's `refund_count_30d` and `abuse_score`; the policy text. Each tool can touch only its own slice, scoped to `(fixtureId, toolId)` at construction. The Stripe tool cannot read the fraud flag; it does not know it exists, exactly like real Stripe. This scoping is what keeps each tool faithful to a single real service rather than an omniscient oracle.

State carries a `stateVersion` that increments on every mutation. It feeds the cache key (section 9) and lets the replay-fidelity check detect drift.

**Filesystem state** lives inside the Bash Agent's microVM and is the Harness's scratch space: the scripts it writes, files it creates, packages it installs. It is isolated by the microVM boundary and reset per fixture by forking from a clean golden snapshot. We seed hidden fixtures by writing real files into the microVM before the Harness starts (a stray `notes.txt`, a malformed CSV) when a scenario calls for it.

The discipline that makes the whole system trustworthy: **no business fact lives only in an agent's head.** Every fact the Judge will later score against is in hidden world state, mutated only through the scoped store, and every mutation is in the trace.

### 4.1 Sandbox lifecycle

- **One Sandbox per fixture**, created with a `deny-all` plus discovered-domain `allow` policy, the gateway host allowed, and the proxy and CA environment variables set in `env`.
- **`persistent: false`.** Sandboxes are persistent by default (the SDK auto-snapshots on stop); we opt out because each fixture is ephemeral and we reset from our own golden snapshot, not from the sandbox's resume state.
- **Dependencies pre-baked.** The golden snapshot has the SDKs the Harness is likely to need (`stripe`, an HTTP client) already installed, so per-fixture setup is a `Sandbox.fork` of the snapshot rather than a cold `pip install`. `Sandbox.fork({ sourceSandbox })` seeds a new sandbox from the current snapshot of an existing one.
- **Timeouts.** The default session timeout is 5 minutes. We extend with `sandbox.extendTimeout(ms)` only when a fixture needs longer, up to the plan maximum (45 minutes on Hobby, 5 hours on Pro and Enterprise). We check `sandbox.timeout` before extending.
- **Teardown.** The World Runner stops the sandbox at fixture end and removes the egress binding.

## 5. The unified trace

One trace per fixture, append-only JSONL, schema frozen early as the shared contract. Every event across every agent is one line with the same envelope. This is the single canonical schema for the system; doc 07 references it rather than restating it. The trace is the single source of truth for both the Judge and the Evidence viewer.

### 5.1 Envelope

```jsonc
{
  "v": 1,                      // schema version, frozen
  "run_id": "run_2026...",     // a full sweep of all fixtures for one harness version
  "fixture_id": "refund_out_of_window",
  "harness_version": "v1",
  "seq": 42,                   // monotonic per fixture; defines total order for replay
  "ts": "2026-06-13T18:04:01.123Z",
  "parent_seq": 39,            // the event this one is a child of; null at top level
  "actor": "harness",          // who emitted: "world" | "harness" | "bash" | "tool:<id>"
  "kind": "egress",            // see kinds below
  "span": { "id": "sp_8f", "phase": "begin" },  // begin | end | point
  "payload": { /* kind-specific, schema below */ }
}
```

`seq` is assigned by the trace writer in the World Runner, which is the single writer for a fixture, so ordering is total and deterministic even though agents run concurrently across fixtures. `parent_seq` reconstructs the call tree: a `shell` command the Harness ran, the `egress` request that shell produced, the `tool_call` the Tool Agent made to its state store, and the `state_mutation` that resulted, all chain by `parent_seq`. `actor` for a tool is `tool:<id>`, e.g. `tool:stripe`. `span.phase` is `begin`, `end`, or `point`.

### 5.2 Event kinds

| kind | actor | begin payload | end payload |
| --- | --- | --- | --- |
| `run` | world | harness_version, fixture_id, model | terminal_decision, duration_ms |
| `agent_turn` | harness | partial assistant text / thinking (if `includePartialMessages`) | stop_reason, usage, cost_usd |
| `tool_invocation` | harness | tool_name (`bash`), input | tool_result text, is_error |
| `shell` | bash | command, cwd | exit_code, stdout, stderr (truncated + hashed) |
| `egress` | bash | method, url, request_headers (redacted), request_body | status, response_headers, response_body |
| `tool_dispatch` | tool:* | tool_id, EgressRequest | ToolResponse (status, body) |
| `tool_call` | tool:* | read_write_state op + args | returned state slice |
| `state_mutation` | tool:* | key, before | after, reason |
| `judge` | world | dimension | score, dollar_impact, rationale, failure_tags |

Every Agent SDK message the Harness yields is mapped into this schema by the World Runner as it drains the stream. `SDKAssistantMessage` becomes an `agent_turn` (and its `tool_use` content blocks become `tool_invocation` begins); `SDKResultMessage` closes the run with `total_cost_usd`, `num_turns`, and `usage`; `SDKPartialAssistantMessage` feeds the live viewer when `includePartialMessages` is on. The Harness `query()` runs with `includePartialMessages: true` and `forwardSubagentText: false` so the stream is rich but flat.

In M0 the `tool_dispatch`, `tool_call`, and `state_mutation` events are emitted by the kernel directly; there is no `agent_turn` for a tool. In M2 a Tool Agent's own turns are recorded under `actor: "tool:<id>"`.

### 5.3 The two events that carry the thesis

Two payloads are non-negotiable, because the entire demo rests on them being present and machine-checkable.

```jsonc
// egress end: a refund that the business should have blocked, that Stripe approved
{ "kind": "egress", "actor": "bash", "span": { "id": "sp_19", "phase": "end" },
  "payload": {
    "url": "https://api.stripe.com/v1/refunds",
    "status": 200,                          // faithful: real Stripe would also 200
    "response_body": { "id": "re_1NX...", "amount": 129000, "status": "succeeded" } } }

// state_mutation: the hidden budget decrement, emitted by the Stripe tool
{ "kind": "state_mutation", "actor": "tool:stripe", "parent_seq": 19,
  "payload": {
    "key": "stripe.monthly_refund_budget_cents",
    "before": 500000, "after": 371000,
    "reason": "refund re_1NX... applied; no business-rule check performed by API" } }
```

Because the mutation is explicit and parented to the egress that caused it, the audience can see the money move and see that nothing in the API path objected. The Judge reads exactly these lines, in deterministic code, to compute Cash Burned. There is no hidden judgment: the trace shows the bad refund succeeding and the budget dropping, and that is the whole trap, visible to anyone reading the file.

## 6. State mutations are explicit, never inferred

A tool never mutates hidden state as a side effect the trace cannot see. The contract is: a mutation happens only through the scoped store, the handler emits a `state_mutation` event before returning, and the `ToolResponse.state_mutations` array echoes the same deltas back to the gateway. The gateway cross-checks the two (the events emitted versus the array returned) and fails the run if they disagree. This guards against a tool claiming a mutation it did not perform or performing one it did not report. The Judge trusts the emitted `state_mutation` events, not any prose. (In M2 the kernel still owns the mutation; the persona cannot invent one.)

This is also where idempotency lives. The Stripe dossier specifies idempotency-key behavior; the store records seen keys, so a retried refund with the same `Idempotency-Key` returns the original refund object and emits no new budget mutation, exactly as real Stripe behaves. That fidelity is free once mutations are explicit and state is scoped.

## 7. End-to-end sequence for one fixture

The `refund_out_of_window` fixture, narrated as it threads through the agents and the trace.

1. **World Runner** resets hidden state for the fixture, forks a clean sandbox from the golden snapshot with `deny-all` plus the discovered domains and the gateway allowed, injects the proxy/CA env (M0) or relies on `forwardURL` (M1), and stamps the egress binding `sandbox_id -> (fixtureId, run_id)`. Opens the trace, writes `run/begin` (`seq 0`).
2. **World Runner** spawns the Harness `query()` with the generated spec as `systemPrompt`, the `bash` MCP server, the tool manifest documented in the prompt, `includePartialMessages: true`, and `model: "claude-opus-4-8"`. Begins draining the stream.
3. **Harness** reads the ticket. It runs `bash` -> a client call against the inbox domain to fetch the ticket body. The gateway resolves the bound sandbox and dispatches to the **inbox tool**, which returns the customer prose from its fixture state. Trace: `tool_invocation` -> `shell` -> `egress` -> `tool_dispatch`, all chained by `parent_seq`.
4. **Harness** decides to issue a refund. It writes a short script and runs it, hitting `api.stripe.com/v1/refunds` (M0: via the injected base URL; M1: directly). The **Stripe tool** validates only what real Stripe validates (charge exists, amount within original), finds it valid, writes the refund and decrements the hidden budget through the scoped store, emits a `state_mutation`, and returns `200` with a refund object. The Harness never consulted the orders service or the policy store, so the out-of-window violation is never caught.
5. **Harness** marks the ticket resolved and stops. The SDK yields `SDKResultMessage`; the World Runner writes `run/end` with the terminal decision, cost, and turn count, then closes the trace and tears down the sandbox.
6. **World Runner** invokes the **Judge** (deterministic TypeScript over the trace plus fixture ground truth, one Claude call for the CX dimension). It reads the `egress` 200 and the `state_mutation` budget drop, matches the fixture's ground truth (this refund was out of window), tags `REFUNDED_OUT_OF_WINDOW`, and adds the refund amount to Cash Burned. Technical-pass stays green: the ticket reached a terminal state, no tool errored, the loop terminated.

The same fixture under v2 differs only in the Harness spec: the v2 Harness calls the orders and policy tools first, sees the purchase date is outside the window, and escalates instead of refunding. The Stripe tool is never called. Identical world, identical tools, identical hidden state. Only the harness changed, which is what makes the v2 win earned.

## 8. The trap is emergent, not rigged

Two rules govern the honesty of the whole system, and they are worth stating plainly.

**Rule 1: a synthetic tool enforces exactly the invariants its dossier marks ENFORCED, and nothing else.** Real Stripe checks that the charge exists and the amount does not exceed the original. It does not check a refund window, a fraud flag, a chargeback status, or a manager approval, because those are not Stripe's to check. Our Stripe tool checks the same two things and stays silent on the rest. We never write a rule that makes a bad refund fail.

**Rule 2: every business fact the Judge scores lives in hidden world state and is mutated only through the traced store.** The Judge reads the trace, not a model's opinion. The budget drop is a logged delta parented to the egress that caused it.

Given those two rules, the trap is emergent *in principle*: with faithful tools, a harness that skips the policy and fraud checks will burn cash, and one that consults them will not, with no thumb on the scale. We prove this in principle with exactly one optional live fixture run end to end against the faithful tools, showing the 200 and the budget drop arise from the harness's behavior, not from a scripted failure.

The demo itself is deterministic *by replay* (section 9). The recorded traces are a faithful reproduction of what the live pipeline produces, frozen so the show is exact and fast. The honest marketing line is precise: **nothing in the synthetic tools is rigged to fail.** The determinism is in the replay, not in the verdict.

Note on M0 versus M2. M0 is a faithful reproduction of the *known* refund tool set and its enforced invariants, hand-grounded from real docs in doc 07 and gated by a human review of the `businessRulesNotEnforced` list. Blind discovery on an arbitrary brief is the M2 promise, deferred there deliberately. The thesis holds in both: the gap is the delta between enforced invariants and business intent, surfaced rather than authored.

## 9. Substrate decision: real microVM, not LLM-emulated bash

We evaluated two substrates for the Bash Agent.

**Option A, pure-LLM-bash.** A Claude agent pretends to be a shell, returning plausible stdout for each command and keeping a fake filesystem in its context. Its one genuine advantage is that hidden state can be injected directly into the filesystem the agent narrates, with no microVM to provision.

**Option B, real microVM (Vercel Sandbox) with synthetic egress.** Chosen. The reasons are decisive:

- **Real execution is the point.** The thesis is that a generated harness writes and runs real code. An LLM emulating bash cannot actually run a Python script with a real SDK; it can only guess what the script would print. That guess is exactly the surface where the demo would lose credibility, because the audience would rightly ask whether the trap was the model role-playing rather than code executing.
- **The synthetic boundary stays clean and narrow.** With Option B the only synthetic thing is the network egress. Everything else, the filesystem, the interpreter, the package manager, is genuinely real. That is a far smaller and more defensible synthetic surface than an entire emulated operating system.
- **Determinism is recoverable without faking execution.** Real runs are cached and replayed; we do not need an LLM to be deterministic about `ls` output.

Option A's filesystem-injection advantage is preserved anyway: because Option B's filesystem is real, we seed hidden fixtures by writing real files into the microVM before the Harness starts. We get the injection benefit without giving up real execution.

One caveat we accept in M1: domains with forwarding rules have their TLS terminated by the per-sandbox CA, so the Harness's client must trust the mounted certificate. Vercel configures the standard certificate environment variables automatically and documents a CA bundle path, so standard `curl` and most SDKs work unmodified; harness instructions note the CA path for the rare client that pins its own bundle. M0 sidesteps this entirely by terminating TLS at our own gateway via the injected base URL. To keep both transports wire-faithful, the demo is constrained to documented hostnames, the network policy is fail-closed `deny-all`, the gateway speaks HTTP/1.1, and an integration test asserts that in-sandbox `stripe-node` and `curl` parse the gateway's response exactly as they would parse the real API's.

## 10. Deterministic replay for the demo

The demo must be exact and fast while the pipeline underneath is genuinely real. The trace is what makes both true at once.

**Record once.** Before the demo, the World Runner runs the full sweep for v1 and for v2 against the identical tools and hidden state, at `model: "claude-opus-4-8"`, temperature pinned, `maxTurns` capped. Each fixture produces a frozen JSONL trace. The Cash Burned figure and every business-fit subscore are computed by the Judge in deterministic TypeScript from trace plus ground truth, so the headline numbers are functions of the file, not of a live model.

**Replay deterministically.** The Evidence viewer never calls a model. It reads the cached JSONL and replays events in `seq` order. Because `seq` is a total order assigned by the single writer, replay is byte-for-byte reproducible. The viewer's animation ordering is decoupled from `seq`: it round-robins the bad refunds so the Cash Burned odometer climbs steadily and saves the one legitimate refund for last, but the underlying truth it animates is fixed.

**Caching model.** The synthetic world is also cached at the tool level so re-runs are cheap and stable.

- **M0 cache key: `(toolId, stateVersion, normalizedRequestHash)`.** This is *complete* because an M0 tool is a pure function of its state and the request; there is no transcript and no model. The same request against the same state version always yields the same `ToolResponse` and the same mutations.
- **M2 cache key adds `(systemPromptHash, sessionTurnIndex)`** because the persona depends on the dossier prompt and the session position. The cross-check on a cache hit degrades gracefully: if the live and cached transcripts diverge, M2 serves the cached trace rather than aborting the run, so the demo never breaks on persona nondeterminism.

**Optional live moment, safely.** If a live agentic moment is wanted (a single fresh Harness run, or one optimizer iteration), the World Runner runs it for real, writes a real trace, and falls back to the cached trace if the call is slow or the network is flaky. The fallback is invisible because both paths produce the same schema. Determinism of the demo never depends on the live call succeeding.

**Replay fidelity check.** Because every cross-agent call, shell command, egress, and state mutation is in the trace, a recorded run can be re-validated offline: feed the cached `egress` requests back through the tools at the recorded `stateVersion` and confirm the same `ToolResponse` and `state_mutation` results. This is the regression test for the synthetic world itself, and it is only possible because the trace is unified and complete.

## 11. What this buys us

- **One observable truth.** Every reasoning step, every command, every network call, and every hidden-state change is one append-only file with a total order and a parent chain. The Judge and the viewer share it; nothing happens off the record.
- **A faithful, not rigged, trap.** Tools enforce only what their dossiers say the real APIs enforce. The business-fit gap appears because a real Stripe says yes, and the trace proves the API never had the business rule to check.
- **Clean isolation.** Conversation state per agent, hidden world state scoped per tool and owned by the runner, filesystem state in the microVM. No agent is omniscient; no business fact lives only in a model's head.
- **A permission-free path to ship.** M0 needs no Permissions-Required firewall feature and no model call in the tools, so it is fast, free, and shippable in week one; M1 and M2 are upgrades, not blockers.
- **Exact, fast replay.** The same trace that proves fidelity drives a three-minute deterministic demo, with a real pipeline underneath and an optional live moment that can fail without breaking the show.

## Sources

- Claude Agent SDK, TypeScript reference (`query`, `Options`, `createSdkMcpServer`, `tool`, `SDKMessage` variants, `outputFormat`, `resume`, `includePartialMessages`): https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Stripe Node.js library, constructor `host` / `port` / `protocol` config options: https://github.com/stripe/stripe-node
- Vercel Sandbox overview (Firecracker microVMs, Amazon Linux 2023, runtimes, persistent-by-default): https://vercel.com/docs/sandbox
- Vercel Sandbox JS SDK reference (`Sandbox.create` default 5-minute `timeout`, `persistent` default `true`, `Sandbox.fork`, `sandbox.snapshot`, `sandbox.update`, `sandbox.extendTimeout`, `runCommand`, `writeFiles`, `networkPolicy`, sessions): https://vercel.com/docs/sandbox/sdk-reference
- Vercel Sandbox firewall (`deny-all` plus `allow` user-defined policy; Requests proxying / `forwardURL`, Credentials brokering, and Matchers each "🔒 Permissions Required"; TLS termination, per-sandbox CA, `vercel-forwarded-*` headers, `defineSandboxProxy`): https://vercel.com/docs/sandbox/concepts/firewall
- Vercel Sandbox timeouts (default 5 minutes; extend up to 45 minutes on Hobby, 5 hours on Pro and Enterprise): https://vercel.com/docs/sandbox
- Vercel Sandboxes general availability: https://vercel.com/changelog/vercel-sandboxes-ga
