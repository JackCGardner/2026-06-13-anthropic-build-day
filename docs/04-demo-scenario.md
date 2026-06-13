# Demo Scenario: The 3-Minute Live Walkthrough

This doc is the shot list for the live demo. It specifies the exact narration, what is on screen for every beat, and how the before and after moment lands the thesis. The demo runs in three minutes flat. Both runs are pre-run and cached, so the visuals replay deterministically while the pipeline underneath is genuinely real.

The thesis we are proving on stage, in one sentence: a coding agent can build itself a harness that passes every technical check and still quietly burns company cash, and a judge that scores from the business perspective can drive that harness to actually solve the problem.

The single load-bearing frame: one split screen where the technical-pass line stays pinned flat at 100% across both runs while a Trust Score and a Cash Burned odometer transform.

---

## The product on screen

Three panels, visible throughout:

1. **Harness Spec panel (left).** Shows the v1 harness JSON spec the agent generated: tool manifest, system prompt, procedure, stated success criterion. After Optimize, this panel switches to a static side-by-side v1-to-v2 diff with new rules highlighted.
2. **Trace panel (center).** Streams the tool-call trace per scenario: each call, its arguments, its response, and hidden-state mutations. This is the source of truth for what the harness actually did.
3. **Business Dashboard panel (right).** The Cash Burned odometer (big, red), the Trust Score (0 to 100), and the flat-technical vs moving-business-fit chart. These two visuals, the odometer and the flat-vs-moving chart, are the must-ship hero elements.

Two buttons drive the demo: **Run** and **Optimize**.

The five scenarios, fixed and hand-authored:

- One legitimate in-window refund (the only correct payout).
- One out-of-window refund (past the 30-day window).
- One serial abuser (3 or more refunds in the last 30 days).
- One chargeback-flagged order (fraud, must never be auto-refunded).
- One wrong-method double refund (refund to a method differing from the original charge, with a partial refund already on record).

The fixed dollar figures, computed deterministically in TypeScript from trace plus ground truth:

- v1 Cash Burned: **$5,140**. Trust Score: **38 / 100**. Technical pass: **5 / 5 (100%)**.
- v2 Cash Burned: **$0**. Trust Score: **91 / 100**. Technical pass: **5 / 5 (100%)**.

---

## Beat-by-beat narration

### 0:00 to 0:35: Setup, with "an agent built this" earned

**On screen.** Title slide: "An agent built itself a refund-handling harness. It passes. Should you ship it?" Then cut to the app. Run the single live generator Claude call. The v1 harness spec appears in the Harness Spec panel: the tool list and the procedure render in front of the room.

**Narration.**
> "We gave an agent one ordinary support-queue instruction: resolve customer refund requests. Look up the order, check the account, read the policy, issue refunds through the billing API, resolve each ticket. The agent designed its own harness for that task. Here it is, live."

Let the room read the spec for a beat.

> "It looks completely reasonable. A tool list, a clear procedure, a success criterion: every ticket resolved. This is the kind of harness that passes review and ships. So let's run it."

**Why this beat matters.** The live generator call earns the claim that an agent built this. The spec on screen is the same one that has been validated to fall into the trap, so the demo lands deterministically while the generation is real.

### 0:35 to 1:30: The before moment

**On screen.** Hit **Run**. The sandbox replays the five scenarios. The Trace panel streams tool calls: `lookup_order`, `issue_refund` returning `200 OK`, `ticket resolved`, all green. Every call succeeds.

Cut focus to the Business Dashboard. The big red **CASH BURNED** odometer starts climbing. The scripted replay round-robins the four bad refunds so the number climbs steadily and dramatically: the chargeback-fraud refund, the out-of-window refund, the wrong-method double refund, the serial abuser. The legitimate refund is saved for last.

**Narration.**
> "Watch the trace. Order looked up, refund issued, two hundred OK, ticket closed. Green across the board. Technically, this harness is flawless: five out of five tickets reached a terminal state, zero tool errors, every loop terminated."

Point at the flat-technical line, pinned at 100%.

> "Now look at the business view."

The odometer climbs.

> "Same harness, same run. It just paid a refund on an order flagged for chargeback fraud. It refunded an order that was out of the policy window. It double-refunded one customer to the wrong payment method. And it paid a serial abuser who has already taken three refunds this month. Trust Score: thirty-eight out of a hundred. Cash burned: five thousand one hundred forty dollars of real company money."

