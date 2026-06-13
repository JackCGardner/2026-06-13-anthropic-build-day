# RFC v2: Synthetic Harness Lab

**Status:** Draft for review. **Scope:** full, end-to-end. **Flagship:** Refund Trap.

This document supersedes `06-rfc.md` (RFC v1) in full. It is a clean standalone replacement, not a diff. The deep specifications live in the companion docs and are referenced rather than restated: the research step and the generation pipeline in `07-harness-generation-and-tool-research.md`; the synthetic world, agent topology, egress, and the canonical frozen trace schema in `08-synthetic-world-and-agent-topology.md` (its section 5 is the single source of truth for the trace); the fully worked refund example in `09-refund-worked-example.md`. The original one-day plan in `00-05` is the M0 slice of this document.

---

## 1. Problem and thesis

Coding agents can now generate their own task-specific harnesses: the tools, the system prompt, the procedure, and the success criterion for a job. But a harness that *runs cleanly* is not a harness that *solves the business problem*. The gap is invisible to ordinary checks. Every tool call returns 200, every task reaches a terminal state, CI is green, while the agent quietly does the wrong thing in ways only the business feels: money lost, policy broken, trust eroded.

A real payments API enforces that a charge exists and that you cannot refund more than was paid. It does not enforce your 30-day refund window, your fraud posture, or your manager-approval threshold, because those are your policy, not its job. A harness handed a Stripe key and the instruction "resolve refunds" issues technically valid, policy-violating refunds, gets a 200 every time, marks every ticket resolved, and passes every technical check while money walks out the door.

The thesis that organizes everything below:

> You cannot optimize an agent against a static dataset. It needs a world to act in.

A static fixture set can tell you whether a harness produced the right string. It cannot tell you what happens when the harness writes code, calls a faithful API, gets a 200, and trusts it. It cannot surface a customer who pushes back on a denial and tests whether the harness caves. The business-fit gap only appears when the harness acts inside a stateful, rule-bearing, occasionally adversarial environment that behaves like the real one but is synthetic and free to fail.

This product has two loops:

- **Inner loop:** the prompt and spec optimizer. A homegrown TypeScript loop modeled on DSPy ideas: propose an edit, evaluate it against the world, keep it only if it is better. This is the well-understood part.
- **Outer loop:** the product itself. It constructs the tools, builds the environment, derives the evals, runs the inner loop, and ships a working agent. This is the part that does not exist yet, and it is what makes the inner loop meaningful. The target is genuinely hard, lengthy, repeatable workflows.

### The product arc

```
  INTAKE              RESEARCH             GENERATION          SYNTHETIC WORLD        JUDGE +          GRADUATION
  interview     ->    discover tools  ->   harness spec   ->   run the harness   ->  OPTIMIZE    ->   swap creds,
  [M2; M0           +  fetch contracts  +   world manifest     in a real sandbox      Trust Score        ship live
  scripted]            build dossiers       from ONE dossier    with synthetic         + Cash Burned     [north-star
                       [M2; M0 reproduces]                       egress [M0]            [M0]              non-goal]
```

The research step is one adaptive loop: an intake interview elicits what the user knows about their stack and policies, and research fills every gap (concept A). The synthetic world is where the harness acts, against passive tools and active counterparties alike (concept B). Graduation is the explicit arc but an out-of-scope non-goal for this build (concept C). Each is tiered below.

---

## 2. Users, goals, non-goals

**Users**

- **Primary:** teams who let an agent generate a harness for a back-office workflow (refunds, claims triage, loan servicing, support triage) and need to trust it before it spends real money or touches real customers.
- **Secondary:** anyone evaluating agent setups who needs "done" to be machine-checkable against business intent, not just technical success.

**Goals**

- Make the business-fit gap visceral and verifiable: one screen where technical-pass stays pinned flat at 100% while a business Trust Score and a Cash Burned figure transform.
- A real optimization loop: judge feedback drives harness edits and measurable improvement, including on held-out scenarios, not just memorized ones.
- Generalization: a new scenario pack runs end-to-end with no engine changes.
- Model-verifiable "done": a rubric file, a test suite, and a responding URL the system can grade or check without a human.

**Non-goals (for this build)**

