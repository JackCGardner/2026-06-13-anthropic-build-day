"""The regularized multi-objective metric DSPy maximizes for the loan harness.

This is the loan analog of metric.py. The optimizer improves the underwriting
instruction so the agent climbs the loan judge's six-dimension nonlinear
aggregate (risk-adjusted yield subject to fair-lending and rationale-quality
constraints), under the SAME two brevity regularizers the refund pack uses, so
the prompt stays short and the rule set small:

    score = aggregate
            - LENGTH_WEIGHT * length_penalty(token_estimate)
            - RULE_WEIGHT   * rule_penalty(rule_count)

aggregate is the loan judge's headline 0-100 score. The length and rule-count
penalties are imported verbatim from metric.py so the two packs share one
regularizer definition and one set of tunable constants; only the goal-
achievement signal differs (the loan multi-objective aggregate instead of the
refund held-out Trust). token_estimate and rule_count come from the loan bridge
and are faithful to the real candidate text in both the live and the mock bridge,
so the regularizers behave identically whether the goal signal came from the live
model or the keyless mock.

Goal achievement is produced by the loan TS bridge (scripts/evaluate-loan.ts),
which runs the candidate across the loan eval sample, judges the portfolio with
the real multi-objective judge, and reports the aggregate plus the full per-
dimension breakdown, the economic core, the disparity, and the tripped
constraints.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import dspy

# Reuse the refund pack's regularizers verbatim: one definition of the length and
# rule-count penalties and their tunable constants serves both packs.
from dspy_optimizer.metric import (
    HARD_MAX_TOKENS,  # re-exported for the optimizer header  # noqa: F401
    LENGTH_WEIGHT,
    MAX_RULES,  # noqa: F401
    RULE_WEIGHT,
    TARGET_TOKENS,  # noqa: F401
    length_penalty,
    rule_penalty,
)


# ---------------------------------------------------------------------------
# Calling the loan TS evaluate bridge.
# ---------------------------------------------------------------------------

REPO_ROOT: Path = Path(__file__).resolve().parents[2]
TSX_BIN: Path = REPO_ROOT / "node_modules" / ".bin" / "tsx"
EVALUATE_SCRIPT: Path = REPO_ROOT / "scripts" / "evaluate-loan.ts"


@dataclass(frozen=True)
class LoanBridgeReport:
    """The fields of the loan bridge report the metric reads.

    aggregate is the goal-achievement signal the optimizer maximizes; the rest is
    the multi-objective breakdown surfaced in the trajectory so it is visible why
    a candidate scored as it did (a high-yield book that tripped fairness reads
    very differently from a balanced one).
    """

    mode: str
    aggregate: float
    risk_adjusted_yield: float
    disparity: float
    constraint_penalty: float
    tripped_constraints: list[str]
    per_dimension: dict[str, float]
    token_estimate: int
    rule_count: int
    eval_sample_size: int
    raw: dict[str, Any] = field(default_factory=dict)


def run_loan_bridge(
    candidate_json: str,
    *,
    live: bool,
    eval_sample: int | None = None,
    max_turns: int | None = None,
    held_out: bool = False,
) -> LoanBridgeReport:
    """Run the loan TS evaluate bridge on a candidate and parse its JSON report.

    The bridge prints exactly one JSON object on stdout (diagnostics go to
    stderr), so stdout is parsed directly. A nonzero exit or an error payload
    raises, which the metric turns into a failing score rather than crashing the
    run. eval_sample bounds the live inner loop; held_out scores the headline
    population for a final report.
    """
    mode_flag = "--live" if live else "--mock"
    cmd = [str(TSX_BIN), str(EVALUATE_SCRIPT), mode_flag, "--instruction", candidate_json]
    if eval_sample is not None:
        cmd += ["--eval-sample", str(eval_sample)]
    if max_turns is not None:
        cmd += ["--max-turns", str(max_turns)]
    if held_out:
        cmd += ["--held-out"]

    proc = subprocess.run(
        cmd,
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        env=os.environ.copy(),
    )
    stdout = proc.stdout.strip()
    if not stdout:
        raise RuntimeError(
            f"loan evaluate bridge produced no output (exit {proc.returncode}): "
            f"{proc.stderr.strip()}"
        )
    payload = json.loads(stdout)
    if "error" in payload:
        raise RuntimeError(
            f"loan evaluate bridge error: {payload.get('error')}: "
            f"{payload.get('message', '')}"
        )
    goal = payload["goal_achievement"]
    cost = payload["prompt_cost"]
    return LoanBridgeReport(
        mode=payload["mode"],
        aggregate=float(goal["aggregate"]),
        risk_adjusted_yield=float(goal["risk_adjusted_yield"]),
        disparity=float(goal["disparity"]),
        constraint_penalty=float(goal["constraint_penalty"]),
        tripped_constraints=list(goal.get("tripped_constraints", [])),
        per_dimension={k: float(v) for k, v in goal["per_dimension"].items()},
        token_estimate=int(cost["token_estimate"]),
        rule_count=int(cost["rule_count"]),
        eval_sample_size=int(payload.get("eval_sample_size", 0)),
        raw=payload,
    )


def loan_regularized_score(report: LoanBridgeReport) -> float:
    """The score the optimizer maximizes: the multi-objective aggregate minus both
    brevity penalties (shared with the refund pack)."""
    return (
        report.aggregate
        - LENGTH_WEIGHT * length_penalty(report.token_estimate)
        - RULE_WEIGHT * rule_penalty(report.rule_count)
    )


def score_loan_candidate(
    candidate_json: str,
    *,
    live: bool,
    eval_sample: int | None = None,
    max_turns: int | None = None,
    held_out: bool = False,
) -> tuple[float, LoanBridgeReport]:
    """Score a loan candidate instruction end to end through the bridge."""
    report = run_loan_bridge(
        candidate_json,
        live=live,
        eval_sample=eval_sample,
        max_turns=max_turns,
        held_out=held_out,
    )
    return loan_regularized_score(report), report


# ---------------------------------------------------------------------------
# The DSPy metric callable. Duck-typed: metric(example, prediction, trace=None).
# The prediction carries the candidate instruction (its candidate_json); the
# example is unused because the whole eval sample is scored together in one bridge
# run, which is what gives the multi-objective aggregate its portfolio meaning.
# ---------------------------------------------------------------------------


def make_loan_metric(
    *,
    live: bool,
    eval_sample: int | None = None,
    max_turns: int | None = None,
):
    """Build the loan metric callable bound to the live or mock bridge mode."""

    floor = -1.0 * (LENGTH_WEIGHT + 100.0)

    def metric(example: Any, prediction: Any, trace: Any = None) -> float:
        candidate_json = getattr(prediction, "candidate_json", None)
        if candidate_json is None:
            return floor
        try:
            score, _report = score_loan_candidate(
                candidate_json,
                live=live,
                eval_sample=eval_sample,
                max_turns=max_turns,
            )
        except Exception as error:  # noqa: BLE001 - a bad candidate must not crash the run
            dspy.logger.warning(f"loan metric: candidate scoring failed: {error}")
            return floor
        return score

    return metric
