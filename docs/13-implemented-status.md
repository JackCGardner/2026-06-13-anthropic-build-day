# Implemented Status

What is built today, how it maps to the original roadmap, and how to run every path. This document is the as-built source of truth; the earlier docs (00-12) are the design that led here.

## The loop, end to end

A brief becomes a researched harness; the harness runs in a synthetic world of agents; a judge scores business fit from the trace; an optimizer improves the harness from that feedback. Every stage runs with no credentials against the refund flagship. The live-model and real-microVM paths turn on with keys.

```
  brief
   -> research / initialization   (intake, discover tools, fetch contracts, build dossiers, generate harness)
   -> synthetic world             (gateway + kernels, tool personas, real or LLM bash)
   -> judge                       (deterministic business-fit score from the trace)
   -> optimizer                   (propose spec edits, keep if Trust up and technical held, iterate)
```

## Components, all implemented

- **Engine.** Frozen contracts (trace, dossier, scenario, state, seams); five hand-written deterministic tool kernels; a generic dossier-driven kernel that interprets any dossier's enforced invariants via an extensible registry (so a researched tool runs with no per-tool code); the refund scenario pack; the deterministic judge.
- **Synthetic world.** An egress gateway over a shared egress-core (one kernel-dispatch and trace-writing path); a real local-exec bash substrate and a real Vercel Sandbox substrate; an LLM-backed bash; every tool available either as a deterministic kernel or as a Claude Agent SDK persona over that kernel. The kernel always owns money, state, and the enforced invariants; a persona is advisory and a re-validation seam overwrites any non-message field with the kernel's value.
- **Harness.** Scripted, spec-interpreter, and live Claude Agent SDK harnesses behind one seam; clean callable tools (get_ticket, lookup_order, lookup_customer, read_policy, issue_refund, escalate_to_human) plus bash; pinned and structured specs.
- **Optimizer.** The run, judge, propose, keep-if-better loop; discovers the policy gates on its own; validates on a held-out split; a deterministic proposer (keyless) and an LLM proposer (key).
- **Research / initialization.** Intake interview, capability decomposition, tool discovery, contract acquisition, dossier building with the enforced-versus-not-enforced split and a human-review gate, bounded completeness loop, and a generation pass with consistency gates that keep business rules out of the harness prompt. Live behind a key plus web access, with a keyless refund reproduction.
- **Evidence viewer.** A Next.js page rendering the sweep.

## Roadmap mapping

- **M0 (flagship, keyless): shipped.** Kernels, judge, fixtures, scripted sweep, real-bash egress, UI.
- **M1 (real optimizer, transparent egress): shipped.** The optimizer is keyless-verifiable and has an LLM proposer; forwardURL egress and the defineSandboxProxy route are behind the seam.
- **M2 (research from a brief, per-tool personas, LLM-bash): shipped.** Live behind keys; the keyless reproduction and persona-off paths are verified.

## Command matrix

| Command | What it proves | Credentials |
| --- | --- | --- |
| `npm run sweep` | Keyless thesis: v1 $5,140 / Trust 38, v2 $0 / Trust 91, both 100% | none |
| `npm run sweep:bash` | Same over a real shell plus HTTP plus local gateway process | none |
| `npm run optimize` | The optimizer discovers the gates: v1 to v2, held-out Trust 100 | none |
| `npm run research` | A brief to a gate-passing harness spec plus dossiers; generic world reproduces the trap | none (reproduction); key + `RESEARCH_WEB_ACCESS=1` for a new brief |
| `npm run poke` | Drive a synthetic tool directly; see the wire response and the stripped state mutation | none (kernel); `--persona` needs a key |
| `npm run dev` | The evidence-viewer UI at http://localhost:3000 | none |
| `npm run sweep:live` | The agent under test driven by a real model through the Claude Agent SDK | `ANTHROPIC_API_KEY` |
| `npm run shell` | Enter the LLM-backed bash or chat with a tool persona | `ANTHROPIC_API_KEY` |
| `npm run sweep:sandbox` | The same run inside real Vercel Sandbox microVMs | Vercel auth + `GATEWAY_PUBLIC_URL` |
| `npm run typecheck` / `npm test` / `npm run build` | strict typecheck / full suite / production build | none |

## Testing the live paths with your keys

```bash
export ANTHROPIC_API_KEY=...
npm run sweep:live                 # a real Opus agent runs the harness
npm run optimize -- --harness live # the optimizer over the live harness
npm run shell                      # enter the LLM bash or a tool persona

RESEARCH_WEB_ACCESS=1 npm run research "your own under-specified brief"

# Vercel Sandbox path: authenticate, deploy the egress route, then
GATEWAY_PUBLIC_URL=https://your-deploy/api/egress npm run sweep:sandbox
```

## Honest gaps and next steps

- **The live before-and-after still needs a scenario tuning pass.** In the first live run a real Opus agent over-refused (it blocked even the legitimate refund) and could not reliably operate the raw-curl interface. Clean function tools now fix the interface; the remaining work is tuning the v1 spec so a capable model confidently resolves tickets, so that missing the policy genuinely burns money and the optimizer's v1-to-v2 win shows on a live run, not only the keyless one. The optimizer and the research pipeline are proven keyless; the live before-and-after is the next tuning pass.
- **A second scenario pack** (for example claims triage) to prove the engine generalizes with zero changes.
- **Live generation of v2** by the LLM proposer end to end, beyond the keyless deterministic proposer.
