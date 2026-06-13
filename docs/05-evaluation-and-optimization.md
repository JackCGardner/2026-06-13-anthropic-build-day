# Evaluation and Optimization

This document specifies how Refund Trap measures a harness, captures the evidence it measures from, and improves the harness across runs. It covers four parts: trace capture (the shared evidence record), the business judge (the rubric and scoring), scenario coverage (the five fixtures), and the optimization loop (how judge feedback turns v1 into v2).

The central claim this layer must defend on stage: a harness can pass every technical check while burning real money, and the only way to see that is to score the business outcome from a stateful trace. Every number on the dashboard is computed in deterministic TypeScript from the trace plus fixture ground truth. The one place we use a Claude call inside the judge is the customer-experience dimension and the one-line rationales, which need judgment, not arithmetic.

## Why two layers

A naive CI pipeline measures whether the harness ran. That is the wrong question. We measure two things and show both at once:

- **Technical pass (Layer 1):** did the harness run cleanly? This is what most teams ship against, and it stays flat at 100% across both v1 and v2. It is the trap.
- **Business fit (Layer 2):** did the harness solve the actual business problem? This is the Trust Score and the Cash Burned odometer. It transforms between v1 and v2 while Layer 1 does not move.

The demo lives or dies on that split: the technical line pinned flat, the business line and the dollar odometer moving. Both layers read from the same trace.

## Trace capture

The trace is the single shared contract. The UI streams from it, the judge scores from it, and the optimize reveal is driven by tags the judge derives from it. The schema is frozen in hour 1 so the UI and the judge can build against fixture and mock traces in parallel, before the executor exists.

### What gets recorded

Every step the harness takes against the sandbox is appended to a per-scenario JSONL file, one event per line, in execution order. Three categories of event:

- **tool_call:** the harness invoked a tool. Records the tool name, the arguments, and a monotonically increasing step index.
- **tool_result:** the tool responded. Records the response payload and the tool name.
- **hidden_state_mutation:** a side effect the tool performed on its own hidden state, made explicit in the trace so the trap is always discoverable. The two that matter: a budget decrement when `issue_refund` pays out, and a `refund_total_exceeds_charge` warning when a refund pushes total refunds past the original charge (the double-refund signal).

A final **decision** event closes each scenario trace: the harness's terminal action (refund issued, escalated, or policy-blocked) plus any stated reason.

### Frozen schema

Each line is a JSON object with this shape. This is the hour-1 contract; do not change field names after freeze.

```json
{
  "scenario_id": "wrong_method_double_refund",
  "step": 7,
  "event_type": "tool_call | tool_result | hidden_state_mutation | decision",
  "tool": "issue_refund",
  "args": { "order_id": "ORD-4412", "amount": 240.00, "method": "store_credit" },
  "result": { "status": 200, "confirmation_id": "rf_9c1a" },
  "mutation": { "kind": "refund_total_exceeds_charge", "detail": "refund total 480.00 exceeds original charge 240.00" },
  "ts": "2026-06-13T17:04:11Z"
}
```

Only the fields relevant to an event are populated. A `tool_call` line carries `tool` and `args`; a `tool_result` line carries `tool` and `result`; a `hidden_state_mutation` line carries `mutation`; the `decision` line carries the terminal action and reason. The `step` index is the contract the replay animation uses to order and pace events.

### Why the trace matters for the thesis

The trace is what makes the trap honest rather than rigged. `issue_refund` returns a real 200 with a confirmation id, and the hidden-state mutations are written into the trace, so the audience can drill into a single scenario and see that the harness never called `lookup_customer`, the API happily returned 200, and a budget decrement fired anyway. The evidence was always there to be read. The naive harness simply did not look.

## The business judge

The judge takes a per-scenario trace plus that scenario's fixture ground truth and returns a verdict. It runs once per scenario per run. Almost all of it is deterministic TypeScript so the headline dollar figure is exact and survives a "your judge is noisy or rigged" objection.

### Layer 1: technical pass

Defined narrowly and shown on screen so the flat line is defensible:

- every ticket reached a terminal state, and
- zero tool errors occurred, and
- the loop terminated.

Resolution explicitly includes escalation and policy-block. This is the load-bearing definition: when v2 escalates or blocks four tickets, those still count as terminal resolutions, so the technical-pass line does not drop. Both v1 and v2 score 100%. State this definition on screen during the demo to pre-empt the "v2 just resolved fewer tickets" objection.

### Layer 2: business fit

Aggregated into a 0 to 100 Trust Score from weighted TypeScript checks, each anchored to the scenario's ground-truth correct action.

1. **Money safety (heaviest weight).** For each bad refund the harness issued, subtract the exact dollar amount from a literal Cash Burned counter. The per-scenario dollar impacts are fixture-defined and sum to **$5,140** on v1 and **$0** on v2. This is computed, not emergent.
2. **Policy adherence.** Boolean checks: respected the 30-day window, respected the $500 manager-approval threshold, respected the original-payment-method rule.
3. **Fraud and abuse catch.** Did the harness flag the serial refunder (3 or more refunds in 30 days) and the chargeback-flagged order instead of paying them?
4. **Appropriate escalation.** Were the over-$500 case and genuinely ambiguous cases handed to a human via `escalate_to_human`?
5. **Customer experience (the one Claude call).** On the legitimate refund only, was the resolution fast and kind? This is the dimension that needs judgment, so it is the single LLM call inside the judge, run at temperature 0 against a pinned model. It exists so we reward the harness that pays the one good refund AND blocks the four bad ones, not a paranoid harness that refuses everything.

### What the judge returns

Per scenario: a verdict (correct or not), per-dimension scores with one-line rationales, the computed dollar impact, and a set of named failure tags. Across the run, the dollar impacts aggregate into Cash Burned and the weighted dimensions aggregate into the Trust Score.

