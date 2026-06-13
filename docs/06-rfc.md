# RFC: Synthetic Harness Lab

**Status:** Superseded · **Scope:** full / end-to-end · **Flagship:** Refund Trap

> Superseded by `10-rfc-v2.md`, which incorporates the harness-generator and synthetic-world design (docs 07-09) and locks the open decisions. Kept for history.

This RFC is the superset of the one-day plan in `docs/00-05`; that plan is the **M0** slice of this document. The Harness Generator and its research step are specified in depth in `07-harness-generation-and-tool-research.md`; the synthetic world (bash sandbox, per-tool agents, agent topology) in `08-synthetic-world-and-agent-topology.md`; a fully worked refund example in `09-refund-worked-example.md`.

## 1. Problem

Coding agents can now generate their own task-specific harnesses: the tools, system prompt, procedure, and success criterion for a job. But a harness that *runs cleanly* is not a harness that *solves the business problem*. The gap is invisible to ordinary checks: every tool call returns 200, every task reaches a terminal state, CI is green, while the agent quietly does the wrong thing in ways only the business feels (money lost, policy broken, trust eroded).

You cannot safely discover that gap in production, and a plain mock API cannot reveal it because the mock has no business consequences. You need an environment that behaves like the real one (stateful, rule-bearing, occasionally adversarial) but is synthetic and free to fail.

## 2. What we are building

A lab that, given a task, (a) researches the world and generates a harness, (b) runs it inside a synthetic sandbox of LLM-backed stateful tools, (c) captures a full trace, (d) judges business-fit against a rubric the model can grade on its own, and (e) optimizes the harness across runs until business-fit climbs without breaking technical-pass.

The flagship demonstration is Refund Trap; the architecture is scenario-pack-driven so the same engine runs any business workflow.

## 3. Goals / Non-goals

**Goals**
- Make the business-fit gap visceral and verifiable: one screen where technical-pass stays flat at 100% while a business Trust Score and a Cash Burned figure transform.
- A real optimization loop: judge feedback drives harness edits and measurable improvement, including on held-out scenarios, not just memorized ones.
- Generalization: a new scenario pack runs end-to-end with no engine changes.
- Model-verifiable "done": a rubric file, a test suite, and a responding URL the model can check itself.

**Non-goals (for now)**
- Letting a harness touch real production tools ("graduation"). The value is pre-production.
- A general agent platform. We optimize harnesses for tasks, not arbitrary agents.
- Meta-iteration on the tool set. For now the research step picks a tool set and commits to it.
- The UI being the product. It is an evidence viewer.

## 4. Design principles

- **The trap is emergent, not rigged.** Synthetic tools enforce only what the real API enforces. The business-fit gap is the genuine delta between enforced invariants and business intent, surfaced by the research step.
- **Everything is a Claude Agent SDK agent.** The harness under test, the bash sandbox, and each synthetic tool are all agents. The lab is a synthetic world of cooperating agents around the harness.
- **The dashboard is evidence, not the product.** The deliverable is the research-and-generation pipeline, the synthetic world, the judge, and the optimizer. The UI is a thin deterministic replay over traces.
- **Done is model-verifiable.** A rubric file, a test suite, and a responding URL mean the system can certify a harness without a human in the loop.

## 5. Users

- **Primary:** teams who let an agent generate a harness for a back-office workflow (refunds, claims, loan servicing, support triage) and need to trust it before it spends real money or touches real customers.
- **Secondary:** anyone evaluating agent setups who needs "done" to be machine-checkable against business intent, not just technical success.

## 6. Architecture (full scope)

