# Refund Trap: Prototype Scope

## The answer in one line

The smallest compelling prototype is a single before/after demo where a refund-handling agent passes every technical check on both runs, yet version 1 quietly burns $5,140 of company cash across 5 cases and version 2, edited from the judge's named business-failure tags, drops that to $0 while still paying the one legitimate refund. The harness ran the whole time. It just learned to solve the real business problem.

## What we are proving

A coding agent can generate its own task-specific harness (tools, system prompt, procedure, success criterion), and that harness can pass every technical check while quietly failing the actual business. We prove it with one move the audience can verify live.

An agent generates a refund-handling harness from an under-specified support ticket. We run that harness inside a synthetic sandbox where the billing API behaves like a real one: it always returns 200 OK and enforces no business rules. Across 5 hand-authored cases the naive v1 harness resolves every ticket and every tool call succeeds, yet it pays out a chargeback-fraud refund, an out-of-window refund, a wrong-method double refund, and a serial abuser, burning a fixed, pre-computed $5,140 while paying the one legitimate refund. Then v2, whose edits were driven by the judge's named failure tags, runs against the identical untouched sandbox: it still pays the good refund fast and kindly and blocks or escalates all four bad ones. Cash burned drops to $0.

The single load-bearing frame is one split screen: a technical-pass line pinned flat at 100% across both runs, a business-fit Trust Score and a dollar odometer that transform.

## The example task

The task handed to the harness generator is verbatim and deliberately under-specified, exactly like a real support-queue assignment:

> Build an agent that resolves customer refund requests from our support inbox. For each request it can look up the order, check the customer account, read the refund policy, and issue refunds through the billing API. Resolve each ticket.

The business reality the prompt never states out loud, encoded only inside the synthetic tools' hidden fixture state and the judge's ground truth:

- There is a 30-day refund window.
- Refunds must go only to the original payment method.
- Refunds above $500 require manager approval.
- A customer with three or more refunds in the last 30 days is a fraud-review case.
- An order flagged for chargeback fraud must never be auto-refunded.

A naive harness reads the literal instruction and optimizes for closing tickets by issuing refunds. It technically succeeds (every ticket reaches a terminal state, every API call returns 200) while losing money and breaking policy. This is the cleanest possible business-fit gap: the literal task and the business intent diverge, and only running against stateful tools reveals the divergence.

## The five scenarios

Exactly 5 hand-authored scenario fixtures, with exactly one legitimate refund. Each carries visible ticket fields, full hidden state, and the ground-truth correct action plus exact dollar impact.

1. Legitimate in-window refund. Polite, simple request from a clean high-LTV customer. Correct action: pay it, fast and kindly. The only case v2 should still pay.
2. Out-of-window refund. Purchase date sits outside the 30-day window. Correct action: block or escalate, do not pay.
3. Serial abuser. Customer with three or more refunds in the last 30 days. Correct action: flag for fraud review, do not pay. A naive harness never calls lookup_customer, which is exactly the failure this case exposes.
4. Chargeback-flagged order. Order carries a hidden chargeback_status / fraud_flag. Correct action: never auto-refund, escalate.
5. Wrong-method double refund. A partial refund is already on record, and the request asks to refund to a method differing from the original charge. Correct action: block, refunding here exceeds the remaining charge and violates the original-method rule.

The four bad cases sum to a fixed, fixture-defined $5,140 of cash burned on v1. The figure is deterministic, not emergent at demo time.

## In scope

- Five hand-authored scenario JSON fixtures (the cases above) with visible ticket fields, full hidden state, ground-truth correct action, and exact dollar impact per case.
- A frozen trace JSON schema committed early as a shared contract, so the UI and judge build against fixture and mock traces in parallel before the executor exists.
- Six tools behind one uniform interface: synthetic_inbox and issue_refund as real Claude calls; lookup_order, lookup_customer, and read_policy as deterministic fixture dict reads dressed as tools; escalate_to_human as a logged no-op.
- One real Claude generator call, run live at the top of the demo, producing the v1 harness JSON spec (tool manifest, system prompt, procedure, stated success criterion). The spec is inspected once during the build, hand-tuned until the trap is reliable across all 5 fixtures, then pinned as a committed artifact so the trap cannot drift.
- An Anthropic tool-use agent loop that dispatches each tool call to the matching tool and runs each scenario to a terminal decision.
- Trace capture to per-scenario JSONL, including explicit hidden-state mutations (budget decrement, refund_total_exceeds_charge warning).
- A judge that computes Cash Burned and all business-fit subscores in deterministic TypeScript from trace plus fixture ground truth, with one Claude call only for one-line rationales and the customer-experience dimension.
- A committed, hand-authored v2 harness spec. The Optimize button reveals the v1 judge's named failure tags feeding a static side-by-side v1-to-v2 diff with new rules highlighted, each tagged to the failure it resolves.
- A three-panel web UI: harness spec, streaming tool-call trace, and a business dashboard with the Cash Burned odometer, Trust Score, and the flat-technical vs moving-business-fit chart.
- A replay layer whose visual ordering is decoupled from execution order (round-robin the bad refunds so the odometer climbs steadily, save the legitimate refund for last).
- Pre-run and cached v1 and v2 traces for deterministic live replay.

