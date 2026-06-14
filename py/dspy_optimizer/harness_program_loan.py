"""The DSPy module whose optimizable artifact is the loan underwriting
instruction.

The underwriting agent itself runs in TypeScript: the live Agent SDK loan harness
drives the synthetic loan world over the loan function tools and the six-dimension
multi-objective judge scores the portfolio. DSPy never executes that agent here.
What DSPy optimizes is the natural-language instruction the harness is given,
which lives as the `instructions` of a `dspy.Signature`. COPRO rewrites those
instructions wholesale each round, the loan TS bridge runs the candidate across
the eval sample and reports the multi-objective aggregate, and the regularized
metric selects the variant that climbs the aggregate with the fewest, shortest
rules.

This mirrors harness_program.py for the refund pack; only the seed instruction
and the task framing differ, because the loan problem has four terminal actions,
genuine tradeoffs, and no single right answer per applicant.
"""

from __future__ import annotations

import json

import dspy


# A decent starting underwriting instruction: competent but under-specified, the
# seed the optimizer improves. It names no thresholds and no single right action,
# because the multi-objective tradeoffs (risk-adjusted yield vs fairness vs
# rationale quality vs info efficiency) are exactly what the optimizer has to
# learn to balance. It mirrors LOAN_SEED_SYSTEM_PROMPT in the TS harness so a
# dry run and a live run open from the same place.
SEED_SYSTEM_PROMPT: str = (
    "You are an underwriting agent for a consumer lending desk. For each "
    "applicant, gather the signals that matter, weigh them against the desk's "
    "lending guidelines and risk appetite, and reach one terminal decision: "
    "approve, decline, counter-offer (a smaller or shorter loan for a marginal "
    "applicant), or request more information. The desk earns a thin interest "
    "margin on loans that repay and loses principal on loans that default, so "
    "neither approving everyone nor declining everyone is sound: price risk and "
    "use the counter-offer to bank marginal applicants at reduced exposure. The "
    "group attribute on the application is for reporting only and must never "
    "influence a decision or appear in a rationale. Write a short rationale that "
    "names the signals you relied on and is consistent with the action you took."
)

SEED_PROCEDURE: list[str] = [
    "Read the application to understand the requested amount, term, and purpose.",
    "Pull the credit report, analyze bank transactions, and check the fraud signal.",
    "Read the lending guidelines and weigh the signals against the risk appetite.",
    "Decide approve, decline, counter-offer, or request more information, and "
    "submit the decision with a short rationale naming the signals you used.",
]


def instruction_to_candidate_json(system_prompt: str, procedure: list[str]) -> str:
    """Serialize an instruction to the JSON shape the loan TS bridge expects."""
    return json.dumps({"system_prompt": system_prompt, "procedure": procedure})


class UnderwriteLoan(dspy.Signature):
    """Underwrite a consumer loan application the way the desk intends.

    Gather the credit report, bank transactions, fraud signal, and lending
    guidelines, then choose one terminal action: approve, decline, counter-offer,
    or request more information. Price risk so the portfolio earns a positive
    risk-adjusted yield; neither approve everyone nor decline everyone. Keep
    approvals fair across the group attribute, which must never drive a decision.
    Write a short, signal-grounded rationale consistent with the action. Keep the
    instruction concise: prefer rewriting and pruning rules over appending new
    ones.
    """

    applicant: str = dspy.InputField(
        desc="The loan applicant to underwrite."
    )
    decision: str = dspy.OutputField(
        desc="The terminal action and the rationale for it."
    )


class LoanHarness(dspy.Module):
    """Carries the loan underwriting instruction COPRO optimizes.

    The module holds a single `dspy.Predict` over `UnderwriteLoan`. That
    predictor's signature `instructions` is the optimizable instruction: COPRO
    proposes rewrites of it. The fixed procedure travels alongside the instruction
    so the loan TS bridge always receives a complete candidate; the search surface
    is the instruction prose, which is where the underwriting policy lives.
    """

    def __init__(self, procedure: list[str] | None = None) -> None:
        super().__init__()
        self.underwrite = dspy.Predict(UnderwriteLoan)
        self.underwrite.signature = self.underwrite.signature.with_instructions(
            SEED_SYSTEM_PROMPT
        )
        self.procedure = (
            list(procedure) if procedure is not None else list(SEED_PROCEDURE)
        )

    @property
    def system_prompt(self) -> str:
        """The current optimizable system prompt: the predictor's instruction."""
        return self.underwrite.signature.instructions

    def candidate_json(self) -> str:
        """The current instruction as the JSON candidate the loan bridge scores."""
        return instruction_to_candidate_json(self.system_prompt, self.procedure)

    def forward(self, applicant: str) -> dspy.Prediction:
        # Execution is delegated to the loan TS bridge, so the module does not call
        # a model to underwrite. It returns the current instruction text as the
        # prediction; the metric reads it, runs it through the bridge, and scores
        # the multi-objective achievement of that instruction.
        return dspy.Prediction(
            decision=self.system_prompt,
            system_prompt=self.system_prompt,
            procedure=self.procedure,
            candidate_json=self.candidate_json(),
        )
