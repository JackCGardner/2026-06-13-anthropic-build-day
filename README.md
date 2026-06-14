# Synthetic Harness Lab

Anthropic Build Day, San Francisco - June 13, 2026.

This project explores a simple but sharp idea: coding agents are getting good at
creating the harnesses they need to solve a specific problem, but "the harness
runs" is not the same thing as "the harness solves the real business problem."

Synthetic Harness Lab is a hackathon prototype for agent-generated coding
harnesses that can be evaluated and improved inside synthetic sandboxes before
they are trusted in the real world.

This repository is a single TypeScript Next.js (App Router) application. It pairs
a deterministic engine (synthetic tool kernels, a trace store, and a judge that
is pure functions over the trace plus ground truth) with a scenario pack format.
The flagship pack is the Refund Trap, where a harness handed a faithful payments
API issues technically valid but policy-violating refunds: every call returns
200, every ticket is marked solved, technical-pass stays pinned at 100%, and
money walks out the door. The synthetic world is what makes that gap visible,
attributable, and replayable.

## Run the keyless sweep

The first milestone is fully keyless: no Anthropic or Vercel credentials are
needed to build or run it. A scripted, deterministic stand-in issues the same
tool calls a naive v1 and a tightened v2 harness would, so the whole pipeline
(kernels, world runner, judge) runs end to end with no model in the loop.

```bash
npm install
npm run sweep
```

The sweep runs both harness versions across the refund fixtures and prints the
headline numbers: technical-pass flat at 100%, Cash Burned about $5,140 falling
to $0, and Trust Score climbing from about 38 to about 91, all against the
identical synthetic world.

```bash
npm run sweep:bash   # same numbers, every tool call over a real shell + HTTP + gateway process
```

`sweep:bash` proves the egress seam end to end: the scripted harness's tool calls
travel a real shell command (curl) and a real process boundary to the gateway, and
the dashboard numbers survive unchanged. Both `sweep` and `sweep:bash` are fully
keyless.

## Run the live sweep (needs a key)

```bash
npm run sweep:live
```

`sweep:live` is the only path that calls a model. It drives the agent under test
through the Claude Agent SDK: the model is given a single bash tool over an
in-process MCP server, runs its own shell commands across the same bash substrate
and egress gateway as `sweep:bash`, and the same Judge scores the resulting trace.

It needs a model credential. Set `ANTHROPIC_API_KEY` (or run inside an
authenticated Claude Code session). With no credential present it prints a pointer
to the keyless proofs and exits 0 without calling the API:

```
Live harness needs ANTHROPIC_API_KEY or a Claude Code login.
The keyless scripted proof is: npm run sweep / npm run sweep:bash.
```

Flags: `--traces <dir>` overrides the trace output directory, `--max-turns <n>`
caps the agent turns per fixture.

## Run the live Vercel Sandbox sweep (needs Vercel auth + a deployed gateway)

```bash
npm run sweep:sandbox
```

`sweep:sandbox` runs the same Refund Trap thesis as `sweep:bash`, but every tool
call executes inside a real ephemeral Vercel Sandbox microVM behind the identical
`BashSubstrate` seam. Its outbound HTTP reaches the deployed egress route instead
of a localhost gateway: in M0 the microVM's `HTTPS_PROXY` points at a publicly
reachable gateway URL; in M1 the firewall's per-domain `forwardURL` points at the
deployed `defineSandboxProxy` route (`app/api/egress/[[...path]]`). Either way the
same shared egress core dispatches into the scoped kernels and moves the hidden
money.

Because a real microVM is off-box, this path needs BOTH a Vercel credential AND a
publicly reachable gateway URL:

- Vercel auth: set `VERCEL_OIDC_TOKEN`, or `VERCEL_TOKEN` together with
  `VERCEL_PROJECT_ID` and `VERCEL_TEAM_ID`.