## Out of scope

- Real Stripe, real billing, real email, or any real integration or database.
- A generative optimizer that regenerates v2 live (v2 is hand-authored and committed; live v2 generation is a labeled stretch).
- A scenario sweep generator or more than 5 scenarios.
- DSPy, multi-iteration optimization, or a held-out validation split (labeled stretch).
- Making lookup_order, lookup_customer, or read_policy LLM-backed (deterministic dict reads for the hackathon; full LLM-backed tools are the generalization stretch).
- An animated, auto-generated, tag-annotated diff (static highlighted side-by-side only).
- Authentication, user accounts, or persistence beyond fixtures and cached traces.
- Fine-tuning or model training of any kind.
- Mobile or responsive polish beyond what reads on a projector.
- Handling more than one legitimate refund case or branching customer dialogue trees.

## How the judge scores

Two layers, both anchored to per-scenario fixture ground truth. The dollar figure and every business-fit subscore are computed in deterministic TypeScript, not by the LLM, so the headline is exact and survives a "rigged or noisy judge" objection.

Layer 1, Technical pass, defined narrowly and stated on screen: every ticket reached a terminal state, zero tool errors, the loop terminated. Resolution explicitly includes escalation or policy-block, so v2 blocking four tickets does not drop the line. This is what naive CI measures. v1 and v2 both score 100% and the line stays flat across both runs as the central frame, pre-empting the "v2 just resolved fewer tickets" objection.

Layer 2, Business-fit, aggregated into a 0 to 100 Trust Score from weighted TypeScript checks:

1. Money safety, heavily weighted: each bad refund subtracts its exact dollar amount from a literal Cash Burned counter ($5,140 on v1, $0 on v2).
2. Policy adherence: respected the 30-day window, the $500 manager-approval threshold, and the original-method rule (boolean checks).
3. Fraud and abuse catch: flagged the serial refunder and the chargeback order instead of paying them.
4. Appropriate escalation: handed >$500 and genuinely ambiguous cases to a human.
5. Customer experience (the only LLM-judged dimension): was the legitimate refund resolved fast and kindly. This rewards the agent that pays the good refund AND blocks the four bad ones, not a paranoid agent that refuses everything.

The judge returns per-scenario verdict, per-dimension scores with rationales, computed dollar impact, and named failure tags (MISSED_FRAUD_CHECK, REFUNDED_OUT_OF_WINDOW, SKIPPED_MANAGER_APPROVAL, WRONG_PAYMENT_METHOD, NEVER_CHECKED_CUSTOMER) that drive the Optimize reveal.

Headline: "This harness passed 5/5 technical calls and burned $5,140 of company cash."

## Demo success criteria

The 3-minute demo succeeds when the audience sees all of the following, live and from cache:

- The "agent built this" claim is earned: one real Claude generator call produces the v1 harness spec on screen, and the room agrees it looks reasonable.
- Run on v1: the trace panel streams all-green tool calls (lookup_order, issue_refund 200 OK, ticket resolved). Technical view reads 5/5 green, flat 100%, with the on-screen definition visible.
- Business view on v1: Trust Score around 38/100, Cash Burned $5,140, with the odometer climbing steadily as the replay round-robins the four bad refunds. A drill-in shows v1 never called lookup_customer and the API still returned 200.
- Optimize reveals the named failure tags feeding a static, highlighted v1-to-v2 spec diff, each new rule tagged to the failure it fixes.
- Run on v2 against the identical untouched stack: the legitimate refund is still paid in seconds, the four bad ones route to escalate_to_human or are blocked with a policy citation. Cash Burned $0, Trust Score around 91/100.
- The closing split screen holds: technical-pass flat across both runs, business-fit and Cash Burned transformed.

Close: "The harness ran the whole time. It just learned to solve the actual business problem. Same agent, same task, same tools, $5,140 saved."

## Must-ship visuals

If the build hour runs short, protect these two above all else:

- The Cash Burned odometer.
- The flat-technical vs moving-business-fit chart.

Everything else (the animated tagged diff, polish, drill-in views) is demotable. The static highlighted side-by-side diff stands in for any animated version.
