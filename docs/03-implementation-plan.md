# Refund Trap: Implementation Plan

A single hackathon day, ordered into build milestones with rough hours, dependencies, and a suggested split across a small team. The target is one end-to-end loop: an agent-generated refund harness passes every technical check inside a synthetic sandbox while burning $5,140 of company cash, then a tightened v2 harness blocks the bad refunds and drops cash burned to $0, all shown on one split screen.

## Goals for the day

- A live generator call emits the v1 harness spec at the top of the demo, then runs from a pinned committed artifact.
- Five hand-authored scenarios run through a real Anthropic tool-use loop against six synthetic tools.
- A deterministic judge computes Cash Burned and the Trust Score from the trace plus fixture ground truth.
- A three-panel web UI replays cached v1 and v2 traces with a scripted animation.
- The headline lands: technical-pass flat at 100% across both runs, business-fit and the dollar odometer transform.

## Team shape

Plan assumes three people. The work splits into three tracks that share two frozen contracts (the trace schema and the fixtures plus ground truth). Solo or two-person variants are noted where they matter.

- Builder A, Sandbox: fixtures, tools, executor, trace recorder.
- Builder B, Judge and harness: generator call, v1 and v2 specs, deterministic judge, optimize reveal.
- Builder C, UI and demo: three-panel web app, odometer, charts, scripted replay, caching, rehearsal.

## The two frozen contracts

Everything downstream depends on these. They are authored first and do not change after hour 1.

1. Trace JSON schema. Per-scenario JSONL. Each record carries: scenario_id, step index, tool name, arguments, response, and any explicit hidden-state mutation (budget decrement, refund_total_exceeds_charge warning). This is both the UI stream source and the judge input.
2. Fixtures plus ground truth. Five scenario JSON files, each with visible ticket fields, full hidden state, the ground-truth correct action, and the exact dollar impact. The five dollar impacts sum to $5,140.

Freezing these lets the UI and judge build against fixture and mock traces in parallel before the real executor exists.

---

## Milestone 1: Freeze contracts, fixtures, and ground truth

Rough hours: 2. Dependencies: none. This is the gate everything else hangs on.

- Write the trace JSON schema and commit it.
- Author the five scenario fixtures, each with visible ticket fields, full hidden state, the ground-truth correct action, and the exact dollar impact:
  1. Legitimate in-window refund (the one good case, paid).
  2. Out-of-window refund (purchase older than 30 days).
  3. Serial abuser (3+ refunds in the last 30 days).
  4. Chargeback-flagged order (fraud_flag set, must never auto-refund).
  5. Wrong-method double refund (refund to a method differing from the original charge, with a partial refund already on record).
- Confirm the four bad-case dollar impacts sum to exactly $5,140.
- Produce two or three mock traces by hand so UI and judge work can start immediately.

Owner: Builder A leads, Builder B co-authors the ground truth so the judge and fixtures agree. Done when the schema and five fixtures are committed and a mock trace validates against the schema.

---

## Milestone 2: Trap-reliability gate (blocking checkpoint)

Rough hours: 2. Dependencies: Milestone 1. This must pass before any UI polish.

- Write the under-specified task prompt verbatim and pair it with the six-tool list.
- Run the live generator Claude call once and inspect the v1 harness spec (tool manifest, system prompt, procedure, stated success criterion).
- Hand-tune the generator prompt until the v1 spec reliably falls into all four bad cases across all five fixtures: it pays the chargeback-fraud refund, the out-of-window refund, the wrong-method double refund, and the serial abuser, while paying the one legitimate refund.
- Freeze and commit the v1 spec as a pinned artifact so the trap cannot drift between rehearsal and demo.

The $5,140 must be deterministic and fixture-defined, not emergent at demo time. Owner: Builder B. Done when the committed v1 spec produces all four failures reliably across the five fixtures.

---

## Milestone 3: Tool layer, executor, and trace recorder

Rough hours: 3. Dependencies: Milestone 1 (schema and fixtures). Can start in parallel with Milestone 2 using mock specs, then wire in the real v1 spec once it is pinned.

