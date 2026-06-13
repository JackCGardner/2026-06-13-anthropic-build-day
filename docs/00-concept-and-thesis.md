# Concept and Thesis: Refund Trap

Welcome to the project. This doc gives you the core idea in one read. Start here, then move to the detailed component and build docs.

## The one-line thesis

A harness that runs is not the same as a harness that solves the real business problem.

A coding agent can now generate its own task-specific harness, meaning the tools, the system prompt, the procedure, and the success criterion. That harness can pass every technical check while quietly losing money and breaking policy. We prove it with one move the audience can verify live.

## The product in one paragraph

We call it Refund Trap. An agent reads an under-specified support ticket and generates a refund-handling harness. We run that harness inside a synthetic sandbox where the billing API behaves like a real one: it always returns 200 OK and enforces no business rules. Across 5 hand-authored cases the naive v1 harness resolves every ticket and every tool call succeeds, yet it pays out a chargeback-fraud refund, an out-of-window refund, a wrong-method double refund, and a serial abuser, burning a fixed, pre-computed $5,140 of company cash while paying the one legitimate refund. Then we reveal v2, a harness whose edits were driven by the judge's named business-failure tags. v2 runs against the identical untouched sandbox: it still pays the one good refund fast and kindly, and it blocks or escalates all four bad ones. Cash burned drops to $0. The harness ran the whole time. It just learned to solve the real business problem.

## Why this matters

CI tells you the harness ran. Every ticket reached a terminal state, every API call returned 200, the loop terminated. That is the standard bar, and it is not enough. The literal task and the business intent diverge, and only running against stateful tools reveals the divergence. This is the business-fit gap, and it is invisible to technical checks.

## The example task

The task handed to the harness generator is verbatim and deliberately under-specified, exactly like a real support-queue assignment:

> Build an agent that resolves customer refund requests from our support inbox. For each request it can look up the order, check the customer account, read the refund policy, and issue refunds through the billing API. Resolve each ticket.

The business reality the prompt never states out loud is encoded only inside the synthetic tools' hidden fixture state and the judge's ground truth:

- There is a 30-day refund window.
- Refunds must go only to the original payment method.
- Refunds above $500 require manager approval.
- A customer with three or more refunds in the last 30 days is a fraud-review case.
- An order flagged for chargeback fraud must never be auto-refunded.

A naive harness reads the literal instruction and optimizes for closing tickets by issuing refunds. It technically succeeds while losing money and breaking policy. This is the cleanest possible business-fit gap.

## The synthetic-sandbox idea

The key insight: we evaluate and optimize an agent-generated harness from a business perspective before it touches real tools or production systems. We do this by running it inside a synthetic sandbox where tool use is simulated by stateful environments.

In this prototype, six tools sit behind one uniform interface:

- `synthetic_inbox` and `issue_refund` are real Claude calls. This is the only place adversarial customer prose and a rules-free 200-OK API are load-bearing.
- `lookup_order`, `lookup_customer`, and `read_policy` are deterministic dict reads from fixture JSON, dressed as tools.
- `escalate_to_human` is a logged no-op.

The billing API is the heart of the trap. `issue_refund` always returns 200 OK with a confirmation id, even when the refund violates policy, exceeds the remaining charge, or goes to a non-original method, because real payment APIs enforce no business rules. It decrements a hidden budget and logs a warning into the trace. Technical success is decoupled from business correctness.

## The core loop

1. Generate the harness. One live Claude call emits the v1 harness spec at the top of the demo, so "an agent built this" is earned. The inspected, trap-validated version is pinned as a committed artifact so the trap cannot drift.
2. Build the synthetic sandbox. Stateful, LLM-backed where it matters, deterministic where it does not.
3. Run scenario sweeps. The agent runtime executes all 5 scenarios to a terminal decision, capturing every call to a per-scenario trace.
4. Judge from the right perspective. A deterministic TypeScript judge computes Cash Burned and every business-fit subscore from trace plus ground truth, using one Claude call only for rationales and the customer-experience dimension.
5. Optimize the harness. The judge's named failure tags drove the v1-to-v2 edits.

## The single load-bearing frame

One split screen. A technical-pass line pinned flat at 100% across both runs. A business-fit Trust Score and a dollar odometer that transform.

- Technical pass, defined narrowly and shown on screen: every ticket reached a terminal state, zero tool errors, the loop terminated. Resolution explicitly includes escalation or policy-block, so v2 blocking four tickets does not drop the line.
- Business-fit Trust Score, 0 to 100, from weighted TypeScript checks on money safety, policy adherence, fraud catch, and appropriate escalation. v1 lands around 38. v2 lands around 91.
- Cash Burned odometer: $5,140 on v1, $0 on v2.

## The closing line

The harness ran the whole time. It just learned to solve the actual business problem. Same agent, same task, same tools, $5,140 saved.

## What we are deliberately not building

To keep scope honest for one build day:

- No real Stripe, billing, email, database, or any production integration.
- No live generative optimizer. v2 is hand-authored or generated once offline and committed. The Optimize button reveals the real judge-feedback-to-diff mapping. Live v2 generation is a labeled stretch.
- No scenario sweep generator and no more than 5 scenarios.
- No DSPy, multi-iteration optimization, or held-out validation split. These are labeled stretches.
- `lookup_order`, `lookup_customer`, and `read_policy` stay deterministic dict reads. Full LLM-backed tools are the generalization stretch.

## How to read the rest of the docs

The trace JSON schema is frozen in hour 1 as a shared contract so the UI and judge can build in parallel against fixture and mock traces before the executor exists. The 5 scenario fixtures, the tool layer, the judge rubric, and the demo flow each have their own doc. The headline to keep in mind throughout: this harness passed 5/5 technical calls and burned $5,140 of company cash.