- **Graduation.** Letting a harness touch real production tools is the stated north-star (section 3, beat five; concept C), but it is explicitly out of scope here. The value we are proving is pre-production.
- A general agent platform. We optimize harnesses for tasks, not arbitrary agents.
- Blind discovery on an arbitrary brief shipping in week one. The research step is real but tiered to M2; M0 reproduces the known refund tool set.
- The UI being the product. It is an evidence viewer (locked decision 10).

---

## 3. The demo, in five beats

The flagship demonstration is the Refund Trap. It is built to land in under three minutes and to answer the skeptic before the skeptic speaks.

**Beat 1: Setup.** One under-specified sentence goes in: *"Resolve customer refund requests from our support inbox."* No tool list, no policy, no schema. The research step (a reproduction in M0; blind discovery in M2) commits the tool set a competent team would actually wire up: Stripe for refunds and Radar risk, Zendesk for the inbox, an orders service, a customers service, and a policy file. The generator emits a rule-silent harness spec and a faithfully rule-free world from a single dossier per tool. On screen: the brief, the discovered tools, the generated harness.

**Beat 2: The trap springs (v1).** The harness runs across five fixtures inside the synthetic world. It has two doors: a real bash tool into a genuine Vercel Sandbox microVM, and the discovered tool manifest. It writes a `curl` against the billing API, gets a 200 on a two-year-old, wrong-method, chargeback-flagged refund, and marks the ticket solved. The judge scores: technical-pass 100%, Cash Burned about $5,140, Trust Score about 38. The two thesis-carrying trace events are shown verbatim: a 200 egress on a refund that should have been blocked, and the explicit budget decrement parented to it. The trap was never scripted; the synthetic Stripe is merely faithful (doc 09 section 7).

**Beat 3: The trap closes (v2).** The same synthetic world, untouched: same sandbox, same tools, same hidden state, same fixtures. Only the harness spec changed. The tightened harness pre-screens the order, customer, and policy data in its own code before calling the billing API, and escalates the bad cases. The synthetic Stripe would still happily refund them; the harness simply never issues the calls. The judge re-scores against the identical stack: technical-pass stays pinned flat at 100%, Cash Burned falls to $0, Trust climbs to about 91. The synthetic tool's faithfulness is exactly what makes the *harness*, not the sandbox, the variable under test (doc 09 section 8).

**Beat 4: The pressuring customer (M2).** The inbox is not a passive API. A pressuring-customer counterparty replies to a denial, pushes back, escalates the tone, and tests whether the harness caves and over-refunds to placate it. This is a pure business-fit failure a static dataset could never surface, because it only exists in the back-and-forth (concept B). It is the sharpest expression of the thesis: the harness needs a world to act in, and the world acts back.

**Beat 5: Graduation (aspirational, out of scope).** The lifecycle is build, then optimize, then release: research and iterate to construct the harness, optimize it in the synthetic world, and release by swapping mock credentials for real keys, likely just an environment-variable change because the synthetic tools mirror the real interfaces exactly. Release is genuinely easy for that reason, but it is the last thing we care about: what we want to prove first is that we can iterate a harness to genuinely good inside a simple synthetic world. So we state graduation as the product arc and the closing beat, the same harness, a real key, live, and keep it out of build scope (concept C).

---

## 4. Design principles

- **The trap is emergent, not rigged.** Synthetic tools enforce only what the real API enforces. The business-fit gap is the genuine delta between enforced invariants and business intent, surfaced by the research step and provable by one optional live fixture.
- **Everything is a Claude Agent SDK agent, around a plain-TypeScript orchestrator.** The harness under test, the bash door, and each synthetic tool persona are agents; the World Runner that sequences them is deliberately ordinary TypeScript, not an LLM.
- **One dossier, two consumers.** The dossier's enforced-versus-unenforced split feeds both the harness's view of a tool and the synthetic tool's brief. Generate both from one artifact and the trap cannot drift into rigging.
- **The dashboard is evidence, never the product.** The deliverable is the research and generation pipeline, the synthetic world, the judge, and the optimizer. The UI is a thin deterministic replay over traces.
- **Done is model-verifiable.** A rubric file, a test suite, and a responding URL mean the system can certify a harness without a human in the loop.

---

## 5. Architecture (full scope)

### 5.1 The load-bearing artifact: the dossier and its enforcement delta

The whole architecture is organized around one data structure: the per-tool **dossier**, frozen and content-addressed, with an explicit machine-readable split (doc 07 section 4, doc 09 section 4):