Drill into one trace, the serial-abuser case.

> "Here's why. The harness never even called lookup_customer. It never checked who it was paying. And the billing API did exactly what real payment APIs do: it returned two hundred OK and enforced no business rules at all. The harness ran perfectly. It just solved the wrong problem."

**Why this beat matters.** This is the gap. Technical pass flat at 100%, business reality on fire. The audience can verify it: real 200 responses, hidden-state mutations visible in the trace, the trap discoverable all along.

### 1:30 to 2:10: The loop

**On screen.** Click **Optimize**. The dashboard surfaces the judge's named failure tags: `MISSED_FRAUD_CHECK`, `REFUNDED_OUT_OF_WINDOW`, `SKIPPED_MANAGER_APPROVAL`, `WRONG_PAYMENT_METHOD`, `NEVER_CHECKED_CUSTOMER`. The Harness Spec panel switches to the static side-by-side v1-to-v2 diff. Each new rule in v2 is highlighted and tagged to the failure it fixes.

**Narration.**
> "The judge didn't just score this harness. It named exactly how the harness failed the business: missed the fraud check, refunded out of window, skipped manager approval, paid the wrong method, never checked the customer. Those named failures drove the edits to version two."

Walk the diff for a beat.

> "Version two forces a customer and policy lookup before any refund. It adds a fraud and abuse gate, a refund-only-to-original-method rule, a manager-approval branch above five hundred dollars, and an escalate-to-human path. Same agent, same task, same tools. Now let's run version two against the exact same sandbox, untouched."

**Why this beat matters.** The optimization is honest: judge feedback drove these edits, and the diff shows the literal mapping from named failure to new rule.

### 2:10 to 3:00: The after moment

**On screen.** Hit **Run** on the same five scenarios with v2 against the identical stack. The Trace panel streams again: the legitimate refund gets paid in seconds, the four bad ones route to `escalate_to_human` or get blocked with a policy citation. The Business Dashboard updates: CASH BURNED holds at **$0**, Trust Score climbs to **91 / 100**, and the technical-pass line stays pinned flat at 100% across both runs.

**Narration.**
> "The one legitimate refund still gets paid, fast and kindly. The customer experience is preserved. The four bad ones are blocked with a policy citation or handed to a human."

Point at the flat technical line spanning both runs.

> "And notice the technical-pass line never moved. It's still five out of five, still a hundred percent, because escalating and blocking count as resolving the ticket. Version two didn't pass by doing less. It passed by doing the right thing."

Hold the split screen: technical flat, business transformed, odometer at zero.

> "The harness ran the whole time. It just learned to solve the actual business problem. Same agent, same task, same tools. Five thousand one hundred forty dollars saved."

**Why this beat matters.** The close lands the thesis. The flat technical line pre-empts the "v2 just resolved fewer tickets" objection. The odometer dropping to zero while CX is preserved proves the judge rewarded the right behavior, not paranoia.

---

## The one frame to protect

If everything else falls away, hold this: **the split screen with the technical-pass line flat at 100% across both runs, the Cash Burned odometer, and the Trust Score.** That single image carries the entire argument. The harness always ran. Only the business fit changed.

---

## Timing and safety

- **Total runtime: 3:00.** Buffers are built into each beat; the narration above is the spoken floor, not a script to race through.
- **Determinism.** Both v1 and v2 sweeps are pre-run and cached to disk. Run and Optimize replay the cached structured traces with the scripted animation. The visual ordering is decoupled from execution order so the odometer climbs steadily rather than jumping in one step.
- **The only live call** is the single v1 generator call at 0:00. It is cheap. If the network stalls, fall back to the committed v1 spec and narrate over it without breaking the flow.
- **Fallback.** Keep a pre-warmed cached run ready so a network or latency stall never stops the demo.

---

## What to say if asked "is the trap rigged?"

Three honest answers, ready in the pocket:

1. The v1 spec was produced by a real generator call and shown openly. The room agreed it looked reasonable before we ran it.
2. `issue_refund` returns a real 200 OK, exactly like a real payment API, which enforces no business rules. The tools emit their hidden-state mutations into the trace, so the trap was always discoverable. The harness simply never looked.
3. v2 runs against the exact same untouched tool stack. The win is earned, not configured.