```
                         task brief (under-specified)
                                    │
                   ┌────────────────▼─────────────────┐
                   │       Harness Generator            │  (see doc 07)
                   │  research step: discover the ideal │
                   │  real tools, fetch their API docs  │
                   │  + MCP/SDK specs, scrape intent,    │
                   │  build per-tool dossiers; then emit │
                   │  the harness spec AND the synthetic │
                   │  environment manifest              │
                   └───────┬───────────────────┬────────┘
                harness spec │                  │ synthetic env manifest
                   ┌─────────▼────────┐   ┌─────▼──────────────────────────┐
                   │  Harness (agent   │   │   Synthetic World (doc 08)     │
                   │  under test, an   │◄─►│ • bash agent: legitimate sandbox│
                   │  Agent SDK agent) │   │   shell; real local execution,  │
                   └─────────┬────────┘   │   synthetic network egress      │
                             │            │ • per-tool synthetic agents      │
                             │ every call,│   (one Agent SDK agent each),    │
                             │ shell cmd, │   each impersonating a real      │
                             │ egress,    │   service from its dossier +     │
                             │ state Δ    │   hidden state + fault injection │
                             ▼            └────────────────────────────────┘
                   ┌──────────────────┐
                   │   Trace store     │  frozen JSONL schema = the contract,
                   └────────┬─────────┘  spanning every agent in the world
                            │ trace + ground truth
                   ┌────────▼─────────┐
                   │  Judge / Rubric   │  deterministic scoring + 1 LLM call
                   └────────┬─────────┘  for CX; Trust Score, Cash Burned,
                            │            named failure tags
                   ┌────────▼─────────┐
                   │    Optimizer      │  propose harness edits → re-run →
                   └────────┬─────────┘  keep if Trust↑ and technical-pass held
                            │
                   ┌────────▼─────────┐
                   │  Evidence viewer  │  deterministic replay of cached traces
                   └──────────────────┘
```

**Components**

- **Scenario pack** (the generalization unit): a brief, fixtures (visible plus hidden state), a rubric (business-fit dimensions, weights, per-case ground truth and dollar impact), and a train / held-out split. Refund is pack #1. Note: the tool manifest is no longer an input; it is produced by the research step.
- **Harness Generator**: a research-and-synthesis pipeline. From the brief alone it discovers the realistic tool set, learns each tool, and emits both the harness spec and the synthetic environment manifest. Detailed in doc 07.
- **Harness**: the agent under test, a Claude Agent SDK agent driven by the generated spec, pointed at the synthetic world.
- **Synthetic World**: a bash sandbox agent plus one synthetic agent per tool, all Claude Agent SDK agents. Detailed in doc 08.
- **Trace store**: append-only JSONL with a schema frozen early as the shared contract; records every call, argument, response, shell command, and hidden-state mutation across every agent.
- **Judge / Rubric engine**: business-fit computed in deterministic code from trace plus ground truth; one LLM call for the customer-experience dimension and rationales. Emits Trust Score, Cash Burned, and named failure tags.
- **Optimizer**: given the current spec, its trace, scores, and failure tags, proposes spec edits and keeps a candidate only if Trust Score rises and technical-pass holds at 100%. Iterates to plateau; reports the curve and validates on held-out fixtures.
- **Evidence viewer**: three panels (harness spec / streaming trace / business panel) driven entirely by cached traces.

## 7. End-to-end flow

1. Load a scenario pack (brief, fixtures, rubric); validate against schema.
2. Generator runs the research step: discover tools, fetch docs and specs, scrape intent, build dossiers; emit the harness spec and the synthetic env manifest (one real generation pass, pinned for the demo).
3. Stand up the synthetic world: bash sandbox plus one synthetic agent per tool, each seeded from its dossier, hidden state, and fixtures.
4. Executor runs the harness across the train fixtures inside the synthetic world; traces written.
5. Judge scores: technical-pass 100%, Trust ~38, Cash Burned ~$5,140, failure tags.
6. Optimizer proposes edits, re-runs, keeps improvements, produces v2 through vN; Trust climbs.
7. Validate on held-out fixtures to prove the harness generalized rather than memorized.
8. Viewer replays v1 versus final: technical flat, Trust and Cash transformed, spec diff annotated with the failure each new rule resolves.

## 8. Tech stack (proposed; decisions in section 11)