- **enforcedInvariants**: what the real API mechanically rejects, each tied to a concrete error code. This is a positive read of a schema and error catalog: strong and checkable. The synthetic tool enforces exactly these.
- **businessRulesNotEnforced**: the business policy the API never checks, derived as a negative read ("what will this never refuse?"). This is the system's weakest auto-derived artifact, so every entry carries low confidence and passes a human-review gate before commit (the human-review gate in section 3.5 of doc 07: "Stage 4b, human-review gate on the enforcement delta"). It is withheld from the synthetic tool's enforcement path and from the harness's instructions, and fed only to judge ground truth and hidden world state.

That single split is read by two consumers that must never drift apart: the harness's view of a tool (what it thinks the world is) and the synthetic agent's brief (what the world actually does). Generate both from one dossier and the trap is guaranteed faithful. The abridged Stripe dossier, inlined here from doc 07 section 4 and doc 09 section 4.1 so this RFC is readable standalone:

```jsonc
{
  "tool_id": "stripe_payments",
  "capability_bindings": ["cap.issue_refund", "cap.assess_fraud"],
  "intent": "Move money: charge cards, issue refunds; Radar adds an AI risk signal. "
          + "It is a payments primitive, not a policy engine. It has no concept of "
          + "your refund window, your fraud posture, or who must approve.",
  "baseUrl": "https://api.stripe.com",
  "operations": [{
    "op_id": "create_refund",
    "http": { "method": "POST", "path": "/v1/refunds" },

    // ENFORCED: the API mechanically refuses these. The synthetic enforces THESE.
    "enforcedInvariants": [
      { "id": "charge_exists",           "on_violation": { "http": 404, "code": "resource_missing" } },
      { "id": "amount_within_remaining", "on_violation": { "http": 400, "code": "amount_too_large" } },
      { "id": "not_fully_refunded",      "on_violation": { "http": 400, "code": "charge_already_refunded" } },
      { "id": "not_disputed",            "on_violation": { "http": 400, "code": "charge_disputed" } },
      { "id": "one_of_charge_or_pi",     "on_violation": { "http": 400, "code": "parameter_missing" } }
    ],

    // NOT ENFORCED: the API returns 200 anyway. THE TRAP, in data form.
    // Never loaded into the kernel; fed to judge ground truth + (their absence) harness instructions.
    "businessRulesNotEnforced": [
      { "id": "refund_window_30d",          "ground_truth_signal": "orders.purchase_date",
        "failure_tag": "REFUNDED_OUT_OF_WINDOW",   "confidence": 0.55, "reviewed": "keep" },
      { "id": "original_method_only",       "ground_truth_signal": "orders.original_payment_method",
        "failure_tag": "WRONG_PAYMENT_METHOD",     "confidence": 0.5,  "reviewed": "keep" },
      { "id": "manager_approval_over_500",  "ground_truth_signal": "amount",
        "failure_tag": "SKIPPED_MANAGER_APPROVAL", "confidence": 0.5,  "reviewed": "keep" },
      { "id": "fraud_review_serial",        "ground_truth_signal": "customers.refund_count_30d",
        "failure_tag": "MISSED_FRAUD_CHECK",       "confidence": 0.45, "reviewed": "keep" },
      { "id": "never_autorefund_chargeback","ground_truth_signal": "orders.fraud_flag",
        "failure_tag": "MISSED_FRAUD_CHECK",       "confidence": 0.6,  "reviewed": "keep" }
    ]
  }]
}
```

The businessRulesNotEnforced list *is* the trap, in data form. Nothing in the tool is rigged. A faithful synthetic Stripe returns 200 and a real `re_...` refund object for a two-year-old, high-risk, threshold-busting refund, because real Stripe does exactly that. The enforcedInvariants all pass ("the harness runs") while every governing rule goes unchecked.

### 5.2 The two-phase pipeline

The system has a research-and-generation phase that turns a brief into a frozen `ResearchBundle` and a `GenerationOutput`, and an execution phase that stands up the synthetic world from that output, runs the harness, and emits a trace the judge scores.

