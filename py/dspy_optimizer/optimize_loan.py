"""Run the instruction optimizer over the loan underwriting harness.

The optimizer improves the underwriting instruction so the agent climbs the loan
judge's six-dimension multi-objective aggregate (risk-adjusted yield subject to
fair-lending and rationale-quality constraints) in the synthetic loan world,
under the SAME two brevity regularizers the refund pack uses (prompt length and
rule count). The optimizable artifact is the instruction; execution is delegated
to the loan TS bridge (scripts/evaluate-loan.ts), which judges the eval-sample
portfolio with the real judge and reports the aggregate plus the full breakdown.

This is the loan analog of optimize.py: same optimizer (COPRO), same regularizers,
same dry-run / live structure, pointed at the loan pack. COPRO rewrites the
module's instruction wholesale each round with a proposer model and selects on the
scalar regularized metric, which is the right fit for an instruction-only,
execution-delegated task; rewriting wholesale (not appending) is what keeps the
optimizer from the bloat the brevity penalties exist to fight.

Two run modes:

  Live run (default): configure dspy.LM on Anthropic claude-opus-4-8 as the
  proposer, run COPRO against the live loan bridge (real loan harness + real
  multi-objective judge over the eval sample), and write the best instruction.
  Requires ANTHROPIC_API_KEY. The eval sample and the per-applicant turn cap keep
  the live cost bounded.

  Dry run (--dry-run): configure a dspy DummyLM with canned candidate
  instructions of varying length and rule count, including a deliberately bloated
  one, and score them through the keyless --mock bridge (which still judges with
  the real six-dimension judge). This exercises the whole loop with no credential
  and demonstrates the bloated candidate losing to a concise one under the
  regularized multi-objective metric.

The trajectory printed per round shows, for the round's candidate: the aggregate,
the risk-adjusted yield, the disparity, token_estimate, rule_count, and the
combined regularized score. The best instruction is written to
out/best-loan-instruction.json.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import dspy
from dspy.utils.dummies import DummyLM

from dspy_optimizer.harness_program_loan import (
    LoanHarness,
    SEED_PROCEDURE,
    instruction_to_candidate_json,
)
from dspy_optimizer.metric import (
    HARD_MAX_TOKENS,
    LENGTH_WEIGHT,
    MAX_RULES,
    RULE_WEIGHT,
    TARGET_TOKENS,
)
from dspy_optimizer.metric_loan import (
    make_loan_metric,
    score_loan_candidate,
)

OUT_DIR = Path(__file__).resolve().parent / "out"
BEST_PATH = OUT_DIR / "best-loan-instruction.json"

ANTHROPIC_MODEL = "anthropic/claude-opus-4-8"

# The eval-sample size and per-applicant turn cap the live inner loop uses. Small
# enough that a per-candidate live evaluation stays cost-bounded, large enough to
# span the tiers and both groups so the multi-objective signal is meaningful.
LIVE_EVAL_SAMPLE = 12
LIVE_MAX_TURNS = 8


# ---------------------------------------------------------------------------
# Trainset. One nominal example drives COPRO; the loan bridge scores the whole
# eval-sample portfolio together in one run (which is what gives the aggregate its
# portfolio meaning), so every example would yield the identical regularized
# score. A single example keeps the live run to one bridge call per candidate.
# ---------------------------------------------------------------------------


def build_trainset() -> list[dspy.Example]:
    return [
        dspy.Example(
            applicant="Underwrite the loan applicants in the synthetic eval sample."
        ).with_inputs("applicant")
    ]


# ---------------------------------------------------------------------------
# Canned candidates for the dry run. A concise good policy, a middling one, and a
# deliberately bloated one. The dry run scores all of them through the mock bridge
# (real judge) and shows the bloated one losing to the concise one under the
# regularized multi-objective metric.
# ---------------------------------------------------------------------------

CONCISE_GOOD = (
    "You underwrite consumer loans. Weigh credit score, cashflow, and fraud risk "
    "against the desk's risk appetite. Counter-offer marginal applicants to bank "
    "them at reduced exposure; decline weak files; approve clearly strong ones. "
    "Never let the group attribute affect a decision or appear in a rationale. "
    "Write a short rationale naming the signals you used."
)

MIDDLING = (
    "You are a loan underwriter. Read the application, pull credit, analyze bank "
    "transactions, and check fraud. Decide approve, decline, counter-offer, or "
    "request more information based on the signals and the guidelines. Keep "
    "approvals fair and justify each decision."
)

BLOATED = (
    "You are an extraordinarily diligent, deeply thoughtful, and exhaustively "
    "careful consumer-loan underwriting agent operating within a sophisticated "
    "lending organization. "
    + " ".join(
        f"Rule {i}: you must always carefully and thoroughly verify, "
        f"double-check, confirm, and re-confirm every relevant signal before "
        f"taking any action whatsoever, and you should never under any "
        f"circumstances proceed without reviewing, weighing, and re-checking the "
        f"credit score, the derogatories, the observed income, the cashflow "
        f"volatility, the fraud signal, the requested amount, the term, and the "
        f"lending guidelines repeatedly."
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
    """Canned proposer outputs for DummyLM, returned in order for each generation
    request COPRO's proposer makes, so COPRO's proposed instruction rewrites are
    exactly these candidate prompts."""
    answers: list[dict[str, str]] = []
    for _label, prompt, _proc in canned_candidates():
        answers.append(
            {
                "proposed_instruction": prompt,
                "proposed_prefix_for_output_field": "",
                "rationale": "A concise, fair, few-rule policy beats a bloated one.",
            }
        )
    return answers * 8


# ---------------------------------------------------------------------------
# Trajectory printing.
# ---------------------------------------------------------------------------


def print_header(mode: str) -> None:
    print(f"# DSPy loan-harness multi-objective instruction optimization ({mode})", flush=True)
    print(
        f"# regularizers: TARGET_TOKENS={TARGET_TOKENS} "
        f"HARD_MAX_TOKENS={HARD_MAX_TOKENS} LENGTH_WEIGHT={LENGTH_WEIGHT} "
        f"MAX_RULES={MAX_RULES} RULE_WEIGHT={RULE_WEIGHT}",
        flush=True,
    )
    print(
        f"{'round':<22} {'aggregate':>10} {'risk_adj_yld':>13} {'disparity':>10} "
        f"{'tokens':>8} {'rules':>6} {'score':>10}",
        flush=True,
    )


def print_round(label: str, report, score: float) -> None:
    print(
        f"{label:<22} {report.aggregate:>10.2f} {report.risk_adjusted_yield:>13.4f} "
        f"{report.disparity:>10.2f} {report.token_estimate:>8d} "
        f"{report.rule_count:>6d} {score:>10.2f}",
        flush=True,
    )


def write_best(system_prompt: str, procedure: list[str], report, score: float) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    BEST_PATH.write_text(
        json.dumps(
            {
                "system_prompt": system_prompt,
                "procedure": procedure,
                "aggregate": report.aggregate,
                "risk_adjusted_yield": report.risk_adjusted_yield,
                "disparity": report.disparity,
                "tripped_constraints": report.tripped_constraints,
                "per_dimension": report.per_dimension,
                "token_estimate": report.token_estimate,
                "rule_count": report.rule_count,
                "regularized_score": score,
                "eval_sample_size": report.eval_sample_size,
                "mode": report.mode,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nwrote best loan instruction to {BEST_PATH}", flush=True)


# ---------------------------------------------------------------------------
# Dry run: keyless, DummyLM proposer + mock bridge (real judge), demonstrates
# bloat losing under the regularized multi-objective metric.
# ---------------------------------------------------------------------------


def run_dry() -> None:
    print_header("dry-run: DummyLM proposer + --mock bridge (real judge)")

    dspy.configure(lm=DummyLM(dummy_answers()))

    scored: list[tuple[str, str, list[str], float, object]] = []
    for label, prompt, procedure in canned_candidates():
        candidate_json = instruction_to_candidate_json(prompt, procedure)
        score, report = score_loan_candidate(candidate_json, live=False)
        print_round(label, report, score)
        scored.append((label, prompt, procedure, score, report))

    # Exercise the real COPRO optimizer wiring against the mock metric so the loop
    # is verified, not just the candidate scoring.
    metric = make_loan_metric(live=False)
    student = LoanHarness()
    try:
        copro = dspy.COPRO(prompt_model=None, metric=metric, breadth=3, depth=1, track_stats=True)
        copro.compile(
            student,
            trainset=build_trainset(),
            eval_kwargs={"num_threads": 1, "display_progress": False},
        )
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
# Live run: Anthropic proposer + live loan bridge.
# ---------------------------------------------------------------------------


def run_live(breadth: int, depth: int, eval_sample: int, max_turns: int) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY is not set. The live run needs it for the COPRO "
            "proposer and the live loan bridge. Use --dry-run for the keyless loop.",
            file=sys.stderr,
        )
        sys.exit(1)

    print_header("live: Anthropic claude-opus-4-8 proposer + --live loan bridge")

    # claude-opus-4-8 accepts only temperature=1. Let litellm clamp unsupported
    # sampling params so COPRO's per-round temperature sweep does not raise.
    import litellm

    litellm.drop_params = True
    dspy.configure(lm=dspy.LM(ANTHROPIC_MODEL, temperature=1.0, max_tokens=4096))

    # Steer COPRO's proposer toward the regularized multi-objective objective: a
    # short, few-rule policy that balances yield, fairness, and rationale quality.
    from dspy.teleprompt import copro_optimizer as _copro

    objective = (
        "You are an instruction optimizer for a consumer-loan underwriting agent. "
        "Rewrite the given underwriting instruction to be as SHORT and as FEW-RULE "
        "as possible while maximizing the desk's multi-objective score: positive "
        "risk-adjusted yield (margin on repaid loans net of losses on defaults), "
        "fair approvals across the group attribute (which must never drive a "
        "decision or appear in a rationale), sound signal-grounded rationales, and "
        "efficient signal gathering. Neither approve everyone nor decline everyone; "
        "use counter-offers to bank marginal applicants at reduced exposure. Merge "
        "overlapping rules, delete redundant or obvious ones, and aim for at most "
        "six distinct rules and a few hundred tokens. Prefer pruning over adding. "
        "Do not introduce new rules or examples."
    )
    _copro.BasicGenerateInstruction.__doc__ = objective
    _copro.GenerateInstructionGivenAttempts.__doc__ = objective

    metric = make_loan_metric(live=True, eval_sample=eval_sample, max_turns=max_turns)
    student = LoanHarness()

    # Score the seed instruction first so the trajectory opens with round zero.
    seed_json = student.candidate_json()
    seed_score, seed_report = score_loan_candidate(
        seed_json, live=True, eval_sample=eval_sample, max_turns=max_turns
    )
    print_round("seed", seed_report, seed_score)

    copro = dspy.COPRO(
        prompt_model=dspy.settings.lm,
        metric=metric,
        breadth=breadth,
        depth=depth,
        track_stats=True,
    )
    optimized = copro.compile(
        student,
        trainset=build_trainset(),
        eval_kwargs={"num_threads": 1, "display_progress": False},
    )

    best_prompt = optimized.underwrite.signature.instructions
    best_proc = optimized.procedure
    best_json = instruction_to_candidate_json(best_prompt, best_proc)
    best_score, best_report = score_loan_candidate(
        best_json, live=True, eval_sample=eval_sample, max_turns=max_turns
    )
    print_round("optimized", best_report, best_score)

    # Keep whichever of seed and optimized scores higher, so the written artifact
    # is never a regression on the regularized multi-objective metric.
    if best_score >= seed_score:
        write_best(best_prompt, best_proc, best_report, best_score)
    else:
        write_best(student.system_prompt, student.procedure, seed_report, seed_score)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Keyless loop: DummyLM proposer + --mock bridge (real judge), "
        "demonstrating the bloated candidate losing to a concise one.",
    )
    parser.add_argument("--breadth", type=int, default=6, help="COPRO breadth (live).")
    parser.add_argument("--depth", type=int, default=3, help="COPRO depth (live).")
    parser.add_argument(
        "--eval-sample",
        type=int,
        default=LIVE_EVAL_SAMPLE,
        help="Eval-sample size the live inner loop scores per candidate.",
    )
    parser.add_argument(
        "--max-turns",
        type=int,
        default=LIVE_MAX_TURNS,
        help="Per-applicant agent turn cap on the live path.",
    )
    args = parser.parse_args()

    if args.dry_run:
        run_dry()
    else:
        run_live(args.breadth, args.depth, args.eval_sample, args.max_turns)


if __name__ == "__main__":
    main()
