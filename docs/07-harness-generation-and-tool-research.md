# Architecture Brief: The Harness Generator and the Synthetic World

**Status:** Design, end-to-end · **Scope:** the research step (front of the generator) and the synthetic world (the lab the harness runs inside) · **Flagship:** Refund Trap

This brief unifies the research-and-generation pipeline with the synthetic-world runtime into one coherent design. It is the deep specification behind the RFC (`06-rfc.md`, sections 6 and 7) and the substrate behind the M0 architecture (`02-architecture.md`). Where earlier notes forked on a decision, this brief picks one path, says why, and moves on.

The input is a single under-specified sentence. The output is a harness under test, a synthetic world faithful enough to fool it, and a trace that makes the business-fit gap undeniable.

Two honesty rules govern the whole document, because the demo lives or dies on not overclaiming:

1. **Faithfulness makes the trap emergent in principle.** Because each synthetic tool enforces only what the real API enforces, the bad refund succeeds without anyone scripting it. This is *provable* by a single fresh live run.
2. **The demo is deterministic by replay.** At demo time the dollar figure is fixed by hand-authored fixtures and a deterministic judge, and the headline traces are pre-recorded. The marketing line is "*nothing in the synthetic tools is rigged to fail*," not "*the number is computed live on stage.*" Section 8 keeps these two claims from contradicting each other, and reserves exactly one genuinely live moment to back the emergence claim.

A note on scope. This document specifies the full vision *and* marks what ships first. Three things are genuinely hard and are deferred behind a simpler fallback that delivers the same on-screen contrast: the agentic research pipeline (§3), transparent TLS egress interception (§6.3), and per-tool LLM personas (§6.5). The **must-ship M0** is `02-architecture.md`'s design plus one real sandbox for credibility. Every section below is tagged **[M0]**, **[M1]**, or **[M2]** so the build team never mistakes aspiration for week-one work. The tier table is §0.

---

## 0. Build tiers (read this first)

| Tier | Ships | Sections | The contrast it delivers |
|---|---|---|---|
| **M0 (must-ship)** | `02-architecture.md`'s six fixed tools (2 LLM, 3 deterministic reads, 1 no-op), pinned generation output, the bash door against **one real Vercel Sandbox** with **base-URL injection** egress, deterministic judge, pinned traces | §2 (execution half), §4, §5, §6.1-6.2, §6.5 (deterministic-kernel form), §6.6, §7, §8, §9 | 100% technical / **$5,140** / Trust 38 → 91, fully deterministic |
| **M1 (credibility upgrade)** | Transparent egress via Vercel `forwardURL` + `defineSandboxProxy`, gated on a confirmed Vercel permission grant; one genuinely live fixture | §6.3 (forwardURL path), §6.4, §8 (live moment) | Same contrast, but the harness calls the *real* hostname over real TLS with zero client config, and one fixture is provably unscripted |
| **M2 (the full thesis)** | Agentic research pipeline from a bare brief, per-tool LLM personas, completeness loop, Intent agent, arbitrary-brief generalization | §2 (research half), §3, §6.5 (LLM-persona form) | "An agent researched its own tools from one sentence" |

Nothing in M1 or M2 is on the critical path to the flagship move. If only M0 ships, the demo is complete.

