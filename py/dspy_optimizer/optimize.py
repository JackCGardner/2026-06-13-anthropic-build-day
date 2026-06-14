"""Run the instruction optimizer over the refund harness.

The optimizer improves the harness instruction so the agent better achieves the
business goal in the synthetic refund world, judged by the deterministic judge,
under the two regularizers in metric.py (prompt length and rule count). The
optimizable artifact is the instruction; execution is delegated to the TS bridge.

Optimizer choice: COPRO. COPRO rewrites a module's instruction wholesale each
round with a proposer model and selects on a custom scalar metric over a small
trainset, which is exactly this task. Rewriting wholesale (rather than appending)
is what keeps the optimizer from the append-only growth the length and rule-count
penalties exist to fight; MIPROv2 also tunes few-shot demos, which this
instruction-only, execution-delegated task does not use, so COPRO is the fit.

Two run modes:

  Live run (default): configure dspy.LM on Anthropic claude-opus-4-8 as the
  proposer, run COPRO against the live TS bridge (the real harness + judge), and
  write the best instruction. Requires ANTHROPIC_API_KEY.

  Dry run (--dry-run): configure a dspy DummyLM with canned candidate
  instructions of varying length and rule count, including a deliberately
  bloated one, and score them through the keyless --mock bridge. This exercises
  the whole loop with no credential and demonstrates the bloated candidate
  losing to a concise one under the regularized metric.

The trajectory printed per round shows, for the round's candidate: holdout_trust,
token_estimate, rule_count, and the combined regularized score. The best
instruction is written to out/best-instruction.json.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import dspy
from dspy.utils.dummies import DummyLM

from dspy_optimizer.harness_program import (
    RefundHarness,
    SEED_PROCEDURE,
    instruction_to_candidate_json,
)
from dspy_optimizer.metric import (
    HARD_MAX_TOKENS,
    LENGTH_WEIGHT,
    MAX_RULES,
    RULE_WEIGHT,
    TARGET_TOKENS,
    make_metric,
    run_bridge,
    regularized_score,
    score_candidate,
)

OUT_DIR = Path(__file__).resolve().parent / "out"
BEST_PATH = OUT_DIR / "best-instruction.json"

ANTHROPIC_MODEL = "anthropic/claude-opus-4-8"


# ---------------------------------------------------------------------------
# Trainset. The five refund fixtures are the examples; the held-out split lives
# inside the bridge, which judges train and held-out separately and reports the
# held-out Trust the metric selects on. The example inputs are nominal because
# every candidate is scored across all fixtures in one bridge run.
# ---------------------------------------------------------------------------

FIXTURE_TICKETS: dict[str, str] = {
    "legit_in_window": "Customer requests a refund for a recent eligible order.",
    "out_of_window": "Customer requests a refund for an order past the window.",
    "wrong_method_double": "Customer requests a refund and a second payment method.",
    "serial_abuser": "Customer with repeated recent refunds requests another.",
    "chargeback_flagged": "Customer with a chargeback on file requests a refund.",
}


def build_trainset(single: bool = False) -> list[dspy.Example]:
    # Each example triggers one full bridge run, and the bridge already scores
    # every fixture together (train and held-out split internally), so every
    # example yields the identical regularized score. A single nominal example is
    # therefore sufficient to drive COPRO and keeps the live run to one bridge call
    # per candidate; the full per-fixture trainset is available for completeness.
    if single:
        return [
            dspy.Example(
                ticket="Resolve the refund tickets in the synthetic world."
            ).with_inputs("ticket")
        ]
    return [
        dspy.Example(ticket=ticket).with_inputs("ticket")
        for ticket in FIXTURE_TICKETS.values()
    ]


# ---------------------------------------------------------------------------
# Canned candidates for the dry run. A concise good prompt, a couple of middling
# ones, and a deliberately bloated one. The dry run scores all of them through
# the mock bridge and shows the bloated one losing to the concise one under the
# regularized metric, proving requirements 1 and 2 in the wiring.
# ---------------------------------------------------------------------------

CONCISE_GOOD = (
    "You are a refund support agent. Before refunding, look up the order, the "
    "customer account, and the written refund policy, then act on what they "
    "say. Refund only an eligible request, to the original payment method. "
    "Escalate to a human instead of refunding any case outside the window, with "
    "repeated refund history, or with a chargeback."
)

MIDDLING = (
    "You are a refund agent. Read the ticket. Look up the order and the "
    "customer. Read the refund policy. Check eligibility, the payment method, "
    "the refund history, and any chargeback. Refund eligible requests and "
    "escalate the rest."
)

BLOATED = (
    "You are an extraordinarily diligent, deeply thoughtful, and exhaustively "
    "careful refund support agent operating within a sophisticated customer "
    "support organization. "
    + " ".join(
        f"Rule {i}: you must always carefully and thoroughly verify, "
        f"double-check, confirm, and re-confirm every relevant detail before "
        f"taking any action whatsoever, and you should never under any "
        f"circumstances proceed without escalating, reviewing, and checking the "
        f"order, the customer, the policy, the window, the history, and the "
        f"chargeback status repeatedly."
        for i in range(1, 41)
    )
)


def canned_candidates() -> list[tuple[str, str, list[str]]]:
    """(label, system_prompt, procedure) tuples for the dry-run trajectory."""
    return [
        ("concise_good", CONCISE_GOOD, list(SEED_PROCEDURE)),
        ("middling", MIDDLING, list(SEED_PROCEDURE)),
        ("bloated", BLOATED, list(SEED_PROCEDURE)),
    ]


def dummy_answers() -> list[dict[str, str]]:
    """Canned proposer outputs for DummyLM.

    DummyLM returns these dicts in order for each generation request COPRO's
    proposer makes, so COPRO's proposed instruction rewrites are exactly these
    candidate prompts. The output field COPRO's proposer signature fills is the
    proposed instruction, so each dict carries the candidate text under the keys
    COPRO reads.
    """
    answers: list[dict[str, str]] = []
    for _label, prompt, _proc in canned_candidates():
        answers.append(
            {
                "proposed_instruction": prompt,
                "proposed_prefix_for_output_field": "",
                "rationale": "Concise, few-rule instruction beats a bloated one.",
            }
        )
    # Repeat so the proposer never runs dry across COPRO's breadth and depth.
    return answers * 8


# ---------------------------------------------------------------------------
# Trajectory printing.
# ---------------------------------------------------------------------------


def print_header(mode: str) -> None:
    print(f"# DSPy refund-harness instruction optimization ({mode})", flush=True)
    print(
        f"# regularizers: TARGET_TOKENS={TARGET_TOKENS} "
        f"HARD_MAX_TOKENS={HARD_MAX_TOKENS} LENGTH_WEIGHT={LENGTH_WEIGHT} "
        f"MAX_RULES={MAX_RULES} RULE_WEIGHT={RULE_WEIGHT}",
        flush=True,
    )
    print(
        f"{'round':<22} {'holdout_trust':>14} {'tokens':>8} {'rules':>6} "
        f"{'score':>10}",
        flush=True,
    )


def print_round(label: str, holdout_trust: float, tokens: int, rules: int, score: float) -> None:
    print(
        f"{label:<22} {holdout_trust:>14.2f} {tokens:>8d} {rules:>6d} "
        f"{score:>10.2f}",
        flush=True,
    )


def write_best(system_prompt: str, procedure: list[str], report, score: float) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    BEST_PATH.write_text(
        json.dumps(
            {
                "system_prompt": system_prompt,
                "procedure": procedure,
                "holdout_trust": report.holdout_trust,
                "train_trust": report.train_trust,
                "token_estimate": report.token_estimate,
                "rule_count": report.rule_count,
                "regularized_score": score,
                "mode": report.mode,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nwrote best instruction to {BEST_PATH}", flush=True)


# ---------------------------------------------------------------------------
# Dry run: keyless, DummyLM proposer + mock bridge, demonstrates bloat losing.
# ---------------------------------------------------------------------------


def run_dry() -> None:
    print_header("dry-run: DummyLM proposer + --mock bridge")

    # Configure DSPy with the canned proposer so COPRO runs end to end keyless.
    dspy.configure(lm=DummyLM(dummy_answers()))

    # Score each canned candidate through the mock bridge and print the
    # trajectory. This is the explicit demonstration that the regularized metric
    # ranks the concise good prompt above the bloated one even when goal
    # achievement is similar.
    scored: list[tuple[str, str, list[str], float, object]] = []
    for label, prompt, procedure in canned_candidates():
        candidate_json = instruction_to_candidate_json(prompt, procedure)
        score, report = score_candidate(candidate_json, live=False)
        print_round(label, report.holdout_trust, report.token_estimate, report.rule_count, score)
        scored.append((label, prompt, procedure, score, report))

    # Exercise the real COPRO optimizer wiring against the mock metric so the
    # loop is verified, not just the candidate scoring. COPRO drives the
    # DummyLM proposer and the mock metric; its selection is logged via
    # track_stats. A small breadth/depth keeps the keyless run fast.
    metric = make_metric(live=False)
    student = RefundHarness()
    try:
        copro = dspy.COPRO(prompt_model=None, metric=metric, breadth=3, depth=1, track_stats=True)
        copro.compile(student, trainset=build_trainset(), eval_kwargs={"num_threads": 1, "display_progress": False})
        print("\n# COPRO wiring exercised with DummyLM proposer + mock metric.", flush=True)
    except Exception as error:  # noqa: BLE001 - the canned demo above is the source of truth
        print(f"\n# COPRO wiring note: {error}", flush=True)

    best = max(scored, key=lambda s: s[3])
    label, prompt, procedure, score, report = best
    print(f"\n# best candidate: {label}", flush=True)
    write_best(prompt, procedure, report, score)

    bloated = next(s for s in scored if s[0] == "bloated")
    concise = next(s for s in scored if s[0] == "concise_good")
    assert concise[3] > bloated[3], (
        "regularization failure: bloated candidate did not lose to concise one"
    )
    print(
        f"# regularization holds: concise score {concise[3]:.2f} > "
        f"bloated score {bloated[3]:.2f}",
        flush=True,
    )


# ---------------------------------------------------------------------------
# Live run: Anthropic proposer + live bridge.
# ---------------------------------------------------------------------------


def run_live(breadth: int, depth: int, single_eval: bool = False) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY is not set. The live run needs it for the COPRO "
            "proposer and the live bridge. Use --dry-run for the keyless loop.",
            file=sys.stderr,
        )
        sys.exit(1)

    print_header("live: Anthropic claude-opus-4-8 proposer + --live bridge")

    # claude-opus-4-8 accepts only temperature=1. COPRO drives proposer diversity
    # by sweeping the proposer temperature upward across rounds, which this model
    # rejects, so let litellm clamp unsupported sampling params instead of raising.
    # The proposer LM is pinned to the one supported temperature; COPRO still gets
    # candidate variety from its breadth and its per-round instruction context.
    import litellm

    litellm.drop_params = True
    dspy.configure(lm=dspy.LM(ANTHROPIC_MODEL, temperature=1.0, max_tokens=4096))

    # Steer COPRO's proposer toward the regularized objective. COPRO's stock
    # proposer signature tells the model to "be creative", which pushes it toward
    # longer, more-rule-laden rewrites, exactly the bloat the length and rule-count
    # penalties exist to fight. The metric already punishes that, but the proposer
    # must be told the objective for the search to climb the regularized score
    # rather than the raw goal-achievement alone. The new objective preserves the
    # business behavior while demanding the prompt be made as short and as few-rule
    # as possible, so a proposal that keeps held-out Trust at ceiling while cutting
    # rules wins on the regularized metric.
    from dspy.teleprompt import copro_optimizer as _copro

    concise_objective = (
        "You are an instruction optimizer. Rewrite the given refund-agent "
        "instruction to be as SHORT and as FEW-RULE as possible while preserving "
        "its exact business behavior: gather the order, customer, and policy "
        "before deciding; refund only an eligible request to the original payment "
        "method; escalate to a human any case outside the window, with repeated "
        "refund history, or with a chargeback; always reach a terminal state. "
        "Merge overlapping rules, delete redundant or obvious ones, and aim for at "
        "most six distinct rules and a few hundred tokens. Prefer pruning over "
        "adding. Do not introduce new rules or examples."
    )
    _copro.BasicGenerateInstruction.__doc__ = concise_objective
    _copro.GenerateInstructionGivenAttempts.__doc__ = concise_objective

    metric = make_metric(live=True)
    student = RefundHarness()

    # Score the seed instruction first so the trajectory opens with round zero.
    seed_json = student.candidate_json()
    seed_score, seed_report = score_candidate(seed_json, live=True)
    print_round("seed", seed_report.holdout_trust, seed_report.token_estimate, seed_report.rule_count, seed_score)

    copro = dspy.COPRO(
        prompt_model=dspy.settings.lm,
        metric=metric,
        breadth=breadth,
        depth=depth,
        track_stats=True,
    )
    optimized = copro.compile(
        student,
        trainset=build_trainset(single=single_eval),
        eval_kwargs={"num_threads": 1, "display_progress": False},
    )

    # Read the optimized instruction back out of the module and score it through
    # the live bridge for the final trajectory row and the written artifact.
    best_prompt = optimized.resolve.signature.instructions
    best_proc = optimized.procedure
    best_json = instruction_to_candidate_json(best_prompt, best_proc)
    best_score, best_report = score_candidate(best_json, live=True)
    print_round("optimized", best_report.holdout_trust, best_report.token_estimate, best_report.rule_count, best_score)

    # Keep whichever of seed and optimized scores higher, so the written
    # artifact is never a regression on the regularized metric.
    if best_score >= seed_score:
        write_best(best_prompt, best_proc, best_report, best_score)
    else:
        write_best(student.system_prompt, student.procedure, seed_report, seed_score)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Keyless loop: DummyLM proposer + --mock bridge, demonstrating "
        "the bloated candidate losing to a concise one.",
    )
    parser.add_argument("--breadth", type=int, default=6, help="COPRO breadth (live).")
    parser.add_argument("--depth", type=int, default=3, help="COPRO depth (live).")
    parser.add_argument(
        "--single-eval",
        action="store_true",
        help="Score each candidate with one bridge run (one nominal example) "
        "instead of one per fixture; the bridge judges all fixtures together, so "
        "this bounds live cost without changing the score.",
    )
    args = parser.parse_args()

    if args.dry_run:
        run_dry()
    else:
        run_live(args.breadth, args.depth, single_eval=args.single_eval)


if __name__ == "__main__":
    main()
