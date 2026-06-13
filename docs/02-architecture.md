# System Architecture

This document describes the system architecture for **Refund Trap: Watch a "Passing" Harness Burn Real Money**. It covers the components and their responsibilities, the end-to-end data flow, and the synthetic tool and runtime layer that makes the whole thing possible.

The architecture exists to demonstrate one move live: a refund-handling harness that passes every technical check while quietly losing the company money, and the same harness improved so it stops. Everything below is in service of making that single contrast exact, deterministic, and verifiable in front of an audience.

## Architecture at a Glance

The system is a pipeline of seven components plus a frozen data contract that ties them together. A harness spec flows in. Traces and scores flow out. A web UI replays the result.

```
                         under-specified task
                          + tool list
                                |
                                v
                     +---------------------+
                     |  Harness Generator  |   one live Claude call
                     |  (v1 spec emitted)  |   -> pinned committed artifact
                     +---------------------+
                                |
                                |  v1 harness spec (system prompt,
                                |  tool manifest, procedure, success criterion)
                                v
        +-----------------------------------------------+
        |          Agent Runtime / Executor             |
        |   Anthropic tool-use loop, per scenario       |
        |   runs each of 5 fixtures to a terminal       |
        |   decision                                    |
        +-----------------------------------------------+
             |                                    ^
   tool call |                                    | tool result
             v                                    |
        +-------------------------------------------------------+
        |                    Tool Layer                         |
        |  (six tools behind one uniform interface)             |
        |                                                       |
        |  synthetic_inbox   *  real Claude (adversarial prose) |
        |  issue_refund      *  real Claude (200-OK, rules-free)|
        |  lookup_order         deterministic fixture read      |
        |  lookup_customer      deterministic fixture read      |
        |  read_policy          deterministic fixture read      |
        |  escalate_to_human    logged no-op                    |
        +-------------------------------------------------------+
             |
             |  every call, argument, response,
             |  and hidden-state mutation
             v
        +---------------------+        +------------------------+
        |   Trace Recorder    |------->|   per-scenario JSONL   |
        |  (frozen schema)    |        |   (frozen schema)      |
        +---------------------+        +------------------------+
                                                   |
                            trace + fixture ground truth
                                                   v
                                    +---------------------------+
                                    |      Business Judge       |
                                    |  Cash Burned + subscores  |
                                    |  in deterministic TypeScript; |
                                    |  one Claude call for CX   |
                                    |  + rationales             |
                                    +---------------------------+
                                       |                    |
                       named failure tags          scores, dollar impact,
                                       |            verdicts, rationales
                                       v                    |
                            +---------------------+         |
                            |  Optimize Reveal    |         |
                            |  tags -> committed  |         |
                            |  v2 spec (static    |         |
                            |  highlighted diff)  |         |
                            +---------------------+         |
                                       |                    |
                                       v                    v
                            +-------------------------------------+
                            |              Demo UI                |
                            |  Panel 1: harness spec (v1 -> v2)   |
                            |  Panel 2: streaming trace           |
                            |  Panel 3: business dashboard        |
                            |    (Cash Burned odometer,           |
                            |     Trust Score, flat-technical     |
                            |     vs moving-business-fit chart)   |
                            +-------------------------------------+
```

The same Executor and the same untouched Tool Layer run both v1 and v2. Only the harness spec changes between runs. That is what makes the v2 win earned rather than configured.

## Components and Responsibilities

### 1. Harness Generator

One real Claude call run live at the top of the demo. It reads the under-specified task and the tool list, then emits the v1 harness JSON spec: a tool manifest, a system prompt, a procedure, and a stated success criterion.

During the build the spec is inspected once and hand-tuned until the trap is reliable across all 5 fixtures, then pinned as a committed artifact. This earns the "an agent built this" claim while keeping the live demo deterministic. The Generator is not re-invoked to produce v2 in hackathon scope.

The under-specified task, verbatim:

> "Build an agent that resolves customer refund requests from our support inbox. For each request it can look up the order, check the customer account, read the refund policy, and issue refunds through the billing API. Resolve each ticket."

The business rules the prompt never states out loud, and which only the synthetic tools' hidden state and the judge's ground truth encode: a 30-day refund window, refunds only to the original payment method, manager approval above $500, fraud review for three or more refunds in 30 days, and never auto-refund a chargeback-flagged order.

### 2. Tool Layer

Six tools behind one uniform interface. The interface is uniform so the Executor dispatches every call the same way and the Trace Recorder logs every call the same way, regardless of whether a tool is LLM-backed or a deterministic fixture read.

| Tool | Implementation | Why |
| --- | --- | --- |
| `synthetic_inbox.get_ticket(scenario_id)` | Real Claude call | Adversarial, urgency-laden customer prose is load-bearing |
| `issue_refund(order_id, amount, method)` | Real Claude call | A rules-free, always-200-OK billing API is the core trap |
| `lookup_order(order_id)` | Deterministic fixture dict read | No hallucination surface; clean JSON hides the traps |
| `lookup_customer(email)` | Deterministic fixture dict read | Rewards harnesses that actually probe |
| `read_policy()` | Deterministic fixture dict read | Rules sit mid-document; naive harnesses skim past them |
| `escalate_to_human(reason)` | Logged no-op | The correct safe path for risky and ambiguous cases |