- `GATEWAY_PUBLIC_URL`: the publicly reachable base URL of your deployed gateway
  (a `127.0.0.1` / `localhost` value is rejected, since the microVM cannot reach
  the runner's loopback).

With either absent it prints a pointer to the keyless and live-model proofs and
exits 0 WITHOUT creating a sandbox or touching the network:

```
sweep:sandbox needs Vercel auth (VERCEL_TOKEN/OIDC) and a deployed gateway URL
(GATEWAY_PUBLIC_URL). The keyless proofs are: npm run sweep / npm run sweep:bash;
the live model path is sweep:live.
```

Flags: `--mode M0|M1` selects the egress transport (default `M0`), `--traces
<dir>` overrides the trace output directory.

### Deploying the egress gateway route

The forwardURL transport (M1) targets the Next.js route handler at
`app/api/egress/[[...path]]/route.ts`. Deploy this app to Vercel
(`vercel deploy --prod`), then:

- Point `GATEWAY_PUBLIC_URL` at the deployment, e.g.
  `https://<your-app>.vercel.app`.
- Set `SYNTH_EGRESS_FORWARD_URL` on the deployment to the public URL of the route
  (`https://<your-app>.vercel.app/api/egress`); the route validates the
  `vercel-sandbox-oidc-token` audience against it.
- The World Runner that owns the seeded worlds calls
  `egressBindingStore.configure({ resolveWorld, trace })` once at startup and
  `bind` / `unbind` per fixture, keyed by the OIDC `sandbox_id`.

The M0 transport only needs `GATEWAY_PUBLIC_URL` to be a publicly reachable
gateway; the route still serves both transports through the one shared core.

## Run matrix

| Command | What it proves | Credentials |
| --- | --- | --- |
| `npm run sweep` | In-process keyless thesis: v1 $5,140 / Trust 38, v2 $0 / Trust 91, both 100% | none |
| `npm run sweep:bash` | Same numbers over a real shell + HTTP + local gateway process | none |
| `npm run dev` | The evidence-viewer UI rendering the keyless sweep | none |
| `npm run sweep:live` | The agent under test driven by a real model through the Claude Agent SDK | `ANTHROPIC_API_KEY` (or a Claude Code login) |
| `npm run sweep:sandbox` | Same numbers over real Vercel Sandbox microVMs against the deployed egress route | Vercel auth (`VERCEL_TOKEN` / `VERCEL_OIDC_TOKEN`) + `GATEWAY_PUBLIC_URL` |
| `npm run optimize` | The optimizer loop discovering the policy gates from judge feedback: v1 $5,140 to v2 $0, technical flat, held-out Trust 100 | none |
| `npm run research` | The research and initialization pipeline: a brief to a gate-passing harness spec plus dossiers, then a generic dossier-driven world that reproduces the trap | none for the refund reproduction; `ANTHROPIC_API_KEY` + `RESEARCH_WEB_ACCESS=1` to research a new brief live |
| `npm run poke` | Drive any synthetic tool directly and watch the wire response plus the stripped state mutation | none for the kernel; `--persona` needs a key |
| `npm run shell` | Enter an LLM-backed bash, or chat with a tool persona in character | `ANTHROPIC_API_KEY` |

`sweep`, `sweep:bash`, `optimize`, `research` (refund reproduction), `poke`, and
`npm run dev` are fully keyless. `sweep:live`, `shell`, and `optimize --harness live`
call a model. `research` on a new brief also needs web access. `sweep:sandbox`
provisions real microVMs. Each gated path prints a friendly pointer and exits 0
when its credentials are absent, so the whole matrix is safe to run keyless. The
full as-built status and roadmap mapping is in `docs/13-implemented-status.md`.

Other useful scripts:

```bash
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest run
npm run dev         # the evidence-viewer UI at http://localhost:3000
```

Requires Node 22 or newer locally.

## Vision

A user describes a problem. Instead of hand-writing the full agent workflow, an
LLM designs the harness around the task:

- what context it needs
- what tools it should have
- what procedures it should follow
- what outputs it should optimize for
- what evidence should count as success

The next step is the important part: the harness does not immediately operate in
the real environment. It is placed inside a synthetic sandbox where tool use is
simulated by stateful LLM-backed environments.

For example, a `bash` command is not necessarily real bash. It can be a synthetic
shell agent with its own filesystem state, constraints, logs, failure modes, and
hidden business context. The same pattern can apply to APIs, ticketing systems,
databases, browsers, Slack, CRMs, test suites, and domain-specific tools.

That synthetic world lets us ask a different question:

> Does this agent harness behave well for the problem we actually care about?

## Core Loop

1. **Generate the harness**
   - Start from a business or operational problem.
   - Let the agent design its own task-specific workflow, tools, context model,
     and success criteria.

2. **Build the synthetic sandbox**
   - Replace real tools with LLM-backed simulators.
   - Give each synthetic tool its own state and behavior.
   - Model realistic constraints, incomplete information, ambiguity, and
     business-specific edge cases.

3. **Run scenario sweeps**
   - Test the harness against many synthetic situations.
   - Vary personas, goals, hidden states, environmental failures, and priorities.
   - Capture traces of decisions, tool calls, recoveries, and final outcomes.

4. **Judge from the right perspective**
   - Score the harness on business outcomes and problem-solving quality, not only
     on technical correctness.
   - Use judge agents, rubrics, and task-specific evaluators to identify where
     the harness is brittle, overconfident, under-tooled, or misaligned.

5. **Optimize the harness**
   - Use DSPy-style optimization to improve prompts, tool definitions, routing,
     and judging criteria.
   - Iterate until the harness is not just functional, but meaningfully better at
     the target task.

## Why This Matters

Agent tooling is often evaluated as if the main question is whether the agent can
complete a technical sequence. In real work, the harder question is whether the
agent is solving the right problem in the right way.

Synthetic sandboxes make it possible to test that gap cheaply and repeatedly.
They let us pressure-test agent behavior before exposing it to production
systems, real customers, real tickets, real files, or real spend.

## What is implemented

The full loop is built and runs keyless against the refund flagship, with the
live model and real-microVM paths behind credentials:

- **Research and initialization** turns a brief into a harness and its tools: an
  intake interview, capability decomposition, tool discovery, contract
  acquisition, dossiers with the enforced-versus-not-enforced split, and a gated
  generation pass. Tools are instantiated from their dossiers by a generic kernel,
  so nothing is hand-coded per tool.
- **The synthetic world** is a society of agents: an egress gateway over a shared
  core, a real local-exec and a real Vercel Sandbox bash substrate, an
  LLM-backed bash, and each tool available either as a deterministic kernel or as
  a Claude Agent SDK persona over that kernel (the kernel always owns money and
  state).
- **The judge** scores business fit deterministically from the trace.
- **The optimizer** runs the harness, reads the judge's failure tags, proposes
  spec edits, and keeps one only if Trust rises and technical-pass holds, learning
  the policy gates on its own and validating on a held-out split.
- **The evidence viewer** renders any of it.

See `docs/13-implemented-status.md` for the as-built architecture, the roadmap
mapping, and how to run every path with your own keys.

## License

MIT