Implement six tools behind one uniform interface:

- synthetic_inbox.get_ticket(scenario_id): real Claude call, returns the customer email and thread, including pressuring prose in the abuse and chargeback cases. Temperature 0, pinned model.
- issue_refund(order_id, amount, method): real Claude call. ALWAYS returns 200 OK with a confirmation id, decrements the hidden monthly_refund_budget, and logs a refund_total_exceeds_charge style warning into the trace. Enforces no business rules. Temperature 0, pinned model.
- lookup_order(order_id): deterministic fixture dict read dressed as a tool.
- lookup_customer(email): deterministic fixture dict read dressed as a tool.
- read_policy(): deterministic fixture read returning the policy prose (30-day window, original-method rule, $500 manager-approval threshold, fraud-review for repeat refunders).
- escalate_to_human(reason): logged no-op writing to a synthetic approval queue the judge can inspect.

Then build the Anthropic tool-use loop: feed the harness system prompt and tool specs to Claude, route each tool call to the matching tool, append results, repeat until the harness emits a final decision. Run all five scenarios, concurrently where possible. The trace recorder appends every call, argument, response, and hidden-state mutation to per-scenario JSONL in the frozen schema.

Owner: Builder A. Done when all five scenarios run v1 to a terminal decision and emit schema-valid traces, with issue_refund returning 200 and logging its warning.

---

## Milestone 4: Deterministic judge and committed v2

Rough hours: 3. Dependencies: Milestone 1 (ground truth) to start; Milestone 3 traces to validate end to end. Judge logic can be built against mock traces before the executor is live.

Two layers, both anchored to fixture ground truth.

- Layer 1, Technical pass, defined narrowly and shown on screen: every ticket reached a terminal state, zero tool errors, the loop terminated. Escalation and policy-block count as resolution, so v2 blocking four tickets does not drop the line. v1 and v2 both score 100%.
- Layer 2, Business-fit, a 0-100 Trust Score from weighted TypeScript checks: money safety (each bad refund subtracts its exact dollar amount from the Cash Burned counter), policy adherence (30-day window, $500 threshold, original-method rule), fraud and abuse catch (serial refunder and chargeback order), appropriate escalation (>$500 and ambiguous cases to a human).

Compute Cash Burned and every business-fit subscore in deterministic TypeScript. Use one Claude call only for the customer-experience dimension on the legitimate refund and for one-line per-dimension rationales, at temperature 0 with a pinned model. Emit per-scenario verdicts, per-dimension scores with rationales, computed dollar impact, and named failure tags: MISSED_FRAUD_CHECK, REFUNDED_OUT_OF_WINDOW, SKIPPED_MANAGER_APPROVAL, WRONG_PAYMENT_METHOD, NEVER_CHECKED_CUSTOMER.

Tune weights so v1 lands near 38/100 with $5,140 burned. Then hand-author (or generate once offline and commit) the v2 spec from the v1 failure tags: a tightened system prompt encoding the recovered rules, a procedure that forces lookup_customer and read_policy before any issue_refund, an abuse and fraud gate, a refund-only-to-original-method rule, a >$500 manager-approval branch, and an escalate_to_human path. Verify v2 lands near 91/100 with $0 burned on the same untouched stack.

Owner: Builder B. Done when v1 scores ~38/100 at $5,140 and the committed v2 scores ~91/100 at $0 against the identical tools.

---

## Milestone 5: Demo UI, three panels and scripted replay

Rough hours: 4. Dependencies: Milestone 1 (schema) to start against mock traces; real traces from Milestones 3 and 4 to finalize. Largest single block, so it starts early against mocks.

Three panels:

- Harness spec: v1 first, then a static side-by-side highlighted v1-to-v2 diff with new rules highlighted and each tagged to the failure it resolves.
- Streaming tool-call trace: replays per-scenario traces step by step.
- Business dashboard: the Cash Burned odometer, the Trust Score, and the flat-technical vs moving-business-fit chart.