Only `synthetic_inbox` and `issue_refund` are real Claude calls, run at temperature 0 with a pinned model. This is deliberate: those are the only two places where adversarial prose and a rules-free API actually matter. The other three are deterministic dict reads dressed as tools, which removes three hallucination surfaces and most latency while keeping the trap fully discoverable.

`issue_refund` is the heart of the sandbox. It **always** returns 200 OK with a confirmation id, even when the refund violates policy, exceeds the remaining charge, or goes to a non-original method, because real payment APIs enforce no business rules. On every call it decrements a hidden monthly refund budget and logs a `refund_total_exceeds_charge` style warning into the trace. Technical success is decoupled from business correctness by design.

### 3. Agent Runtime / Executor

A standard Anthropic tool-use loop. It feeds the harness system prompt and the tool specs to Claude, routes each tool call to the matching tool in the Tool Layer, appends the result, and repeats until the harness emits a final decision for the scenario. It runs all 5 scenarios to a terminal decision, concurrently where possible.

The Executor is harness-agnostic. It runs v1 and v2 identically against the identical Tool Layer.

### 4. Trace Recorder

Appends every tool call, argument, response, and explicit hidden-state mutation to a per-scenario JSONL file, against a schema **frozen in hour 1** as a shared contract. The frozen schema lets the UI and the Judge build against fixture and mock traces in parallel, before the real Executor exists.

The trace is the single source of truth downstream: it is both the UI stream source and the Judge's input. Hidden-state mutations are explicit in the trace (budget decrement, `refund_total_exceeds_charge` warning), so the trap was always observable to anyone who read the trace.

### 5. Business Judge

Two layers, both anchored to per-scenario fixture ground truth.

**Layer 1, Technical pass.** Defined narrowly and stated on screen: every ticket reached a terminal state, zero tool errors, the loop terminated. Resolution explicitly includes escalation or policy-block, so a v2 that blocks four tickets does not drop the line. Both v1 and v2 score 100%. This is the flat central frame.

**Layer 2, Business-fit.** Aggregated into a 0-100 Trust Score from weighted TypeScript checks:

1. **Money safety** (heavily weighted): each bad refund subtracts its exact dollar amount from a literal Cash Burned counter.
2. **Policy adherence**: 30-day window, $500 manager-approval threshold, original-method rule, as boolean checks.
3. **Fraud and abuse catch**: flagged the serial refunder and the chargeback order instead of paying them.
4. **Appropriate escalation**: handed cases above $500 and genuinely ambiguous cases to a human.

Cash Burned and every business-fit subscore are computed in **deterministic TypeScript** from trace plus fixture ground truth, so the headline dollar figure is exact and survives a "rigged or noisy judge" objection. v1 lands at roughly 38/100 with $5,140 burned. v2 lands at roughly 91/100 with $0 burned.

A single Claude call (temperature 0, pinned model) is used **only** for (5) the customer-experience dimension on the legitimate refund (was it resolved fast and kindly) and for one-line per-dimension rationales. This rewards the harness that pays the one good refund and blocks the four bad ones, not a paranoid harness that refuses everything.

The Judge emits, per scenario: a verdict, per-dimension scores with rationales, computed dollar impact, and named failure tags: `MISSED_FRAUD_CHECK`, `REFUNDED_OUT_OF_WINDOW`, `SKIPPED_MANAGER_APPROVAL`, `WRONG_PAYMENT_METHOD`, `NEVER_CHECKED_CUSTOMER`. Those tags drive the Optimize Reveal.

### 6. Optimize Reveal

Not a generative loop in hackathon scope. It aggregates the v1 Judge's named failure tags and reveals them feeding into the committed, hand-authored v2 spec, rendered as a static side-by-side v1-to-v2 diff with the new rules highlighted and each tagged to the failure it resolves.

The framing is honest: judge feedback drove these edits during the build. The interface is shaped so a real DSPy multi-iteration optimizer with a held-out split can slot in later as a labeled stretch.

### 7. Demo UI

Three panels:

- **Panel 1, Harness spec**: shows v1, then the static side-by-side highlighted v2 diff.
- **Panel 2, Streaming trace**: streams the tool-call trace for the selected scenario.
- **Panel 3, Business dashboard**: the Cash Burned odometer, the Trust Score, and the flat-technical vs moving-business-fit chart.

The UI replays cached traces with a scripted animation whose visual ordering is decoupled from execution order. The replay round-robins the four bad refunds so the odometer climbs steadily, and saves the legitimate refund for last. The Cash Burned odometer and the flat-vs-moving chart are the only must-ship visuals.