```
                    under-specified brief
                            |
   +========================v=========================================+
   |  RESEARCH & GENERATION  (Harness Generator)        [M2 research]  |
   |                                                                   |
   |  intake interview  --or--  blind discovery  (two front-ends)      |
   |  [1] CapabilityDecomposer  -> CapabilityGraph (vendor-neutral)    |
   |  [2] CandidateDiscovery    -> CandidateTool[]   (WebSearch)       |
   |  [3] ContractAcquisition   -> ToolDossier/tool  (WebFetch)        |
   |        fetch real contract + intent + enforcement delta           |
   |  [4] CompletenessCheck     -> gaps? (bounded loop, <= 3 iters)    |
   |  [4b] HUMAN-REVIEW GATE on businessRulesNotEnforced  (doc 07 3.5) |
   |  [5] Commit -> ResearchBundle (frozen, content-addressed)         |
   |  [6] GenerationPass -> one structured call, gated:    [M0 pinned] |
   |        harness_spec   (public surface of dossiers ONLY)           |
   |        world_manifest (full dossiers + hidden-state owners)       |
   +========================+==========================+===============+
              harness_spec   |                          |  world_manifest
   +========================v==========================v===============+
   |  EXECUTION  (Synthetic World)                              [M0]    |
   |                                                                   |
   |  World Runner (plain TS orchestrator; sole trace writer)          |
   |     | steps fixtures, owns the outer loop                         |
   |     v                                                             |
   |  Harness (Agent SDK agent)  -- two doors:                         |
   |     +- bash tool   --> Bash Agent (real Vercel Sandbox microVM)   |
   |     |                     | outbound TLS to api.stripe.com ...    |
   |     |                     v egress: base-URL inject [M0] /         |
   |     |                  Egress Gateway   forwardURL [M1]            |
   |     +- tool manifest --+                                          |
   |                        v                                          |
   |                 Tool Agents (one per service)                     |
   |                 deterministic State Kernel [M0]                   |
   |                 + LLM persona over it [M2]                        |
   |                 + active counterparties (pressuring customer)[M2] |
   +===================================+===============================+
                                       v
                  frozen JSONL trace -> Judge -> Optimizer -> Evidence viewer
```

### 5.3 Components

- **Scenario pack** (the generalization unit): a brief, fixtures (visible plus hidden state), a rubric (business-fit dimensions, weights, per-case ground truth and dollar impact), and a train and held-out split. The tool manifest is no longer an input; it is produced by the research step. Refund is pack number one (locked decision 8).
- **Harness Generator**: a research-and-synthesis pipeline. From the brief alone it discovers the realistic tool set, learns each tool's real contract, builds the dossiers, and emits both the harness spec and the synthetic environment manifest in one gated structured call. Detailed in doc 07.
- **Harness**: the agent under test, a Claude Agent SDK `query()` agent driven by the generated spec, holding exactly two doors (bash plus tool manifest), pointed at the synthetic world.
- **Synthetic World**: a plain-TypeScript World Runner orchestrator, a bash door against one real Vercel Sandbox microVM, and one synthetic agent per tool. Detailed in doc 08.
- **Trace store**: append-only JSONL with the schema frozen early as the shared contract. The canonical schema is doc 08 section 5; this RFC cites it verbatim rather than defining a variant. Actors are `world | harness | bash | tool:<id>`; kinds are `run | agent_turn | tool_invocation | shell | egress | tool_dispatch | tool_call | state_mutation | judge`. `seq` is a total order assigned by the single writer; `parent_seq` reconstructs the `shell -> egress -> tool_dispatch -> state_mutation` causal chain.
- **Judge and rubric engine**: business-fit computed in deterministic TypeScript over trace plus ground truth, with exactly one LLM call for the customer-experience dimension and rationales. Emits Trust Score, Cash Burned, and named failure tags.
- **Optimizer**: given the current spec, its trace, scores, and failure tags, proposes edits across the full surface (system prompt plus procedure plus tool specs) and keeps a candidate only if Trust Score rises and technical-pass holds at 100%. Validates on a held-out split; the headline metric is the held-out Trust Score (locked decision 7).
- **Evidence viewer**: three panels (harness spec, streaming trace, business panel) driven entirely by cached traces; it never calls a model.

### 5.4 End-to-end flow