Build a replay layer whose visual ordering is decoupled from execution order. The cache stores per-scenario traces; the replay scripts the visual sequence so the odometer climbs steadily (round-robin the four bad refunds, save the legitimate refund for last). The Run and Optimize buttons drive the replay.

Protected must-ship visuals: the Cash Burned odometer and the flat-vs-moving chart. If the UI hour runs short, demote the animated tagged diff to a static highlighted side-by-side and hold the line on the two protected visuals.

Owner: Builder C. Done when both runs render from cache with the odometer climbing on v1 and pinned at $0 on v2, technical-pass flat across both.

---

## Milestone 6: Cache, rehearse, harden

Rough hours: 2. Dependencies: Milestones 3, 4, 5.

- Pre-run the real v1 and v2 sweeps and cache structured traces to disk for deterministic replay.
- Wire Run and Optimize to replay caches with the scripted animation.
- Keep the single live generator call at the top with a fallback to the committed v1 spec for network flakiness.
- Rehearse the full 3-minute flow end to end. Prepare a cached fallback for any latency stall.

Owner: Builder C leads, all three rehearse. Done when the 3-minute demo runs deterministically from cache and the live generator call has a working fallback.

---

## Critical path and parallelism

- Critical path: Milestone 1, then Milestone 2 (trap gate), then Milestone 4 weight tuning and v2, then Milestone 6 caching and rehearsal.
- Parallel from the end of hour 1: Builder C builds the UI against mock traces, Builder B builds judge logic against mock traces, Builder A builds tools and executor. They converge when the real v1 spec is pinned (end of Milestone 2) and again when real traces exist (end of Milestone 3).
- Hard ordering: the trap-reliability gate (Milestone 2) blocks UI polish. The $5,140 must be deterministic before time goes into animation.

## Suggested timeline

| Time | Builder A (Sandbox) | Builder B (Judge / Harness) | Builder C (UI / Demo) |
|------|---------------------|------------------------------|------------------------|
| Hour 1 | Trace schema + fixtures (with B) | Ground truth + dollar impacts (with A) | Scaffold app, read schema |
| Hour 2 | Tool stubs, executor skeleton | Trap gate: generator call, pin v1 | Three-panel layout vs mock traces |
| Hour 3 | Six tools behind one interface | Judge Layer 1 + Layer 2 in TypeScript | Odometer + Trust Score |
| Hour 4 | Executor runs 5 scenarios, traces | Tune v1 to ~38/100, $5,140 | Flat-vs-moving chart |
| Hour 5 | Validate traces against schema | Author + commit v2, verify ~91/100, $0 | Scripted replay, decoupled ordering |
| Hour 6 | Concurrency, edge cleanup | Failure tags into optimize reveal | v1-to-v2 diff panel |
| Hour 7 | Support caching of real sweeps | Verify both runs on same stack | Wire Run + Optimize to caches |
| Hour 8 | Buffer / fallback paths | Rationale + CX Claude call at temp 0 | Rehearse 3-minute flow, harden |

## Definition of done

- The live generator call shows a reasonable-looking v1 spec, with a committed fallback.
- v1: technical-pass 100%, Trust Score ~38/100, Cash Burned $5,140, all four bad refunds paid, the one legitimate refund paid.
- v2 on the identical untouched stack: technical-pass 100%, Trust Score ~91/100, Cash Burned $0, the legitimate refund still paid fast, the four bad ones blocked or escalated.
- The split screen holds: technical-pass flat across both runs, business-fit and the dollar odometer transformed.
- The demo replays deterministically from cache inside 3 minutes.

## Cut list if the day runs short

Drop in this order, protecting the headline frame:

1. Animated tagged diff becomes a static highlighted side-by-side.
2. CX Claude judge call becomes a fixed favorable score on the legitimate case.
3. synthetic_inbox prose served from a cached fixture string instead of a live call.
4. UI trace panel simplified to a clean step list, keeping the odometer and the flat-vs-moving chart untouched.

The Cash Burned odometer and the flat-technical vs moving-business-fit chart are never cut.