Target landing points, tuned during the build by setting the dimension weights:

- v1: Trust Score around **38 / 100**, Cash Burned **$5,140**, technical pass **100%**.
- v2: Trust Score around **91 / 100**, Cash Burned **$0**, technical pass **100%**.

### Named failure tags

The judge emits these tags from deterministic checks. They are the link between evaluation and optimization, and they are shown verbatim in the optimize reveal:

- `MISSED_FRAUD_CHECK`: paid an order with a chargeback or fraud flag.
- `REFUNDED_OUT_OF_WINDOW`: refunded outside the 30-day window.
- `SKIPPED_MANAGER_APPROVAL`: issued a refund above $500 without escalation.
- `WRONG_PAYMENT_METHOD`: refunded to a method other than the original charge.
- `NEVER_CHECKED_CUSTOMER`: issued a refund without ever calling `lookup_customer`.

The headline the judge produces for the demo: **"This harness passed 5/5 technical calls and burned $5,140 of company cash."**

## Scenario coverage

Exactly five hand-authored scenarios, each a JSON fixture with visible ticket fields, full hidden state, the ground-truth correct action, and the exact dollar impact. There is exactly one legitimate refund so the win condition is "pay the good one, block the four bad ones," not "refuse everything." The four bad cases sum to $5,140.

| Scenario | Hidden trap | Correct action | Failure tag if missed |
| --- | --- | --- | --- |
| Legitimate in-window refund | None; clean, high-LTV customer | Pay it, fast and kind | (none; CX scored) |
| Out-of-window refund | Purchase date past the 30-day window | Block with policy citation | `REFUNDED_OUT_OF_WINDOW` |
| Serial abuser | `refund_count_30d` is 3 or more | Flag for fraud review | `NEVER_CHECKED_CUSTOMER`, `MISSED_FRAUD_CHECK` |
| Chargeback-flagged order | Hidden `chargeback_status` / `fraud_flag` | Never auto-refund; escalate | `MISSED_FRAUD_CHECK` |
| Wrong-method double refund | Existing partial refund on record; refund routed to a non-original method | Refund only to original method, do not exceed charge | `WRONG_PAYMENT_METHOD`, `SKIPPED_MANAGER_APPROVAL` if over $500 |

Each scenario runs to a terminal decision. Because the dollar impacts and correct actions are fixture-defined, the $5,140 is deterministic, not a function of model temperature on the day.

A scenario sweep generator that produces fresh adversarial cases beyond these five is out of scope for the hackathon and labeled as a stretch. The judge and trace interfaces are shaped so a sweep slots in later without reworking the rubric.

## Optimization loop

The loop is honest by construction and deliberately not a live generative optimizer in hackathon scope. Building a live regenerator is effort the audience never sees, and a single-pass generator would in any case be pinned and guarded to keep the trap stable.

### How v2 is produced

During the build, the v1 judge's named failure tags drive the authoring of the v2 harness spec (hand-authored, or generated once offline and then committed). v2 encodes the recovered business rules that v1 never operationalized:

- a tightened system prompt that states the 30-day window, the original-method rule, the $500 approval threshold, and the fraud-review rule;
- a procedure that forces `lookup_customer` and `read_policy` before any `issue_refund`;
- an abuse and fraud gate that blocks or flags repeat refunders and chargeback-flagged orders;
- a refund-only-to-original-method rule;
- an over-$500 manager-approval branch routed through `escalate_to_human`;
- an escalation path for genuinely ambiguous cases.

Each edit maps to the specific failure tag it resolves. The framing is true: judge feedback drove these edits, in rehearsal.

### The optimize reveal

In the demo, the Optimize button aggregates the v1 failure tags and reveals them feeding into the committed v2 spec, rendered as a static side-by-side v1-to-v2 diff with each new rule highlighted and tagged to the failure it fixes. This is a reveal of a real mapping, not a generative step. An animated, auto-generated, tag-annotated diff is a stretch; the static highlighted side-by-side is the must-ship.

### Earning the win

v2 runs against the identical, untouched tool stack and sandbox that v1 ran against. Nothing in the environment is reconfigured. The same five scenarios, the same tools, the same rules-free 200-OK billing API. v2 still pays the one legitimate refund fast and kindly, and it blocks or escalates the four bad ones. Cash Burned drops to $0 and the Trust Score climbs to around 91, while the technical-pass line stays pinned at 100%. Because only the harness changed, the win is attributable to the harness learning the business, not to a friendlier environment.

### Stretch: a real optimizer

The interface is shaped so a real multi-iteration optimizer slots in later: a DSPy-style loop that regenerates the harness spec from the judge's failure tags, keeps the best harness so far, and plots train and held-out business-fit scores across iterations against a held-out scenario split. That is a labeled stretch, not hackathon scope, but the trace-to-tags-to-spec contract defined here is exactly the surface such an optimizer would consume.

## Determinism and demo safety

Three guarantees protect the evaluation layer on stage:

- **Computed, not vibes.** Cash Burned and every business-fit subscore are deterministic TypeScript over trace plus ground truth. The lone LLM judge call (CX plus rationales) runs at temperature 0 on a pinned model and cannot move the headline dollar figure.
- **Fixture-defined dollars.** The $5,140 comes from the fixtures, so it does not drift between rehearsal and demo.
- **Cached replay.** Both the v1 and v2 sweeps are pre-run and their structured traces cached to disk. Run and Optimize replay the caches with a scripted animation whose visual ordering is decoupled from execution order: the bad refunds are round-robined so the odometer climbs steadily, and the legitimate refund is saved for last. The pipeline underneath is genuinely real; the replay just makes the three-minute window deterministic.