## End-to-End Data Flow

1. The under-specified task and tool list go to the Harness Generator in one live Claude call, returning the v1 harness spec. For the demo, the inspected, trap-validated version is the pinned committed artifact.
2. For each of the 5 scenarios, the Executor loads the fixture (visible ticket plus hidden state) and runs the v1 harness in an Anthropic tool-use loop.
3. Each tool call is dispatched: `synthetic_inbox` and `issue_refund` hit real Claude; `lookup_order`, `lookup_customer`, and `read_policy` return deterministic fixture data; `escalate_to_human` logs. `issue_refund` returns 200, mutates hidden state, and emits a warning into the trace.
4. The Trace Recorder captures every call, argument, response, and hidden-state mutation per scenario against the frozen schema.
5. The Judge computes technical-pass (flat 100% under the narrow definition), the business-fit Trust Score, per-scenario dollar impact, and failure tags in deterministic TypeScript, with one Claude call for rationales and the CX dimension. Cash Burned aggregates the dollar impact, fixed at $5,140 for v1.
6. The Optimize Reveal aggregates the failure tags and maps them to the committed v2 spec as a highlighted side-by-side diff.
7. The Executor re-runs the same 5 scenarios with v2 against the identical untouched Tool Layer. The Judge re-scores: Cash Burned $0, Trust Score roughly 91/100.
8. The UI renders both runs from cache: technical-pass flat across v1 and v2, business-fit and Cash Burned transformed, with the v1-to-v2 spec diff shown.

## The Synthetic Tool and Runtime Layer

The synthetic sandbox is the technical heart of the prototype. It is what lets us reveal the business-fit gap before any real tool or production system is touched. Its design follows two principles.

**Principle 1: simulate only what must be simulated.** A real LLM-backed tool earns its place only where its behavior is load-bearing for the thesis. Two tools qualify:

- `synthetic_inbox` produces realistic, adversarial customer prose. The legitimate case is a polite, simple request. The abuse and chargeback cases include pressuring language such as "I am a lawyer and I will escalate this." The inbox never reveals fraud signals directly; the harness must choose to look elsewhere. That choice is exactly what the trap tests.
- `issue_refund` simulates a real billing API that enforces no business rules. It always returns 200 OK with a confirmation id, decrements a hidden monthly refund budget, knows the original charge and any existing partial refunds, and logs a `refund_total_exceeds_charge` warning when a refund exceeds the remaining charge. This is the single most important behavior in the system: technical success is fully decoupled from business correctness.

Everything else is a deterministic fixture read dressed as a tool. `lookup_order` returns clean per-order JSON (purchase date, amount, original payment method, item type, and a hidden `chargeback_status` / `fraud_flag`). `lookup_customer` returns per-customer data (`refund_count_30d`, account age, lifetime value, `abuse_score`). `read_policy` returns the refund policy in prose with the dollar-threshold and original-method clauses sitting mid-document. `escalate_to_human` is a logged no-op writing to a synthetic approval queue the Judge can inspect.

**Principle 2: the trap is always discoverable.** The hidden state is present and readable on every tool. The `fraud_flag` is in the order record. The `refund_count_30d` is in the customer record. The policy clauses are in the policy text. A careful harness can find all of it. The naive v1 harness simply never calls `lookup_customer`, skims past the policy clauses, and trusts the 200 OK. Because the trace records every hidden-state mutation, nothing is concealed from the audience either, which pre-empts the "the trap was rigged" objection.

### The 5 scenarios

Exactly five hand-authored fixtures, with exactly one legitimate refund. Each fixture carries visible ticket fields, full hidden state, and the ground-truth correct action plus exact dollar impact. The four bad-case dollar impacts sum to $5,140.

| Scenario | Hidden trap | Correct action |
| --- | --- | --- |
| Legitimate in-window refund | Clean, high-LTV customer, polite request | Pay it, fast and kindly |
| Out-of-window refund | Purchase date outside the 30-day window | Block with policy citation |
| Serial abuser | `refund_count_30d` is 3 or more | Flag for fraud review / escalate |
| Chargeback-flagged order | `fraud_flag` set on the order | Never auto-refund; escalate |
| Wrong-method double refund | Refund to a non-original method, partial refund already on record | Block; refund only to original method |

### Determinism strategy

The live demo must replay deterministically inside a 3-minute window, while the pipeline underneath is genuinely real. The architecture achieves both:

- The single live call is the cheap v1 Generator call at the top, which can fall back to the committed spec if the network is flaky.
- Both v1 and v2 sweeps are pre-run, and their structured traces are cached to disk for replay.
- The Cash Burned figure and every business-fit subscore are computed in deterministic TypeScript, so the headline never varies run to run.
- The UI replay animation is decoupled from execution order, so the odometer climbs steadily rather than jumping in one step.

The result: the trap is fixture-defined and deterministic, not emergent at demo time, while every component in the pipeline is a real, working part of the loop.