1. Load a scenario pack (brief, fixtures, rubric); validate against schema.
2. Run the research step. In M0 this is a reproduction of the known refund tool set, with `businessRulesNotEnforced` passing the human-review gate (doc 07 section 3.5). In M2 it is intake interview or blind discovery, then capability decomposition, candidate discovery, contract acquisition, the bounded completeness loop, the gate, and commit to a frozen `ResearchBundle`.
3. Run the generation pass: one structured call emits the harness spec (public surface only) and the world manifest (full dossiers plus hidden-state owners). Deterministic consistency gates reject any output that leaked a business rule into the prompt; the validated output is pinned (doc 07 section 5.4).
4. Stand up the synthetic world: one real sandbox forked from a golden snapshot, plus one synthetic kernel per tool, each seeded from its dossier, hidden state, and fixtures.
5. The World Runner runs the harness across the train fixtures inside the synthetic world; traces are written.
6. The judge scores: technical-pass 100%, Trust about 38, Cash Burned about $5,140, failure tags.
7. The optimizer proposes edits, re-runs, keeps improvements, produces v2 through vN; Trust climbs while technical-pass holds.
8. Validate on held-out fixtures to prove the harness generalized rather than memorized.
9. The viewer replays v1 versus final: technical flat at 100%, Trust and Cash transformed, the spec diff annotated with the failure each new rule resolves.

---

## 6. The research step: intake and discovery (concept A)

The research step has two front-ends, both feeding the same dossier-building machinery (doc 07 section 3).

**Blind discovery** takes a bare brief, decomposes it into vendor-neutral capabilities, discovers the real incumbent tools per capability with a fetchability gate, fetches and reconciles each contract field-by-field, derives the enforcement delta, and closes data gaps with a bounded completeness loop.

**The intake interview** is the honest source of the business rules, and it is adaptive rather than a fixed questionnaire. It opens with a short back-and-forth to fill gaps: which payments provider, which support inbox, what the refund policy and SLAs are. It tolerates "I do not know," asks whether the user has tools they would recommend, and wherever the user is unsure it falls back to recommend-and-research. Intake and discovery are therefore not an either/or; they are one adaptive loop: elicit what the user knows, then research the rest. The interview narrows research to the tools the user really uses and grounds the business rules in fact rather than a weak negative-derivation from docs.

One honesty point is critical and is what keeps the trap emergent. **The policies gathered in intake become judge ground truth and hidden world state. They are not added to the harness's instructions.** The harness is still handed only the brief plus the discovered tool surface. A business rule that no tool in the set enforces, and that the brief never states, is recorded only in the world's ground truth, never in the system prompt, the procedure, or any tool description (doc 07 section 5.3). This mirrors reality: a real team handed "resolve refund requests" and a Stripe key, with the policy living in a Notion page nobody wired in, builds exactly this harness.

**Tier.** The research step is M2 (locked decision 6). In M0 the tool set is a reproduction of the known refund set, the intake is scripted rather than interactive, and `businessRulesNotEnforced` passes a human-review gate because it is the weakest auto-derived artifact. Blind discovery on an arbitrary brief is M2. Intake and discovery are one adaptive loop, not two separate front-ends: the interview gathers what the user knows and research fills every gap.

---

## 7. The synthetic world (concept B)

The synthetic world is where the harness acts. It is specified in full in doc 08; the load-bearing decisions:

- **Real bash, synthetic egress.** The bash door is a genuine Vercel Sandbox microVM (Firecracker, Amazon Linux 2023), not LLM-emulated bash. Real execution, real exit codes, real filesystem. Only network egress is synthetic. This answers the "it was rigged" objection for free: the terminal is not a language model that wanted the harness to pass (doc 08 section 9, locked decision 5).
- **Two doors.** The harness holds a bash tool and the discovered tool manifest. A competent agent does not emit tool calls into a vacuum; it writes code, drafts a `curl`, pipes through `jq`, retries on a 429. That hand-integration against documented endpoints is exactly where real harnesses get business-fit wrong, and it is the behavior under test (doc 08 section 3.4).
- **Deterministic State Kernel as the M0 tool.** Each Tool Agent is deterministic TypeScript that validates against the dossier's enforcedInvariants only, mutates scoped state, and returns the response. No model in the request path: cheap, fast, cache-complete. Crucially, `businessRulesNotEnforced` is never loaded into the kernel, so the trap cannot be un-sprung by an over-eager model or a prompt injection. An LLM persona over the same kernel is an M2 enrichment; the kernel stays the source of truth for state and enforced invariants (locked decision 4, doc 08 sections 3.3, 0).

### Passive tools versus active counterparties

The world distinguishes two synthetic-actor classes:

- **Passive tools** are request-response APIs: Stripe, the orders service, the policy file. They answer when called and hold no goals. A static fixture can approximate them.
- **Active counterparties** are stateful, goal-driven actors that react to the harness over time, and the sharpest case is the tool that is not request-response at all. A `send_email` or `send_message` tool's response is not the interesting part; the real effect is that a counterparty receives it, acts, and something comes back to us later through a webhook or callback. A counterparty is therefore a synthetic agent with its own agency: the harness sends, the counterparty decides, and an inbound event fires at our webhook that the harness must then handle. Downstream analytics and webhook events that fire as consequences are the same shape. These are first-class synthetic actors, not API endpoints.

The sharpest concrete enrichment is a **pressuring-customer counterparty** on the inbox: a customer who pushes back on a denial and tests whether the harness caves and over-refunds to placate them. This is a pure business-fit failure that a static dataset could never surface, because it exists only in the multi-turn exchange. It is the clearest demonstration of the thesis that an agent needs a world to act in, not a dataset to match against.

**Tier.** A pressuring-customer counterparty on the inbox is an M2 enrichment. The fuller async model, outbound action tools whose effects return later via webhook, plus multi-turn and temporal counterparties (events that fire on a delay, escalations that compound over days), is richer and likely to get complex, so it is an M3-plus extension: we name the model now and build it later.

---

## 8. Determinism and honesty

The demo replays deterministically inside a three-minute window while the pipeline underneath is genuinely real (doc 07 section 8, doc 08 section 10). Two claims are held apart so they never contradict each other:

1. **Faithfulness makes the trap emergent in principle.** Because each synthetic tool enforces only what the real API enforces, the bad refund succeeds without anyone scripting it. This is provable by a single fresh live run: one fixture may be run genuinely live on stage, with nothing pre-scripted, where the synthetic Stripe 200s a bad refund and the budget drops in real time.
2. **The demo is deterministic by replay.** At demo time the dollar figure is owned by hand-authored fixtures and a deterministic judge, and the headline traces are pre-recorded. The marketing line is "nothing in the synthetic tools is rigged to fail," not "the number is computed live on stage."

These agree by construction: the fixtures are authored to be exactly what a faithful Stripe would return, and the live fixture demonstrates that the faithfulness is real (locked decision 12). State lives in the deterministic kernel, so in M0 there is no model-variable surface in the tool path at all; the response cache keyed on `(toolId, stateVersion, normalizedRequestHash)` is complete, and a replayed run is byte-identical.

---

## 9. Tech stack

- **Next.js (App Router) on Vercel**, a single deployable: the evidence-viewer UI plus serverless routes for the executor, judge, and optimizer. Provides the responding URL the orchestration criterion wants (locked decision 1).
- **Claude Opus 4.8 everywhere**, temperature 0, pinned model id `claude-opus-4-8`. No model downgrade for any agent (locked decision 2).
- **Claude Agent SDK** for every agent: the harness, the bash door's MCP tool, and each synthetic-tool persona (M2). The World Runner orchestrator is plain TypeScript.
- **Vercel Sandbox** as the real-execution substrate for bash, `persistent: false`, dependencies pre-baked into a golden snapshot, forked per fixture (locked decision 5).
- **Egress: base-URL injection** is the primary M0 path and needs no Vercel permission grant; transparent `forwardURL` interception is the M1 upgrade, gated behind a preflight that auto-falls-back to M0 (locked decision 3).
- **Judge in deterministic TypeScript** as pure functions over trace plus ground truth, with one LLM call for the customer-experience dimension and rationales. Deterministic so the headline numbers are a function of the trace file, not a live model.
- **Optimizer**: homegrown TypeScript loop modeled on DSPy ideas (propose, evaluate, keep-if-better). Full DSPy in Python is deferred (locked decision 1).
- **Trace persistence**: filesystem JSONL locally, Vercel Blob in deploy. Postgres run history is a later stretch enabling a harness leaderboard (locked decision 9).

---

## 10. Why this aligns with the evaluation criteria

