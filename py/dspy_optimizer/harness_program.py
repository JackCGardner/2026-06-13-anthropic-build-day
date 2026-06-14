"""The DSPy module whose optimizable artifact is the harness instruction.

The refund-resolution agent itself runs in TypeScript: the live Agent SDK
harness drives the synthetic world and the deterministic judge scores the run.
DSPy never executes that agent here. What DSPy optimizes is the natural-language
instruction the harness is given, which lives as the `instructions` of a
`dspy.Signature`. COPRO rewrites those instructions wholesale each round, the TS
bridge runs the candidate and reports goal achievement, and the regularized
metric selects the variant that does the right thing for the goal with the
fewest, shortest rules.

The module's `forward` returns the current instruction text (system prompt plus
procedure) as its prediction. The metric reads that text, ships it to the TS
bridge, and turns the bridge's report into the score the optimizer maximizes.
"""

from __future__ import annotations

import json

import dspy


# A decent starting instruction: a reasonable refund-resolution prompt that
# attempts the job. It tells the agent to gather the order, the customer, and the
# written policy before acting and to escalate the cases that must not be
# auto-refunded. This is deliberately competent, not crippled, so the optimizer
# starts from a real prompt and improves it rather than rescuing a broken one.
SEED_SYSTEM_PROMPT: str = (
    "You are a refund support agent for an online store. Resolve each ticket "
    "by deciding whether to issue a refund or route the case to a human. "
    "Before issuing any refund, look up the order, look up the customer "
    "account, and read the written refund policy, then act on what they say. "
    "Issue a refund only for an eligible request and only to the original "
    "payment method. Escalate to a human instead of refunding whenever the "
    "case falls outside the eligibility window, shows a history of repeated "
    "refunds, or carries a chargeback. Always reach a terminal state on the "
    "ticket."
)

SEED_PROCEDURE: list[str] = [
    "Read the ticket to understand the customer's request.",
    "Look up the order and the customer account.",
    "Read the refund policy and check the request against it.",
    "If the request is eligible, issue the refund to the original payment "
    "method; otherwise escalate to a human with a brief reason.",
    "Reply to the customer and mark the ticket resolved.",
]


def instruction_to_candidate_json(system_prompt: str, procedure: list[str]) -> str:
    """Serialize an instruction to the JSON shape the TS bridge expects."""
    return json.dumps({"system_prompt": system_prompt, "procedure": procedure})


class ResolveRefund(dspy.Signature):
    """Resolve a customer refund ticket the way the business intends.

    Look up the order, the customer, and the written refund policy before
    acting. Issue a refund only for an eligible request and only to the original
    payment method. Escalate to a human instead of refunding any case outside
    the eligibility window, with repeated refund history, or with a chargeback.
    Always reach a terminal state on the ticket. Keep the instruction concise:
    prefer rewriting and pruning rules over appending new ones.
    """

    ticket: str = dspy.InputField(
        desc="The customer's refund request ticket to resolve."
    )
    resolution: str = dspy.OutputField(
        desc="The refund decision and the action taken on the ticket."
    )


class RefundHarness(dspy.Module):
    """Carries the harness instruction COPRO optimizes.

    The module holds a single `dspy.Predict` over `ResolveRefund`. That
    predictor's signature `instructions` is the optimizable instruction: COPRO
    proposes rewrites of it. The fixed procedure travels alongside the
    instruction so the TS bridge always receives a complete candidate; the
    optimizer's search surface is the instruction prose, which is where the
    business intent and the rule set live.
    """

    def __init__(self, procedure: list[str] | None = None) -> None:
        super().__init__()
        self.resolve = dspy.Predict(ResolveRefund)
        # Seed the predictor's instruction with the decent starting prompt so
        # round zero is a real attempt at the goal, not the bare docstring.
        self.resolve.signature = self.resolve.signature.with_instructions(
            SEED_SYSTEM_PROMPT
        )
        self.procedure = list(procedure) if procedure is not None else list(SEED_PROCEDURE)

    @property
    def system_prompt(self) -> str:
        """The current optimizable system prompt: the predictor's instruction."""
        return self.resolve.signature.instructions

    def candidate_json(self) -> str:
        """The current instruction as the JSON candidate the TS bridge scores."""
        return instruction_to_candidate_json(self.system_prompt, self.procedure)

    def forward(self, ticket: str) -> dspy.Prediction:
        # Execution is delegated to the TS bridge, so the module does not call a
        # model to resolve the ticket. It returns the current instruction text as
        # the prediction; the metric reads it, runs it through the bridge, and
        # scores the goal achievement of that instruction.
        return dspy.Prediction(
            resolution=self.system_prompt,
            system_prompt=self.system_prompt,
            procedure=self.procedure,
            candidate_json=self.candidate_json(),
        )