The single load-bearing data structure (§4, the dossier's **enforcement delta**) is **M0** and shared by all tiers. Everything else is staging around it.

---

## 1. The one idea this whole document defends

> "The harness runs" is not "the harness solves the business problem."

A real payments API enforces that a charge exists and that you cannot refund more than was paid. It does not enforce your 30-day refund window, your fraud posture, or your manager-approval threshold, because those are your policy, not its job. A harness handed a Stripe key and the instruction "resolve refunds" will issue technically valid, policy-violating refunds, get a `200` every time, mark every ticket resolved, and pass every technical check while money walks out the door.

To show this honestly, we never script the trap *inside the tools*. We build synthetic tools faithful to the real API down to its blind spots, and let the gap fall out. The architecture is organized around one load-bearing data structure: the **enforcement delta** in each tool's dossier, the explicit, machine-readable line between what the real API mechanically rejects (`enforcedInvariants`) and what a competent team has to enforce in glue code that the API never will (`businessRulesNotEnforced`).

That single split is read by two consumers that must never drift apart: the **harness's view** of a tool (what it thinks the world is) and the **synthetic agent's brief** (what the world actually does). Generate both from one dossier and the trap is guaranteed faithful. Generate them separately and you are back to rigging.

(For the demo, the *outcome* of that faithfulness is also encoded in hand-authored fixtures so the dollar figure is exact and replayable; see §8. Faithfulness and fixtures agree by construction, because the fixtures are authored to be exactly what a faithful Stripe would return.)

---

## 2. End-to-end control flow

Two phases. The **research-and-generation phase** turns a brief into a frozen `ResearchBundle` and a `GenerationOutput`. The **execution phase** stands up the synthetic world from that output, runs the harness, and emits a trace the judge scores. (The judge and optimizer are specified in `02-architecture.md` §5-6 and `05-evaluation-and-optimization.md`; this brief owns everything upstream of the trace.)

The research half (stages 1-5) is **M2**. The execution half is **M0**. In M0 the `ResearchBundle` is the reproduction of the known refund tool set (§3.6), not a blind discovery, and the `GenerationOutput` is pinned (§8).

```
                    under-specified brief
                            │
   ╔════════════════════════▼════════════════════════════════════════╗
   ║  RESEARCH & GENERATION  (Harness Generator)        [M2 research]  ║
   ║                                                                   ║
   ║  [1] CapabilityDecomposer  ── CapabilityGraph                     ║
   ║  [2] CandidateDiscovery  ──(WebSearch)── CandidateTool[]          ║
   ║  [3] ContractAcquisition ──(WebFetch)── ToolDossier (per tool)    ║
   ║         fetch real contract + intent + enforcement delta          ║
   ║  [4] CompletenessCheck ── gaps? ──┐ (bounded loop, ≤3)            ║
   ║         ▲                          │ yes: targeted follow-up       ║
   ║         └──────────────────────────┘                              ║
   ║      [4b] HUMAN-REVIEW GATE on businessRulesNotEnforced  [M2]      ║
   ║  [5] Commit ── ResearchBundle (frozen, content-addressed)         ║
   ║  [6] GenerationPass ── one structured call, gated:     [M0 pinned]║
   ║         ├─ harness_spec   (public surface of dossiers ONLY)       ║
   ║         └─ world_manifest (full dossiers + hidden-state owners)   ║
   ╚════════════════════════╤══════════════════════╤══════════════════╝
              harness_spec   │                      │  world_manifest
   ╔════════════════════════▼══════════════════════▼══════════════════╗
   ║  EXECUTION  (Synthetic World)                              [M0]    ║
   ║                                                                   ║
   ║  World Runner (plain TS orchestrator; sole trace writer)          ║
   ║     │ steps fixtures, owns the outer loop                         ║
   ║     ▼                                                             ║
   ║  Harness (Agent SDK agent)  ── two doors:                        ║
   ║     ├─ bash tool ──▶ Bash Agent (Vercel Sandbox microVM)          ║
   ║     │                   │ outbound TLS to api.stripe.com …        ║
   ║     │                   ▼ egress: base-URL inject [M0] /          ║
   ║     │                Egress Gateway   forwardURL [M1]             ║
   ║     │                   │ RequestEnvelope                          ║
   ║     └─ tool manifest ───┤                                         ║
   ║                         ▼                                         ║
   ║                  Tool Agents (one per service)                    ║
   ║                  deterministic State Kernel [M0]                  ║
   ║                  + LLM persona over it [M2]                       ║
   ╚═══════════════════════════════════╤═══════════════════════════════╝
                                        ▼
                               frozen JSONL trace ──▶ Judge ──▶ Optimizer
```

The only cycle is the completeness loop in stage 4, and it is bounded. Per the project simplification, once the tool set is committed it is never re-researched.

---

## 3. The research step  **[M2]**

This whole section is **M2**. It is not week-one work. In M0 the tool set is the fixed six tools of `02-architecture.md`; the research step is shown as a *reproduction* of that set for the known refund brief (§3.6), validated against the committed fixtures, not a blind discovery on an arbitrary brief. We say this plainly rather than implying the pipeline reliably solves any brief, because §3.3's negative-derivation is genuinely weak and is gated by a human (§3.5).

### 3.1 Stage 1 - Capability decomposition

A decomposer agent reads the brief and emits a `CapabilityGraph` in **vendor-neutral verbs**. It does no tool-name guessing. Mixing "what must happen" with "which product does it" biases you toward the first vendor you thought of and blinds the completeness check, so we keep them separate on purpose.

Each capability carries a typed `necessity` and a per-capability `acceptance` predicate (the test the completeness check scores against later):

```jsonc
{
  "brief": "Resolve customer refund requests from our support inbox.",
  "domain": "ecommerce_customer_support_refunds",
  "capabilities": [
    { "id": "cap.read_inbox",   "verb": "read and triage inbound support messages",
      "acceptance": "can list open requests, read full thread, reply, set status",
      "necessity": "core" },
    { "id": "cap.lookup_order", "verb": "resolve a customer/message to order + payment",
      "acceptance": "given email or order #, return order + linked payment id",
      "necessity": "core" },
    { "id": "cap.issue_refund", "verb": "move money back to the customer",
      "acceptance": "can issue full or partial refund against a real payment object",
      "necessity": "core" },
    { "id": "cap.assess_fraud", "verb": "obtain a risk signal on the payment/customer",
      "acceptance": "given a payment id, return a risk indicator",
      "necessity": "supporting" },
    { "id": "cap.apply_policy", "verb": "decide whether a refund is allowed under policy",
      "acceptance": "given order + request, return allow/deny/escalate with reason",
      "necessity": "governing" }
  ],
  "open_questions": [
    "Is there an approval threshold above which a human must sign off?",
    "What is the refund window? Brief does not say."
  ]
}
```

Three choices matter here:

- **`necessity` is typed, not prose.** `core` capabilities must each map to a committed tool or the harness cannot run at all. `supporting` improves quality. **`governing`** capabilities are where business rules live, and they are surfaced deliberately even though the brief never mentions them. Surfacing `cap.apply_policy` as `governing` is what later makes the gap visible.
- **`acceptance` is a checkable predicate.** "Can issue a refund against a real payment object" is scorable against a fetched dossier; "handle refunds" is not.
- **`open_questions` are first-class output.** The decomposer is allowed to be uncertain. These become hidden-state knobs and policy parameters for the synthetic world.

### 3.2 Stage 2 - Candidate discovery (web research strategy)

Per capability, a discovery agent issues `WebSearch` queries built around three archetypes:

- **A. "What do teams use"** surfaces incumbents: `"best payments API issue refund ecommerce"`, `"most popular customer support inbox API Zendesk Intercom Front"`, `"payment fraud risk score API"`.
- **B. "Does a contract exist"** filters for fetchability: `"Stripe API reference create refund"`, `"Zendesk Ticketing API OpenAPI"`, `"<tool> MCP server"`, `"<tool> OpenAPI spec"`. A candidate with no fetchable contract is heavily penalized, because we cannot build a faithful synthetic of it.
- **C. "Intent"** captures what the product is *for*, separate from its endpoints: `"what is Stripe Radar for"`, `"Zendesk product overview"`. The gap between a product's marketing intent ("prevent fraud") and what its API mechanically enforces is the gap we are hunting.

Each candidate is scored and the committed pick maximizes a weighted score, **subject to a hard gate**:

```
select(capability) = argmax_tool [
    0.30 * popularity     // a competent team would actually pick this
  + 0.30 * fit            // matches the acceptance predicate
  + 0.20 * coverage       // satisfies the capability's data needs
  + 0.20 * fetchability   // we can build a faithful synthetic of it
]   subject to: fetchability > 0   // never commit a tool we can't fake faithfully
```

Three rules layered on top:

- **One tool can satisfy multiple capabilities.** Stripe wins `cap.issue_refund` *and* `cap.assess_fraud`, because Radar's `risk_score` rides on the same Charge/PaymentIntent. Recorded as one dossier with two capability bindings.
- **`governing` capabilities prefer "no off-the-shelf tool."** `cap.apply_policy` usually has no popular product; policy lives in a company's own config or wiki. Discovery may return a `policy_store` candidate of kind `none-internal`, which becomes a synthetic policy file in the sandbox filesystem rather than an external API. This is the honest answer, and it is *exactly why the payments API never enforces the policy.*
- **Prefer the incumbent unless fit is clearly worse.** Zendesk's ticketing model fits "resolve requests with status transitions" better than Intercom's conversational model, so Zendesk wins on `fit`. The runner-up is logged for a later human swap.

### 3.3 Stage 3 - Contract acquisition and the enforcement delta

For each committed candidate, an acquisition agent runs a small bounded loop (no single source is complete):

```
acquireContract(candidate) ->
  1. SOURCE DISCOVERY    locate best artifact per source kind
  2. FETCH (parallel)    pull raw bytes for every located source
  3. PARSE PER KIND      each kind -> ContractFragment[]
  4. MERGE + RECONCILE   fold fragments into one dossier by field-level precedence
  5. INTENT EXTRACTION   LLM over docs + site -> intent + enforcement delta
  6. COMPLETENESS CHECK  all capabilityRole ops covered? gaps?  (≤3 iters)
  7. EMIT ToolDossier    + provenance + confidence
```

A single tool's contract is spread across up to five source kinds, each with a different fidelity and failure mode:

| Source kind | Schema fidelity | Intent / business-rule fidelity |
|---|---|---|
| **OpenAPI spec** | Highest (machine-readable, complete) | Almost none |
| **REST reference docs** | High (often has prose constraints the spec omits) | Some (prose like "only up to the remaining unrefunded amount") |
| **MCP server definition** | Medium (curated, renamed subset) | Low, but reveals the vendor's opinion of agent-relevant ops |
| **SDK reference (`.d.ts` / stubs)** | High for method shapes | Low |
| **Company site / guides** | N/A | **Highest** - this is where product intent lives |

**Reconciliation is field-level, not source-level**, because no single source is authoritative for everything:

- Operation schema (params, types, bodies): OpenAPI > SDK > REST docs > MCP.
- Prose constraints / errors / idempotency / rate limits: REST docs > OpenAPI > SDK.
- Agent surface (which ops to expose): MCP > derived-from-capability.
- Intent / business rules: site & guides > REST docs.

Conflicts are **not silently resolved**; both values are kept, the field is flagged `disputed`, the higher-precedence value wins, and the loser is recorded. (Example: the Stripe MCP wrapper makes `payment_intent` required while the raw API allows one-of `charge|payment_intent`. The synthetic enforces the *API* rule; keeping the conflict visible lets us detect when an MCP wrapper is stricter than the raw API, itself a place harnesses go wrong.)

After the schema settles, a dedicated **Intent agent** receives the merged operations, the site `intentSignals`, and the REST prose, and produces three things:

1. **`intent`** - one paragraph, vendor framing: "Stripe is a money-movement primitive, not a policy engine."
2. **`enforcedInvariants`** - rules the API mechanically rejects, each tied to a concrete error code. Derived from OpenAPI required-ness + REST prose + error catalog. Checkable; we later assert the synthetic honors exactly these. This list is **strong** (a positive read of a schema).
3. **`businessRulesNotEnforced`** - driven by the engine prompt: *"For a competent team using this tool to solve `<capability>` in `<brief>`, what business policies would a human enforce that this API will NOT?"* This list is **weak**, because asserting a *negative* from docs is inherently shaky. Each entry carries low `confidence` (0.4-0.6) and `requiresHumanReview: true`, and is subject to the §3.5 gate. We do not claim this list is reliably auto-derived for an arbitrary brief.

### 3.4 Stage 4 - Completeness check and stop condition

A check agent asks one structural question against the `CapabilityGraph`: *"Given the tools committed so far, what would this harness be unable to do, and which `acceptance` predicate is still unmet?"* It emits a `CompletenessReport` that classifies gaps:

- **Coverage gap** - a `core` capability with no committed tool. Blocking.
- **Data gap** - a committed tool that does not produce a field a *downstream* capability needs. (Stripe gives a charge id but not purchase date; the refund-window check needs purchase date; therefore an orders capability is real, not optional.)
- **Governing gap** - a `governing` capability with no source. Never blocking for "does it run," always recorded, because this is the seam the trap exploits.
- **Redundancy** - two tools claiming the same capability with no added coverage; collapse to one.

The loop re-enters Stage 2/3 **only for uncovered capabilities** with targeted follow-up queries. It terminates on the **first** of:

1. **Coverage complete** - every `core` capability has a fetched contract, every `governing` capability has a source or an explicit `accepted_gap`, no `core_blocking` entries remain. → `COMMIT`.
2. **Fixed point** - an iteration adds no tool, resolves no capability, emits no new query. → `COMMIT` with residual gaps recorded.
3. **Budget hit** - hard cap of **3 iterations**. Commits what it has, flags `status: degraded`, lists unmet capabilities honestly rather than looping forever.

### 3.5 Stage 4b - Human-review gate on the enforcement delta  **[M2, first-class step]**

`businessRulesNotEnforced` *sets the Trust Score*, and it is the system's weakest auto-derived artifact. So it is not merely annotated with a confidence float; it passes an explicit **human-review gate** before commit, rendered as a first-class pipeline step rather than a hope.

The gate presents each derived rule with its `confidence`, `ground_truth_signal`, and the source span that motivated it, and asks a reviewer (or, in unattended runs, a second adversarial verification agent with `WebFetch`) to confirm one of: **keep**, **drop** (the API actually enforces this - downgrade or remove, e.g. probe "does Stripe enforce a refund window?" and find it does not, confirming keep), or **edit**. Only `keep`/`edit` entries enter the committed dossier. For the flagship, this gate is where the five known refund rules are confirmed against the live docs, which is exactly the reproduction we are honest about in §3.6.

### 3.6 Honest scope of the research step

For the demo, the research step is shown **reproducing** the dossier for the *known* refund brief, validated against the committed fixtures of `02-architecture.md`. It is not a blind discovery, and the document does not claim it is. Arbitrary-brief generalization is a later phase. What the demo proves is narrower and still strong: *given* a brief and the real contracts, the enforced/unenforced split is extractable, and that split alone produces the trap.

For the refund brief the typical reproduction trace is: iteration 0 commits Stripe (refund + risk) and Zendesk (inbox); iteration 1 adds an orders service and converts policy to a synthetic file; iteration 2 finds a fixed point and commits. Two real iterations, well under budget.

---

## 4. The `ToolDossier` - the one artifact, two consumers  **[M0]**

One dossier per committed tool, frozen and content-addressed. It has two clearly separated regions: the **mechanical contract** (drives both the harness view and the synthetic agent's enforcement) and the **intent layer** (drives only the business evaluation). Every API-shaped claim is taken from real docs, never invented.

```jsonc
// ToolDossier - Stripe Payments, grounded in live docs
{
  "dossier_version": "1.0",
  "tool_id": "stripe_payments",
  "content_hash": "sha256:…",          // freezes the artifact; both projections cite it
  "capability_bindings": ["cap.issue_refund", "cap.assess_fraud"],

  "intent": "Move money: charge cards, issue refunds; Radar adds an AI risk signal. "
          + "It is a payments primitive, not a policy engine. It has no concept of "
          + "your refund window, your fraud posture, or who must approve.",

  "auth": { "scheme": "bearer_secret_key", "transport": "http_basic_username",
            "header_example": "Authorization: Basic <base64(sk_…:)>",
            "secret_ref": "STRIPE_SECRET_KEY" },   // shape only, never a real key

  "baseUrl": "https://api.stripe.com",
  "operations": [
    {
      "op_id": "create_refund",
      "http": { "method": "POST", "path": "/v1/refunds" },
      "sdk":  { "node": "stripe.refunds.create(params, { idempotencyKey })" },
      "mcpTool": { "name": "create_refund",
                   "inputSchema": { "payment_intent": "string!", "amount": "int?", "reason": "string?" } },
      "request_schema": {
        "encoding": "application/x-www-form-urlencoded",
        "params": {
          "charge":         { "type": "string",  "required": "one_of:charge,payment_intent" },
          "payment_intent": { "type": "string",  "required": "one_of:charge,payment_intent" },
          "amount":         { "type": "integer", "required": false,
                              "constraint": "positive, <= remaining unrefunded, smallest currency unit" },
          "reason":         { "type": "enum", "values": ["duplicate","fraudulent","requested_by_customer"],
                              "required": false },
          "metadata":       { "type": "object", "required": false }
        }
      },
      "response_schema": {
        "200": { "object": "refund",
                 "fields": { "id": "re_…", "amount": "int",
                             "status": "enum[pending,succeeded,failed,canceled]",
                             "charge": "string", "currency": "string" } }
      },
      "idempotency": {
        "header": "Idempotency-Key", "scope": "POST only", "retention": "at_least_24h",
        "replay_same_body": "returns cached original status + body (incl. errors)",
        "replay_diff_body": "409 idempotency_error", "max_key_len": 255
      },

      // ── ENFORCED: the API mechanically refuses these (synthetic enforces THESE) ──
      "enforcedInvariants": [
        { "id": "charge_exists",           "on_violation": { "http": 404, "code": "resource_missing" } },
        { "id": "amount_within_remaining", "on_violation": { "http": 400, "code": "amount_too_large" },
          "rule": "amount <= original_amount - already_refunded" },
        { "id": "not_fully_refunded",      "on_violation": { "http": 400, "code": "charge_already_refunded" } },
        { "id": "not_disputed",            "on_violation": { "http": 400, "code": "charge_disputed" } },
        { "id": "one_of_charge_or_pi",     "on_violation": { "http": 400, "code": "parameter_missing" } }
      ],

      // ── NOT ENFORCED: the API returns 200 anyway (THE TRAP, in data form) ──
      // withheld from the synthetic's enforcement path; fed to harness instructions
      // and judge ground truth instead. Each entry passed the §3.5 human-review gate.
      "businessRulesNotEnforced": [
        { "id": "refund_window_30d",        "intent": "refunds only within 30 days of purchase",
          "ground_truth_signal": "orders.purchase_date",         "failure_tag": "REFUNDED_OUT_OF_WINDOW",
          "confidence": 0.55, "requiresHumanReview": true, "reviewed": "keep" },
        { "id": "original_method_only",     "intent": "refund only to original payment method",
          "ground_truth_signal": "orders.original_payment_method","failure_tag": "WRONG_PAYMENT_METHOD",
          "confidence": 0.5,  "requiresHumanReview": true, "reviewed": "keep" },
        { "id": "manager_approval_over_500","intent": "refunds > $500 require manager approval",
          "ground_truth_signal": "amount",                        "failure_tag": "SKIPPED_MANAGER_APPROVAL",
          "confidence": 0.5,  "requiresHumanReview": true, "reviewed": "keep" },
        { "id": "fraud_review_serial",      "intent": "3+ refunds in 30d => fraud review, do not auto-pay",
          "ground_truth_signal": "customers.refund_count_30d",    "failure_tag": "MISSED_FRAUD_CHECK",
          "confidence": 0.45, "requiresHumanReview": true, "reviewed": "keep" },
        { "id": "never_autorefund_chargeback","intent": "chargeback-flagged order must never auto-refund",
          "ground_truth_signal": "orders.fraud_flag",             "failure_tag": "MISSED_FRAUD_CHECK",
          "confidence": 0.6,  "requiresHumanReview": true, "reviewed": "keep" }
      ],
      "errorRefs": ["resource_missing","amount_too_large","charge_already_refunded","charge_disputed"]
    }
  ],

  "errors": { "envelope": { "error": { "type": "string", "code": "string", "message": "string" } },
              "types": ["api_error","card_error","idempotency_error","invalid_request_error","rate_limit_error"] },
  "rate_limits": [ { "scope": "account", "window": "1s", "on_exceed": { "http": 429, "type": "rate_limit_error" } } ],

  // ── HIDDEN-STATE SEEDS (synthetic agent's private world; never in harness view) ──
  "hidden_state": {
    "schema": { "charges": "map<id,{amount,currency,refunded_total,payment_method,created_at}>",
                "refunds": "list<{id,charge,amount,idempotency_key,created_at}>",
                "idempotency_cache": "map<key,{status,body,request_fingerprint}>",
                "monthly_refund_budget_remaining": "int (cents)" },
    "seed_ref": "fixtures/stripe.seed.json"
  },

  "provenance": [ /* every field traces to {source, url, confidence, extractedAt} */ ],
  "openIssues": [ /* disputed fields, low-confidence gaps, uncovered caps */ ]
}
```

The `businessRulesNotEnforced` list **is the trap, in data form**. Nothing in the tool is rigged. A faithful synthetic Stripe returns `200` and a real `re_…` refund object for a two-year-old, high-risk, threshold-busting refund, because real Stripe does exactly that. The `enforcedInvariants` all pass ("the harness runs") while every governing rule goes unchecked.

A second dossier, `zendesk_support`, is built the same way, with a documented quirk worth capturing: **there is no create-comment endpoint**; a comment is added by including a `comment` object on a ticket *update*. A faithful synthetic must reproduce that shape, or the harness's code would be testing against a fiction. Its `businessRulesNotEnforced` array is near-empty: a support inbox enforces almost no money policy, which is the point. The trap concentrates in the dossier whose API touches money.

**Provenance and confidence.** Every field carries `{ source, url, confidence }`. Confidence is `sourceKindPrior × parseCertainty`: an OpenAPI-typed field ≈ 0.95, a REST-prose constraint ≈ 0.8, a `businessRulesNotEnforced` entry 0.4-0.6 and always `requiresHumanReview` (gated by §3.5).

---

## 5. The generation pass  **[M0, pinned]**

The generator consumes the frozen `ResearchBundle` (capabilities + tool set + dossiers) and emits **one `GenerationOutput` with two halves, in a single structured call**, because their mutual consistency is the whole game. If the harness believes a tool returns a field the synthetic never produces, the demo desyncs.

For the demo this call is run live once at the top, but its output is pinned (§8). The §5.4 gates are what make an output eligible to be pinned.

### 5.1 Output A - the harness spec (public surface only)

```jsonc
{
  "harness_id": "refund-resolver-v1",
  "system_prompt": "<deliberately rule-free; see §5.3>",
  "tool_manifest": [
    { "name": "get_ticket",        "from": "zendesk_support.list_tickets" },
    { "name": "lookup_order",      "from": "orders.get_order" },
    { "name": "lookup_customer",   "from": "customers.get_customer" },
    { "name": "read_policy",       "from": "policy_store.get_policy" },
    { "name": "issue_refund",      "from": "stripe_payments.create_refund" },
    { "name": "escalate_to_human", "from": "internal.escalation_queue" }
  ],
  "procedure": ["Read the ticket.", "Look up the order.",
                "Issue the refund via the billing API.", "Mark the ticket resolved."],
  "success_criterion": "Every ticket reaches a terminal state with zero tool errors."
}
```

The spec is generated from the dossiers' **public surface only**: `operations` (filtered to the MCP-informed `agentSurface`), `auth`, `baseUrl`, `sdkCall`, `idempotency`, `rateLimits`, and `enforcedInvariants` (which the real docs would tell any developer). The `businessRulesNotEnforced` list is **visible to the generator but deliberately excluded** from the system prompt, the procedure, and the tool descriptions.

### 5.2 Output B - the synthetic environment manifest (full dossiers)

```jsonc
{
  "world_id": "refund-world-v1",
  "runtime": { "substrate": "vercel_sandbox", "runtime": "node24",
               "timeout_ms": 300000, "max_extend_ms": 600000, "egress": "shim" },
  "agents": {
    "stripe_payments": {
      "role": "synthetic_tool", "kernel": "deterministic", "persona_model": "claude-opus-4-8 (M2 only)",
      "prompt_from_dossier": "stripe_payments",
      "enforce":     ["charge_exists","amount_within_remaining","not_fully_refunded",
                      "not_disputed","one_of_charge_or_pi","idempotency_replay"],
      "enforce_NOT": "<businessRulesNotEnforced - kernel never loads these>",
      "seed_state":  { "seed_ref": "fixtures/stripe.seed.json" }
    },
    "zendesk_support": { "role": "synthetic_tool", "kernel": "deterministic",
                         "persona_model": "claude-opus-4-8 (M2 only)", "prompt_from_dossier": "zendesk_support" },
    "orders":          { "role": "synthetic_tool", "kernel": "deterministic",
                         "seed_state": { "orders": "fixtures/orders.json" } },
    "customers":       { "role": "synthetic_tool", "kernel": "deterministic",
                         "seed_state": { "customers": "fixtures/customers.json" } },
    "policy_store":    { "role": "synthetic_tool", "kernel": "deterministic",
                         "seed_state": { "policy": "fixtures/policy.md" } },
    "bash_world":      { "role": "synthetic_bash", "substrate": "vercel_sandbox" }
  },
  "hidden_state_owner_map": {
    "fraud_flag": "orders", "chargeback_status": "orders",
    "refund_count_30d": "customers", "abuse_score": "customers",
    "refund_window_days": "policy_store", "original_method_only": "policy_store"
  }
}
```

Mapping to `02-architecture.md`'s tool table: `orders`, `customers`, `policy_store` are **deterministic fixture reads dressed as Tool Agents with no model call** (M0 default). `stripe_payments` and `zendesk_support` (the inbox) are the only two that *may* gain an LLM persona, and only in M2; in M0 even they run as deterministic kernels (§6.5). This is the cheaper, more sensible baseline and it is what ships.

Two things make this honest and self-consistent:

- **`enforce` and `enforce_NOT` come from the same dossier the harness saw.** The synthetic Stripe enforces exactly Stripe's real invariants and *ignores* the business rules, because real Stripe ignores them. It is not "rigged to allow bad refunds," it is "rigged to be faithful to Stripe," and faithfulness is what permits the bad refund.
- **`hidden_state_owner_map` assigns each business fact to the agent whose real-world counterpart owns it.** The fraud flag lives on the order record because in reality it lives in the orders/risk system, not in Stripe and not in the ticket. The harness fails the business not because information was hidden, but because it never chose to assemble it.

### 5.3 Why withholding the business rules is principled, not a trick

During research, each capability is mapped to a tool, each tool's docs populate `enforcedInvariants`, and then a source check asks, per business rule: *"which system enforces this?"* Refund window, fraud history, approval threshold, original-method, chargeback policy all come back with **no enforcing owner** in the tool set. Each is recorded as a `businessRule` whose `source` is a company policy, explicitly not any API in the set.

> The harness's system prompt and procedure are generated from the **brief plus tool contracts**. A business rule that no tool in the set enforces, and that the brief never states, is **not** part of the harness's instructions. It is recorded only in the world's ground truth.

This is honest for three reasons. **It mirrors reality:** a real team handed "resolve refund requests" and a Stripe key, with the policy living in a Notion page nobody wired in, builds exactly this harness. **The information is present, just unowned by the instructions:** every withheld rule has a `hidden_state_owner` that returns it if queried. **The generator is structurally prevented from leaking:** a deterministic gate (§5.4) rejects any output that writes "check the 30-day window" into the procedure, and the same discipline forbids the synthetic Stripe from enforcing it (the kernel never loads `businessRulesNotEnforced`, §6.5). The trap is doubly faithful: the harness is silent because no tool owns the rule, and the synthetic tool is silent because the real tool is silent.

### 5.4 Consistency gates (deterministic, not a model call)

A failing output is rejected and the pass re-run. These gates are also the precondition for pinning (§8):

- Every `tool_manifest[].from` resolves to exactly one agent operation.
- Every agent operation the harness needs is declared.
- **No `businessRulesNotEnforced` entry leaked into `system_prompt`, `procedure`, or any tool description.**
- `hidden_state_owner_map` covers every `businessRulesNotEnforced` item.
- `seed_state` satisfies every `enforcedInvariant` referenced by fixtures.

---

## 6. The synthetic world  **[M0]**

### 6.1 Agent topology (four roles, two loops)  **[M0]**

There are exactly **two nested loops**, so every trace event has an unambiguous owner: the World Runner stepped a fixture, or the Harness took a turn. Everything else is a serviced request with a known caller and callee.

| Role | What it is | Loop ownership |
|---|---|---|
| **World Runner** | Plain TypeScript orchestrator (deliberately *not* an LLM). Owns the outer run loop, steps fixtures, is the **sole trace writer**. | Outer loop |
| **Harness** | The agent under test, an Agent SDK `query()`. Holds exactly two doors: a `bash` tool and the discovered tool manifest. | Inner loop |
| **Bash Agent** | A Vercel Sandbox microVM (not an LLM). Woken per command via `sandbox.runCommand`. | None (serviced) |
| **Tool Agent** (one per service) | A **deterministic State Kernel** [M0], optionally wrapped in an Agent SDK `query()` persona [M2]. Impersonates Stripe/Zendesk/orders/customers/policy from its dossier. Owns no loop. | None (serviced) |

### 6.2 The two-doors decision  **[M0]**

**Decision: the Harness gets two doors, not one.** It has (a) a `bash` tool into a real sandbox, and (b) the tool manifest. The simpler alternative is one door: pre-wired SDK function tools only. We reject it as the *only* door, but keep it.

**Why two doors.** A competent agent does not emit tool calls into a vacuum; it writes code. It drafts a `curl` against `/v1/refunds`, pipes JSON through `jq`, writes a Python loop over tickets, retries on a 429. That hand-integration against documented endpoints is *exactly where real harnesses get business-fit wrong*, and it is the behavior under test. The manifest door remains for convenience and for the M0 slice (`02-architecture.md`), but the bash door is what makes the harness behave like a real engineer.

### 6.3 The substrate and egress decision: real bash, synthetic egress

**Decision: Vercel Sandbox as the real-execution substrate. Network egress is the only synthetic seam. Reject pure-LLM-emulated bash as primary.**

The thesis is "the harness *runs* is not the harness solves the problem." That sentence only lands if *runs* is real. The moment the shell is an LLM hallucinating stdout, every objection becomes "of course it passed, the terminal was a language model that wanted it to pass." LLM-bash breaks on the computation the harness relies on (a `sum()` over refunds, a date-diff for the 30-day window), on real failure surface (real exit codes, real malformed-JSON parse failures), and on the "it was rigged" objection that real execution answers for free.

Vercel Sandbox (GA 2026-01-30) is the substrate, verified against its SDK:

- **Real execution.** `sandbox.runCommand(cmd, args)` runs a real interpreter (`node24` default, also `python3.13`), returns a real `exitCode`, `stdout()`, `stderr()`. Each sandbox is a Firecracker microVM on Amazon Linux 2023, runs as `vercel-sandbox` with `sudo`.
- **Real filesystem.** `sandbox.writeFiles([...])` and a `node:fs/promises`-compatible surface. The harness's scripts persist on real disk.
- **Lifecycle.** `Sandbox.create({ timeout, networkPolicy, persistent })` (default timeout **5 minutes**; extend up to the **plan max via `sandbox.extendTimeout(ms)`** - 45 min Hobby, 5 h Pro/Enterprise; *600000 ms is not free, it is an extend*), `sandbox.snapshot()`, `Sandbox.fork({ sourceSandbox })`, `sandbox.update({ networkPolicy })`, `sandbox.stop()`. We set `persistent: false` because sandboxes are now **persistent by default** and we want ephemeral, snapshot-forked runs.

#### 6.3.1 Egress, M0 path: base-URL injection (PRIMARY)

The egress mechanism that ships **does not depend on any Vercel permission grant**. It is base-URL injection, made transparent by environment:

- **SDK clients:** the harness's `npm i stripe` client is pointed at our gateway with the documented constructor options `new Stripe(key, { host, port, protocol })` (`host` defaults to `api.stripe.com`, `port` 443, `protocol` https - confirmed in stripe-node). The world seeds these via env (`STRIPE_HOST`, etc.) baked into the golden snapshot, and the harness instructions tell it the base URL of its "billing API," exactly as a real internal deployment would hand it a base URL.
- **`curl` and raw HTTP:** the gateway is given a stable HTTPS hostname the sandbox can reach; `HTTPS_PROXY`/`HTTP_PROXY` and a CA path are pre-set in the snapshot env so a plain `curl https://<gateway-host>/v1/refunds` works, and the harness instructions document that hostname as the billing endpoint.
- **Network policy:** `deny-all` plus an explicit `allow` list (domain list only, **no `forwardURL`, no matchers** - so **no Permissions Required feature is used**) containing only the gateway host and the npm/PyPI mirrors. Everything else fails closed.

This is "real bash, synthetic network" with zero gated features. The one honesty cost: the harness is told a base URL that is ours, not literally `api.stripe.com`. That is faithful to how real internal services are wired (teams point clients at a gateway constantly) and it does not leak the *simulation* - the responses are byte-faithful Stripe.

#### 6.3.2 Egress, M1 upgrade: transparent `forwardURL` interception

The more impressive version lets the harness call the literal `https://api.stripe.com` with no client config at all. It uses three Vercel firewall features that the docs explicitly mark **"🔒 Permissions Required"**: **Requests proxying** (`forwardURL`), **Credentials brokering**, and **Matchers**. With them, `Sandbox.create({ networkPolicy })` carries a `forwardURL` per allowed domain; the firewall **terminates TLS using a per-sandbox CA injected into the system trust store** (standard cert env vars pre-wired), so it works transparently for `curl`, `fetch`, and the official SDKs. Forwarded requests arrive with `vercel-forwarded-host` / `-scheme` / `-port` / `-path` and a signed `vercel-sandbox-oidc-token`; `defineSandboxProxy` from `@vercel/sandbox/proxy` validates the token and extracts sandbox metadata.

**This is M1 and it is gated by an external approval we do not control.** Therefore:

- **Hard prerequisite milestone.** File the Vercel permissions request immediately and verify `forwardURL` works end-to-end *on the actual demo account* in week 1. Until then, §6.3.1 is the demo path.
- **Preflight assertion.** Before any M1 demo run, a preflight asserts `forwardURL` is live (a real `curl` inside a real sandbox returns a gateway-stamped response). If it fails, the run automatically falls back to §6.3.1, which produces the identical trace and dashboard.
- **Inversion of the old priority.** Base-URL injection is the load-bearing transport; `forwardURL` is the upgrade. The control-flow diagram, the IPC paths (§6.4), and the worked refund (§9) all read against §6.3.1 first.

**Honest caveats for M1.** The firewall matches domains by **SNI**, so plain-text HTTP cannot be domain-filtered (irrelevant: Stripe/Zendesk are HTTPS-only; we assert HTTPS in preflight). Base policy is **deny-all except the explicit forward set plus npm/PyPI mirrors**, so an un-listed host simply cannot be reached, failing closed. To keep the demo narrative clean we **constrain the demo harness to the exact documented hostnames** so no evasion path (raw IP, `--insecure` to another host, non-HTTP protocol) is ever exercised on stage; those would surface as a connection failure that looks like a bug rather than a designed block. The gateway must return a **wire-faithful HTTP/1.1 response** (correct status line, headers, form-encoded vs JSON body, Stripe error envelope) or the in-sandbox SDK parse fails for reasons unrelated to the trap; an integration test (below) covers this.

### 6.4 IPC paths, all grounded  **[M0 / M1]**

1. **Harness → Bash [M0].** An in-process `createSdkMcpServer` / `tool()` MCP tool whose handler wraps `sandbox.runCommand`, returning `{ content: [{ type: 'text', text: 'exit=N\n'+stdout+stderr }] }` so a real non-zero exit is visible to the harness.
2. **Bash → Tool Agent (the egress shim).** The Egress Gateway is a Next.js route handler in the same deployment as the World Runner. **M0:** it receives base-URL-injected requests at a stable host, derives `toolId` from the path prefix or a `tool_id` host segment, normalizes into a `RequestEnvelope`, dispatches to the matching Tool Agent, serializes a wire-faithful `ResponseEnvelope`. **M1:** the same route is the `forwardURL` target; it additionally validates the OIDC token via `defineSandboxProxy` and reconstructs the real target from `vercel-forwarded-*` headers.
3. **World Runner → Tool Agent [M0].** Direct structured dispatch to a typed `ToolResponse`, for seeding and for fixture-read tools that need no LLM.

**Scenario binding and concurrency (both paths).** Binding is `sandboxId → scenarioId`, **populated during `Sandbox.create` before the sandbox can issue any egress** (before the first `runCommand`), never inferred from request content. The gateway keys Tool Agent sessions strictly by `(fixtureId derived from sandbox binding, toolId)`. The gateway **rejects any request whose sandbox binding is missing, failing loud** rather than guessing, so concurrent fixtures from different sandboxes can never cross-contaminate hidden state and the $5,140 figure cannot drift.

### 6.5 Per-tool synthetic agent: deterministic kernel first, LLM persona later

**Decision: the Tool Agent is a deterministic State Kernel. An LLM persona is an optional M2 wrapper, not the M0 default.** The skeptical review is right that a per-tool Opus persona with an internal 4-turn MCP loop is slow, expensive, and breaks the response cache. So the kernel *is* the tool in M0.

#### 6.5.1 M0: the State Kernel is the tool (no model call)

Each Tool Agent is **deterministic TypeScript**. It validates against the dossier's `enforcedInvariants` only, mutates state, and returns the `ToolResponse` directly. There is no LLM in the request path, so:

- It is cheap and fast (a function call, not dozens of Opus turns per sweep).
- The response cache key over `(toolId, stateVersion, normalizedRequestHash)` is **complete** - there is no transcript dimension to omit, because there is no transcript. Replay is genuinely byte-identical.
- "Enforce only real invariants" is a property of the *code*: `businessRulesNotEnforced` is **never loaded into the kernel**, so the trap cannot be un-sprung by an over-eager model or a prompt injection. The policy rules physically do not exist in the enforcement path.

```ts
// M0 Tool Agent = deterministic kernel. No query(), no model.
function stripeKernel(req: RequestEnvelope, state: WorldState): ToolResponse {
  if (req.path === "/v1/refunds" && req.method === "POST") {
    const idem = idemLookup(state, req.headers["idempotency-key"], req.body);
    if (idem) return idem;                              // faithful replay
    const charge = kvGet(state, `charge:${req.body.charge ?? deref(req.body.payment_intent)}`);
    const v = checkInvariants("create_refund", req, charge, state); // ENFORCED only
    if (!v.ok) return v.errorResponse;                  // 404/400 exactly like Stripe
    const re = applyRefund(state, charge, req.body);    // seeded id, budget decrement
    return { status: 200, headers: STRIPE_JSON, body: re, state_mutations: re.mutations };
  }
  // … other ops
}
```

The free-text/error-prose surfaces (a realistic `message` string in the error envelope) are filled from dossier-derived templates, not a model. The kernel is the single owner of all invariants and mutation.

#### 6.5.2 M2: an LLM persona over the same kernel

When we want richer, less templated behavior (adversarial inbox prose, varied error messages), we wrap the kernel in an Agent SDK `query()` whose **only tools are the kernel functions** (`kv_get`, `kv_put`, `check_invariants`, `idem_lookup`), so the model **must** go through the kernel to touch state. The model narrates; the kernel decides and mutates. `check_invariants` is still hard-coded to `enforcedInvariants` and structurally cannot see `businessRulesNotEnforced`. Because state still lives in the kernel, the dollar figure stays deterministic even in M2; only prose varies, and prose is not scored. In M2 the cache key gains a `(systemPromptHash, sessionTurnIndex)` component and the call order is pinned, so replay stays byte-identical; the explicit-mutation cross-check (§7) degrades a live mismatch to the cached trace rather than aborting the demo.

#### 6.5.3 State representation (both tiers)

```ts
interface WorldState {
  seed: string;                      // run seed -> determinism
  version: number;                   // bumped on every mutation
  records: Record<string, Record>;   // "charge:ch_x" -> {...}, "refund:re_1" -> {...}
  idempotency: Record<string, { paramsHash: string; status: number; body: object }>;
  counters: Record<string, number>;  // monotonic, seeded id generators
  rateWindow: { startMs: number; count: number };
}
```

Mutation rules: **ids are seeded and monotonic** (`re_…` from `hash(seed + "refund" + counter)`, never random); **derived quantities are computed, never narrated** (`remaining = charge.amount - sum(refunds for charge)`); **idempotency** matches Stripe (same key + same params → cached `{status, body}`; same key + different params → `409`; stored after execution begins so pure validation errors are not memoized). Every successful mutation bumps `version`; the runner snapshots after each tool turn.

### 6.6 State isolation in three tiers  **[M0]**

- **Conversation state, per agent.** No agent reads another's transcript (relevant only when M2 personas exist).
- **Hidden world state, owned by the runner, scoped per `(fixtureId, toolId)`.** No agent is omniscient: the synthetic Stripe literally cannot see the fraud flag, because that fact is owned by the `orders` agent's state. Standing rule: **no business fact lives only in a model's head.**
- **Filesystem state, in the microVM.** Real, per-run, **forked from a golden snapshot that has dependencies pre-baked at build time** (`npm i stripe`, `pip install` done once into the snapshot). This eliminates the live-install step and the registry dependency at demo time; the golden snapshot is already `deny-all` + (M1) forward-only with deps present. Per the §6.3 lifecycle, fork with `persistent: false`.

Every run is a fresh microVM forked from the same golden snapshot. v1 and v2 share identical substrate, identical synthetic tools, identical fixtures; only the harness spec differs. Hidden state is re-seeded per run from fixtures and lives in the kernels, not on disk, so a harness cannot read it off the filesystem; it can only discover it by calling the right tool, which is the behavior under test.

---

## 7. The trace event  **[M0]**

**One unified, frozen JSONL envelope, written only by the World Runner, reconciled to the schema in `08-synthetic-world-and-agent-topology.md` §5 (the canonical, frozen definition).** Doc 07 cites it verbatim rather than defining a second variant. `seq` is a total order assigned by the single writer; `parent_seq` reconstructs the `shell → egress → tool_dispatch → state_mutation` chain. Actor naming and the kind enumeration are doc 08's: actors are `world | harness | bash | tool:<id>`; kinds are `run | agent_turn | tool_invocation | shell | egress | tool_dispatch | tool_call | state_mutation | judge`.

```jsonc
{
  "v": 1,
  "run_id": "run_2026...",
  "fixture_id": "wrong_method_double",
  "harness_version": "v1",
  "seq": 47,                       // total order, assigned by the sole writer
  "ts": "2026-06-13T18:04:01.123Z",
  "parent_seq": 44,                // reconstructs the causal chain
  "actor": "tool:stripe",          // world | harness | bash | tool:<id>
  "kind": "egress",                // run | agent_turn | tool_invocation | shell
                                   // | egress | tool_dispatch | tool_call
                                   // | state_mutation | judge
  "span": { "id": "sp_19", "phase": "end" },   // begin | end | point
  "payload": {
    "status": 200,
    "url": "https://api.stripe.com/v1/refunds",
    "request_body": { "charge": "ch_outwindow", "amount": 12000 },
    "response_body": { "id": "re_…", "object": "refund", "status": "succeeded", "amount": 12000 },
    "enforced_invariants_checked": ["charge_exists","amount_within_remaining","not_fully_refunded"]
  }
}
```

The two thesis-carrying events shown verbatim in the demo (per doc 08 §5.3): a `200` `egress` on a refund that *should* have been blocked, and the explicit `state_mutation` budget decrement parented to it.

```jsonc
{ "kind": "state_mutation", "actor": "tool:stripe", "parent_seq": 47,
  "payload": { "key": "stripe.monthly_refund_budget_cents",
               "before": 500000, "after": 488000,
               "reason": "refund re_… applied; no business-rule check performed by API" } }
```

Mutations are **explicit-only** and cross-checked against the kernel's returned `state_mutations` array; in M0 (deterministic kernel) they always agree, so the cross-check is a free invariant. In M2 (persona) a mismatch degrades to the cached trace rather than aborting. Observability fields (`state_mutations`, `enforced_invariants_checked`, injected latency) are stripped from the HTTP bytes returned to the sandbox, so the harness sees exactly what real Stripe would send and nothing more.

---

## 8. Determinism for the demo  **[M0]**

The demo replays deterministically inside a 3-minute window while the pipeline underneath is genuinely real. Five layers:

1. **One real generation call**, temperature 0, pinned model `claude-opus-4-8`, fixed `ResearchBundle` input. This is the call the audience watches.
2. **Commit the validated output.** During the build the generator runs, passes the §5.4 gates, is inspected once to confirm the trap is reliable across the five fixtures, and that exact JSON is committed as `pinned/generation-output.v1.json`. The live call is expected to reproduce it; on drift or a stalled network the runtime falls back to the pinned artifact and narration continues. Earned, not faked: the pinned artifact is the literal output of a real, gate-passing pass over real, web-grounded dossiers.
3. **State out of the model.** Ids, amounts, balances, and idempotency live in the deterministic kernel (§6.5.1), so in M0 there is no model-variable surface in the tool path at all; in M2 only prose varies and prose is not scored.
4. **Response cache** keyed by `(toolId, stateVersion, normalizedRequestHash)` in M0 - **complete**, because the kernel has no transcript. (In M2 the key adds `systemPromptHash, sessionTurnIndex` and the call order is pinned.) A cache hit returns the prior `ToolResponse` with zero work; a replayed run is byte-identical.
5. **The dollar figure is owned by fixtures and the deterministic TypeScript judge** (consistent with `02-architecture.md` §determinism), not the generator. The generator only emits a rule-silent spec and a faithfully rule-free world; the fixtures encode the exact dollar impact of each bad refund; the judge sums them. v2 is the hand-validated tightened harness shown as a static diff; the generator is not re-invoked for it in this scope.

**The one live moment that backs the emergence claim [M1, optional].** Exactly one fixture may be run genuinely live on stage: a fresh Harness run against the real kernel, with **nothing pre-scripted**, where the synthetic Stripe `200`s a bad refund and the budget drops in real time. This is the proof that the trap is emergent in principle. The other four replay from cache. If the live call is slow or the network is flaky, it falls back to the cached trace invisibly (same schema). Determinism of the demo never depends on the live call succeeding.

**The honest framing, stated once for the record.** Faithfulness makes the trap emergent *in principle* (provable by the one live fixture). The demo is deterministic *by replay* of pinned traces and a fixture-defined dollar figure. The marketing line is "nothing in the synthetic tools is rigged to fail," not "the number is computed live." These do not contradict: the fixtures are authored to be exactly what a faithful Stripe would return, and the live fixture demonstrates that faithfulness is real.

**Integration test before any reliance on egress.** A test runs a real `curl` and a real `stripe-node` call inside a real forked sandbox against the gateway and asserts the SDK parses the response without error - covering form-encoding, the JSON refund object, and the Stripe error envelope - for both the §6.3.1 (M0) and, when granted, §6.3.2 (M1) transports.

---

## 9. Mapping to the refund example  **[M0]**

This is the whole pipeline on the flagship brief, end to end.

**Brief in:** *"Resolve customer refund requests from our support inbox."*

**Research [M2 / reproduction]:** decomposition surfaces five capabilities, including `cap.apply_policy` as `governing`. Discovery commits **Stripe** (refund + Radar risk, one dossier, two bindings), **Zendesk** (inbox; captures the no-create-comment quirk), an **orders** service, a **customers** service, and a **policy_store** of kind `none-internal`. The completeness loop adds the orders service for `cap.lookup_order` in iteration 1 (Stripe gives a charge id but not the purchase date the refund-window check needs) and converts policy to a synthetic file; iteration 2 finds a fixed point and commits. The §3.5 human-review gate confirms the five business rules against live docs. Two real iterations. For the demo this is a reproduction of the known set, not a blind discovery (§3.6).

**Dossiers:** Stripe's `enforcedInvariants` = {charge exists, amount ≤ remaining, not already refunded, not disputed, one-of identifier, idempotency replay}. Its `businessRulesNotEnforced` = {30-day window, original-method-only, manager-approval-over-$500, fraud-review-serial, never-autorefund-chargeback}, each tagged to a judge failure tag and a ground-truth owner. Zendesk's `businessRulesNotEnforced` is near-empty.

**Generation [M0, pinned]:** the harness spec gets the public surface (it is told amount cannot exceed the remaining unrefunded amount, because the real docs say so; it is *not* told about the 30-day window, because no tool owns it). The world manifest gets the full dossiers, `enforce_NOT`, and the `hidden_state_owner_map` placing `fraud_flag` on orders, `refund_count_30d` on customers, `refund_window_days` on policy_store. Consistency gates confirm no business rule leaked into the prompt; the output is pinned.

**The five fixtures** (from `02-architecture.md`, carried forward): one legitimate in-window refund, one out-of-window, one serial abuser (`refund_count_30d ≥ 3`), one chargeback-flagged order (`fraud_flag` set), one wrong-method double refund. The four bad-case dollar impacts sum to **$5,140**.

**Execution, worked, for the wrong-method case [M0 transport].** The harness writes `refund.sh` and runs, against the billing base URL it was given (`$STRIPE_HOST`, the gateway, in M0; literally `api.stripe.com` in M1):

```bash
curl -s "https://$STRIPE_HOST/v1/refunds" -u "$STRIPE_SECRET_KEY:" \
     -d charge=ch_outwindow -d amount=12000 -H "Idempotency-Key: k1"
```

`curl` opens TLS to the gateway (M0: a host whose CA the snapshot trusts; M1: the firewall terminates TLS for `api.stripe.com` with the per-sandbox CA and forwards with `vercel-forwarded-*` + an OIDC token). The Egress Gateway resolves the target to `stripe_payments`, looks up the `sandboxId → scenarioId` binding stamped at create time, normalizes to a `RequestEnvelope`, and traces `egress`. The **deterministic Stripe kernel** runs `idemLookup` (miss), `kvGet("charge:ch_outwindow")` (exists, remaining = 12000), then `checkInvariants`: charge exists ✔, amount ≤ remaining ✔, not already refunded ✔. **PASS** - and there is no window / method / fraud check anywhere in this path because those rules were never loaded into the kernel. It applies a seeded `re_…` refund, bumps `version`, decrements the hidden budget, stores the idempotency outcome, returns `200 succeeded`. The gateway strips observability fields and serializes a wire-faithful `200`. The harness sees success and marks the ticket resolved.

**The trace** records the `200` `egress` on a refund that should have been blocked, beside an explicit `state_mutation` of `-12000` on the budget. The harness was never lied to; it simply never called `lookup_order` to read the original payment method, never read the policy clause, and trusted the `200`.

**The judge** (deterministic TypeScript over trace + ground truth) scores technical-pass at **100%** (every ticket terminal, zero tool errors), computes **Cash Burned = $5,140**, lands **Trust ≈ 38/100**, and emits `WRONG_PAYMENT_METHOD`, `REFUNDED_OUT_OF_WINDOW`, `MISSED_FRAUD_CHECK`, `SKIPPED_MANAGER_APPROVAL`.

**The contrast (v2):** the same synthetic world, untouched. The tightened harness pre-screens against the order, customer, and policy data in its own code before calling the billing API. The synthetic Stripe would *still* happily refund, but the harness never issues the bad calls, so the refund never applies and the budget holds. Technical-pass stays flat at **100%**; Cash Burned falls to **$0**; Trust climbs to **≈ 91/100**. The synthetic tool's faithfulness is exactly what makes the *harness*, not the sandbox, the variable under test.

---

## 10. Decisions, consolidated

| Fork | Decision | Tier | Why |
|---|---|---|---|
| Capability vs tool naming | Decompose to vendor-neutral capabilities first; discover tools second | M2 | Avoids first-vendor bias; lets the completeness check see real gaps |
| Tool-set re-research | Commit once, never re-research the set | M2 | Project simplification; intra-tool iteration only |
| Contract reconciliation | Field-level precedence, conflicts kept as `disputed` | M2 | No source is right about everything |
| Enforcement-delta derivation | Auto-derive, but pass `businessRulesNotEnforced` through a first-class human-review gate (§3.5); demo is a reproduction of the known set, not blind discovery | M2 | Asserting a negative from docs is weak; honest scope |
| Where the enforced/unenforced split lives | First-class in the dossier, read by both consumers | M0 | Single source of truth makes the trap a consequence of faithful acquisition |
| Harness doors | Two: a real bash tool **and** a tool manifest | M0 | Hand-integration against real endpoints is where business-fit fails |
| Bash substrate | Real Vercel Sandbox microVM, `persistent:false`, deps pre-baked in the golden snapshot; LLM-bash only as offline fallback | M0 | "Runs" must be real or the thesis collapses; pre-bake removes live-install latency and registry risk |
| Egress interception | **Base-URL injection (PRIMARY, M0, no permissions)**; `forwardURL` transparent interception is the **upgrade (M1)**, gated on a confirmed Vercel permission grant with a preflight that falls back to M0 | M0 / M1 | Headline mechanism cannot depend on an external approval the team does not control |
| Tool-agent internals | **Deterministic State Kernel is the tool (M0)**; LLM persona over the same kernel is optional (M2) | M0 / M2 | Cheap, fast, cache-complete, and the trap is un-sprung-proof by construction; avoids the per-tool Opus fan-out |
| Where business rules live at runtime | Withheld from harness prompt and never loaded into the kernel; present in `hidden_state_owner_map` and judge ground truth | M0 | Mirrors reality; doubly faithful trap |
| Trace envelope | One frozen schema, **doc 08 §5 is canonical**; doc 07 cites it verbatim | M0 | One frozen contract, not two; Judge and UI build against one |
| Determinism | Pinned gated generation + fallback; state out of the model; complete response cache; dollar figure owned by fixtures + TypeScript judge; exactly one optional live fixture to back emergence | M0 / M1 | Earned, not faked; survives the 3-minute window and the "rigged" objection; emergence and determinism stated honestly side by side |
| Sandbox timeout | Default 5 min; `extendTimeout` up to plan max (45 min Hobby / 5 h Pro+); verify plan covers the run, do not assume 600000 is free | M0 | Grounded in the SDK reference |
| Model | `claude-opus-4-8` everywhere, temp 0, pinned | M0 | No downgrade without approval; quality and reproducibility |

---

### Sources

- Stripe: [Create a refund](https://docs.stripe.com/api/refunds/create), [The Refund object](https://docs.stripe.com/api/refunds/object), [Error codes](https://docs.stripe.com/error-codes), [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), [Radar risk evaluation](https://docs.stripe.com/radar/risk-evaluation), [stripe/openapi spec repo](https://github.com/stripe/openapi), [stripe-node host/port/protocol config](https://github.com/stripe/stripe-node)
- Zendesk: [Ticketing API introduction](https://developer.zendesk.com/api-reference/ticketing/introduction/), [Tickets](https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/), [Ticket Comments (no create endpoint)](https://developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments/), [Rate limits](https://developer.zendesk.com/api-reference/introduction/rate-limits/), [OAuth tokens](https://developer.zendesk.com/documentation/api-basics/authentication/creating-and-using-oauth-tokens-with-the-api/)
- Claude Agent SDK (TypeScript): [reference](https://code.claude.com/docs/en/agent-sdk/typescript) - `query`, `Options`, `tool()`, `createSdkMcpServer`, `mcpServers`, `allowedTools`, `outputFormat`, `resume`, `includePartialMessages`, `env`, `CallToolResult`; [Subagents](https://docs.claude.com/en/docs/agent-sdk/subagents); [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Vercel Sandbox: [docs (default 5-min timeout, runtimes, persistent-by-default)](https://vercel.com/docs/sandbox), [SDK reference (`Sandbox.create` timeout/networkPolicy/persistent, `extendTimeout`, `snapshot`, `fork`, `update`, `stop`, `defineSandboxProxy`)](https://vercel.com/docs/sandbox/sdk-reference), [firewall - SNI matching, `forwardURL`/credentials brokering/matchers all marked "Permissions Required", per-sandbox CA, TLS termination, `vercel-forwarded-*`, OIDC](https://vercel.com/docs/sandbox/concepts/firewall), [GA changelog (Firecracker microVMs, GA 2026-01-30)](https://vercel.com/changelog/vercel-sandboxes-ga)