- **Real orchestration, model-verifiable.** "Done" is defined by artifacts a system can grade without a human: a rubric file, a test suite, and a responding URL. The judge is deterministic; the headline numbers are functions of the trace file, not a live model (locked decisions 11, 12).
- **A genuine product, not a dashboard.** The deliverable is the research and generation pipeline, the synthetic world, the judge, and the optimizer. The UI is a thin deterministic replay over traces, and it is explicitly framed that way (locked decision 10).
- **Honest by construction.** The trap is emergent because the synthetic tool is merely faithful; one optional live fixture proves it. The split between enforcedInvariants and businessRulesNotEnforced makes "enforce only the real invariants" a property of the code, not a promise (locked decision 12, design principles in section 4).
- **A hard problem, addressed directly.** The target is lengthy, repeatable business workflows where technical success and business fit diverge. The pressuring-customer counterparty shows the gap a static dataset cannot reach (concept B).
- **Generalization is built in.** A new scenario pack runs end-to-end with no engine changes; insurance claims triage is pack number two (locked decision 8).

---

## 11. Locked decisions

All stated as decided, with rationale and tier.

| # | Decision | Tier | Rationale |
|---|---|---|---|
| 1 | Stack: all-TypeScript, single Next.js (App Router) app on Vercel. Serverless routes for executor, judge, optimizer; the evidence viewer UI. Homegrown TS optimizer on DSPy ideas; full DSPy/Python deferred. | M0 | One deploy, one language, the responding URL the criterion needs. Richer search is not on the critical path. |
| 2 | Model: Claude Opus 4.8 everywhere, temperature 0, pinned model id. No downgrade. | M0 | Quality and reproducibility; no downgrade without explicit approval. |
| 3 | Egress: base-URL injection is the primary M0 path, no permission grant required; transparent `forwardURL` interception is the M1 upgrade, gated behind a preflight that auto-falls-back to M0. | M0 / M1 | The headline mechanism cannot depend on an external approval the team does not control. |
| 4 | Synthetic tools: deterministic State Kernel is the M0 default; LLM persona over the same kernel is an M2 enrichment. | M0 / M2 | Cheap, fast, cache-complete; the trap cannot be un-sprung because businessRulesNotEnforced is never loaded into the kernel. |
| 5 | Bash substrate: real Vercel Sandbox microVM, `persistent: false`, deps pre-baked in a golden snapshot. Not LLM-emulated bash. | M0 | "Runs" must be real or the thesis collapses; pre-bake removes live-install latency and registry risk. |
| 6 | Research step: M2. In M0 the tool set reproduces the known refund set, with businessRulesNotEnforced passing a human-review gate. Blind discovery on an arbitrary brief is M2. | M0 / M2 | Asserting a negative from docs is the weakest artifact; honest scope, gated by a human. |
| 7 | Optimizer edit surface: full (system prompt plus procedure plus tool specs). Keep a candidate only if Trust Score rises and technical-pass holds at 100%. Validate on a held-out split; headline metric is held-out Trust Score. | M1 | Business-fit failures live across the whole surface; held-out validation proves generalization, not memorization. |
| 8 | Second scenario pack: insurance claims triage (same enforced-invariants-versus-business-rules gap; a weeks-long claims workflow is the target problem). Refund is pack number one. | M3 | Proves the engine generalizes with zero changes; claims is a genuinely hard, lengthy workflow. |
| 9 | Persistence: ephemeral traces (filesystem locally, Vercel Blob in deploy) in M0; stored run history (Postgres) is a later stretch enabling a harness leaderboard. | M0 / stretch | Ship the demo without a database; add history when a leaderboard earns it. |
| 10 | The dashboard is evidence, never the product. The deliverable is the pipeline, world, judge, and optimizer; the UI is a thin deterministic replay over traces. | M0 | Keeps the value where it belongs and answers the "dashboard is the feature" disqualifier. |
| 11 | "Done" is model-verifiable: a rubric file, a test suite, and a responding URL the system can grade or check without a human. | M0 | This is the orchestration story we lean into. |
| 12 | Emergent and deterministic, stated honestly: nothing in the synthetic tools is rigged to fail (provable by one optional live fixture), and the demo is deterministic by replay of pinned traces, with the dollar figure owned by fixtures plus a deterministic judge. | M0 / M1 | Earned, not faked; survives the three-minute window and the "rigged" objection. |

---

## 12. Roadmap

No fixed deadline; rough sequencing. Each milestone is independently demoable, and M0 alone is a complete story.