- **Next.js (App Router) on Vercel**: single deployable; evidence-viewer UI plus serverless API routes for the executor, judge, and optimizer. Provides the responding URL the orchestration criterion wants.
- **Claude Agent SDK** for every agent in the system: harness, bash sandbox, and each synthetic tool.
- **Vercel Sandbox** as the real-execution substrate for the bash interface (legitimate code execution), with a network egress shim routing external calls to synthetic tool agents. See doc 08.
- **Claude (Opus 4.8)** for the generation, optimizer, and judge reasoning; model tiering for high-volume synthetic-tool chatter is a decision, not a default.
- **Judge in TypeScript** as pure functions over trace plus ground truth; deterministic and unit-testable.
- **Optimizer**: homegrown TS loop modeled on DSPy ideas (propose, evaluate, keep-if-better). Full DSPy in Python is a fork to consider only if we want richer search.
- **Trace persistence**: filesystem JSONL locally; Vercel Blob in deploy. Postgres only if we want run history.
- **Determinism for demo**: real runs are cached; the live moments are the single generation pass and optionally one live optimizer iteration; the rest replays from cache.

## 9. Roadmap (no fixed deadline; rough sequencing)

- **M0 - Flagship, scripted.** The `docs/00-05` build: refund pack, synthetic runtime, executor, deterministic judge, pinned v1, committed v2, replay UI. Proves the thesis end-to-end.
- **M1 - Real optimization loop.** Replace committed v2 with the live optimizer; add the Trust-Score-over-iterations curve and the held-out split.
- **M2 - Research-driven generation.** Implement the research step and the synthetic env manifest so the tool set is discovered, not hand-authored (docs 07-08).
- **M3 - Scenario-pack framework.** Extract refund specifics into the pack format plus loader and schema validation; prove a second pack runs with zero engine changes.
- **M4 - Richer synthetic realism.** Fault profiles (latency, 500s, partial data), more adversarial personas, multi-tool workflows.
- **M5 - Self-verifying and deployable.** Rubric file plus test suite plus responding URL so "done" is model-checkable; polish the viewer; harden replay.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| "Dashboard is the main feature" disqualifier | Product is the research/generation pipeline, synthetic world, judge, and optimizer; UI is a thin replay/evidence layer over traces. |
| "The trap was rigged" | Synthetic tools enforce only what the real API enforces; hidden state is fully present and readable in every trace; the judge is deterministic; identical untouched tools run every version. |
| Optimizer overfits the fixtures | Train / held-out split; report the generalization gap; headline number is the held-out Trust Score. |
| LLM-tool nondeterminism breaks the demo | Temp 0, pinned model, cache real runs, deterministic replay; the live calls have committed fallbacks. |
| Cost / latency over weeks of iteration | Cache aggressively; decide model tiering for synthetic-tool chatter; reasoning stays Opus 4.8. |
| Scope sprawl | Each milestone is independently demoable; M0 alone is a complete story. |

## 11. Open decisions

1. **Stack:** all-TypeScript (recommended, one deploy) versus TS UI plus Python optimizer service (only if we want real DSPy search).
2. **Model tiering:** Opus 4.8 everywhere (simplest, best quality) versus Opus for reasoning plus a smaller model for high-volume synthetic-tool calls. Default Opus everywhere given credits; revisit only if cost bites.
3. **Optimizer edit surface:** system-prompt-only versus prompt plus procedure plus tool specs. Recommend the full surface.
4. **Second scenario pack** for M3: loan servicing, claims triage, or support-ticket dedup.
5. **Persistence depth:** ephemeral traces versus stored run history (enables a harness leaderboard stretch).

## 12. What success looks like (our own rubric)

- A new scenario pack runs end-to-end with zero engine changes.
- The optimizer lifts held-out Trust Score by a meaningful margin while technical-pass stays 100%.
- "Done" is model-verifiable: rubric file plus test suite plus responding URL.
- The before/after lands in under three minutes on the flat-technical / moving-business frame.
