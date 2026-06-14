"""The regularized goal-achievement metric DSPy maximizes.

The optimizer's job is to improve the harness instruction so the agent does the
right thing for the business goal, judged in the synthetic refund world. The
reward is the judge's held-out Trust Score (goal achievement). Two regularizers
are first class, not optional, because prompt optimizers tend to "improve" by
endlessly appending rules and ballooning the prompt:

  1. PROMPT LENGTH PENALTY. Long prompts are bad. A soft target keeps short
     prompts free; past it the penalty ramps; past a hard ceiling it is severe,
     so a near-20k-token prompt scores terribly even at perfect goal
     achievement.
  2. RULE-COUNT PENALTY. Few rules are better. Beyond a small rule budget the
     penalty grows, so among candidates with equal goal achievement the
     optimizer prefers rewriting and pruning over appending.

The metric is therefore:

    score = holdout_trust
            - LENGTH_WEIGHT * length_penalty(token_estimate)
            - RULE_WEIGHT   * rule_penalty(rule_count)

holdout_trust is on the judge's 0-100 scale. Both penalties are also expressed
in points off that 0-100 scale so the weights read directly: a candidate that
overshoots the token target by the whole soft band, or that runs a few rules
over budget, loses a tunable handful of points; a candidate near the hard
ceiling loses almost everything. The net effect is that a concise, few-rule
instruction that hits the goal beats a long, many-rule instruction that hits the
same goal.

Goal achievement is produced by the TS bridge (scripts/evaluate.ts), which runs
the candidate across the refund fixtures and judges it. token_estimate and
rule_count come from the same bridge and are faithful to the real candidate text
in both the live and the mock bridge, so the regularizers behave identically
whether the goal signal came from the live model or the keyless mock.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import dspy


# ---------------------------------------------------------------------------
# Regularization constants. Named and prominent so they are easy to tune. All
# penalties are denominated in points off the 0-100 Trust scale.
# ---------------------------------------------------------------------------

# Soft token target. At or below this the length penalty is zero: a concise
# instruction of a few hundred tokens pays nothing for its length.
TARGET_TOKENS: int = 500

# Hard token ceiling. Past this the penalty is severe and grows fast, so a
# prompt anywhere near 20k tokens is a failure regardless of goal achievement.
HARD_MAX_TOKENS: int = 1500

# Weight on the length penalty. length_penalty returns a value in roughly [0, 1]
# under the soft band and climbs without bound past the hard ceiling, so this is
# the maximum points a candidate loses for sitting right at the hard ceiling, and
# overshooting the ceiling drives the score deeply negative.
LENGTH_WEIGHT: float = 60.0

# Rule budget. At or below this the rule-count penalty is zero. A handful of
# crisp rules covers the refund task; more than this is bloat.
MAX_RULES: int = 6

# Points lost per rule beyond the budget. A candidate a few rules over budget
# loses a meaningful but recoverable amount; a 60-rule prompt loses far more than
# any goal achievement can repay.
RULE_WEIGHT: float = 4.0


def length_penalty(token_estimate: int) -> float:
    """Penalty factor for prompt length, in [0, +inf).

    Zero at or below TARGET_TOKENS. Between the target and the hard ceiling it
    ramps linearly from 0 to 1 (a candidate at the ceiling pays the full
    LENGTH_WEIGHT). Past the hard ceiling it keeps climbing at twice the soft
    slope, so overshooting toward a near-20k-token prompt is catastrophic.
    """
    if token_estimate <= TARGET_TOKENS:
        return 0.0
    soft_band = max(1, HARD_MAX_TOKENS - TARGET_TOKENS)
    if token_estimate <= HARD_MAX_TOKENS:
        return (token_estimate - TARGET_TOKENS) / soft_band
    overshoot = (token_estimate - HARD_MAX_TOKENS) / soft_band
    return 1.0 + 2.0 * overshoot


def rule_penalty(rule_count: int) -> float:
    """Penalty for the number of distinct rules, in [0, +inf).

    Zero at or below MAX_RULES, then grows linearly with each rule over budget.
    Multiplied by RULE_WEIGHT this turns into points off the Trust scale, so the
    optimizer prefers pruning redundant rules to appending new ones.
    """
    if rule_count <= MAX_RULES:
        return 0.0
    return float(rule_count - MAX_RULES)


@dataclass(frozen=True)
class BridgeReport:
    """The fields of the TS bridge report the metric reads."""

    mode: str
    holdout_trust: float
    train_trust: float
    technical_pass_rate: float
    token_estimate: int
    rule_count: int
    raw: dict[str, Any]


# ---------------------------------------------------------------------------
# Calling the TS evaluate bridge.
# ---------------------------------------------------------------------------

# The repo root (two levels up from this file: py/dspy_optimizer/metric.py).
REPO_ROOT: Path = Path(__file__).resolve().parents[2]
TSX_BIN: Path = REPO_ROOT / "node_modules" / ".bin" / "tsx"
EVALUATE_SCRIPT: Path = REPO_ROOT / "scripts" / "evaluate.ts"


def run_bridge(candidate_json: str, *, live: bool) -> BridgeReport:
    """Run the TS evaluate bridge on a candidate and parse its JSON report.

    The bridge prints exactly one JSON object on stdout (diagnostics go to
    stderr), so stdout is parsed directly. A nonzero exit or an error payload
    raises, which the metric turns into a failing score rather than crashing the
    optimization run.
    """
    mode_flag = "--live" if live else "--mock"
    cmd = [
        str(TSX_BIN),
        str(EVALUATE_SCRIPT),
        mode_flag,
        "--instruction",
        candidate_json,
    ]
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
            f"evaluate bridge produced no output (exit {proc.returncode}): "
            f"{proc.stderr.strip()}"
        )
    payload = json.loads(stdout)
    if "error" in payload:
        raise RuntimeError(
            f"evaluate bridge error: {payload.get('error')}: "
            f"{payload.get('message', '')}"
        )
    goal = payload["goal_achievement"]
    cost = payload["prompt_cost"]
    return BridgeReport(
        mode=payload["mode"],
        holdout_trust=float(goal["holdout_trust"]),
        train_trust=float(goal["train_trust"]),
        technical_pass_rate=float(goal["technical_pass_rate"]),
        token_estimate=int(cost["token_estimate"]),
        rule_count=int(cost["rule_count"]),
        raw=payload,
    )


def regularized_score(report: BridgeReport) -> float:
    """The score the optimizer maximizes: held-out Trust minus both penalties."""
    return (
        report.holdout_trust
        - LENGTH_WEIGHT * length_penalty(report.token_estimate)
        - RULE_WEIGHT * rule_penalty(report.rule_count)
    )


def score_candidate(candidate_json: str, *, live: bool) -> tuple[float, BridgeReport]:
    """Score a candidate instruction end to end through the bridge."""
    report = run_bridge(candidate_json, live=live)
    return regularized_score(report), report


# ---------------------------------------------------------------------------
# The DSPy metric callable.
# ---------------------------------------------------------------------------
#
# DSPy metrics are duck-typed: metric(example, prediction, trace=None) -> number.
# The prediction carries the candidate instruction (its `candidate_json`); the
# example is unused because every fixture is scored together inside the bridge in
# one run, which is what gives the held-out split its independent Trust Score.
# The factory binds the live/mock choice so optimize.py can pass one callable to
# COPRO and dspy.Evaluate.


def make_metric(*, live: bool):
    """Build the metric callable bound to the live or mock bridge mode."""

    def metric(example: Any, prediction: Any, trace: Any = None) -> float:
        candidate_json = getattr(prediction, "candidate_json", None)
        if candidate_json is None:
            # COPRO scores a candidate by running the optimized module, whose
            # prediction always carries candidate_json; if it is absent the
            # candidate is malformed and scores at the floor.
            return -1.0 * (LENGTH_WEIGHT + 100.0)
        try:
            score, _report = score_candidate(candidate_json, live=live)
        except Exception as error:  # noqa: BLE001 - a bad candidate must not crash the run
            dspy.logger.warning(f"metric: candidate scoring failed: {error}")
            return -1.0 * (LENGTH_WEIGHT + 100.0)
        return score

    return metric