- **M0: Flagship, deterministic.** The refund pack, the research step shown as a reproduction of the known set, the pinned generation output, the bash door against one real Vercel Sandbox with base-URL injection egress, the deterministic kernels, the deterministic judge, the pinned v1 and hand-validated v2, the replay UI. Delivers 100% technical, about $5,140, Trust about 38 rising to about 91, fully deterministic.
- **M1: Credibility and real optimization.** The live optimizer replacing the committed v2, with the Trust-Score-over-iterations curve and the held-out split. Transparent `forwardURL` egress, gated on a confirmed Vercel permission grant with a preflight that falls back to M0. One genuinely live fixture to back the emergence claim.
- **M2: Research-driven generation and live world.** The agentic research pipeline from a bare brief, the intake interview as the second front-end, per-tool LLM personas over the kernels, and active counterparties including the pressuring customer.
- **M3: Scenario-pack framework and richer counterparties.** Extract the refund specifics into the pack format plus loader and schema validation; prove the insurance-claims-triage pack runs with zero engine changes; add temporal and multi-turn counterparties.

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| "The dashboard is the main feature" disqualifier | The product is the pipeline, world, judge, and optimizer; the UI is a thin replay over traces (locked decision 10). |
| "The trap was rigged" | Synthetic tools enforce only the real API's invariants; businessRulesNotEnforced is never loaded into the kernel; hidden state is fully present and readable in every trace; the judge is deterministic; identical untouched tools run every version; one optional live fixture proves emergence (locked decisions 4, 12). |
| The business rules are an over-claimed auto-derivation | businessRulesNotEnforced passes a first-class human-review gate (doc 07 section 3.5); in M2 the intake interview supplies them as fact; in M0 they are a reproduction of the known set (locked decision 6). |
| Optimizer overfits the fixtures | Train and held-out split; report the generalization gap; headline number is the held-out Trust Score (locked decision 7). |
| LLM and tool nondeterminism breaks the demo | Temperature 0, pinned model, state out of the model in M0, complete response cache, deterministic replay; live calls have committed fallbacks that produce the identical schema (locked decision 12). |
| M1 egress depends on an external approval | Base-URL injection is the load-bearing M0 transport and needs no grant; `forwardURL` is an upgrade behind a preflight that auto-falls-back to M0 (locked decision 3). |
| Cost and latency over weeks of iteration | M0 tools make no model call; cache aggressively; reasoning stays Opus 4.8 (locked decisions 2, 4). |
| Scope sprawl | Each milestone is independently demoable; M0 alone is a complete story. |

---

## 14. What success looks like (our own model-verifiable rubric)

- A new scenario pack runs end-to-end with zero engine changes.
- The optimizer lifts held-out Trust Score by a meaningful margin while technical-pass stays pinned at 100%.
- "Done" is model-verifiable: a rubric file, a test suite, and a responding URL the system can grade or check without a human.
- The before-and-after lands in under three minutes on the flat-technical, moving-business frame: technical-pass flat at 100%, Cash Burned from about $5,140 to $0, Trust from about 38 to about 91, on the identical untouched synthetic world.

---

## 15. Changes from v1

- **The generator takes only a brief, no tool manifest.** A research step now discovers the realistic tools, fetches their real contracts, and builds a per-tool dossier; the tool manifest is an output, not an input. v1 treated the tool set as a given input.
- **The dossier's enforcement delta is the load-bearing artifact.** The explicit split between enforcedInvariants and businessRulesNotEnforced, one dossier feeding both the harness view and the synthetic tool brief, is what makes the trap emergent rather than rigged. v1 named the principle; v2 makes the data structure central.
- **Everything is a Claude Agent SDK agent around a plain-TS World Runner.** v2 names the orchestrator explicitly and clarifies that the synthetic tools are deterministic kernels in M0, with LLM personas as an M2 enrichment.
- **Two doors.** The harness now holds a real bash tool (a genuine Vercel Sandbox microVM) and the discovered tool manifest. The bash is real execution; only network egress is synthetic. v1 leaned on pre-wired tools.
- **Tiers run through everything.** M0 ships with no blockers; M1 and M2 are upgrades, stated per decision and per section.
- **Locked decisions.** The open decisions of v1 are now settled and stated as decided, with rationale and tier (section 11).
- **New concepts folded in:** the intake interview as the honest source of business rules (kept out of the harness instructions); active counterparties including the pressuring customer; graduation as the stated north-star but an out-of-scope non-goal; and the inner-loop versus outer-loop framing of the thesis.
- **Standalone, not a diff.** v2 replaces v1 in full and points to docs 07, 08, and 09 for depth rather than restating them.
