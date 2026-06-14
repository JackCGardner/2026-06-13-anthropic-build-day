# DSPy refund-harness instruction optimizer

Optimizes the refund-resolution harness instruction (system prompt + procedure)
so the agent better achieves the business goal in the synthetic refund world,
judged by the deterministic judge, under two first-class regularizers that keep
the prompt short and the rule set small.

The optimizable artifact is the instruction. Execution is delegated to the
TypeScript bridge (`scripts/evaluate.ts`): the live Agent SDK harness runs the
candidate across the refund fixtures and the judge scores it. DSPy carries the
instruction, proposes rewrites with COPRO, and selects on the regularized metric.

## Layout

- `harness_program.py` - `ResolveRefund` signature and `RefundHarness` module;
  the predictor's signature `instructions` is the optimizable instruction, seeded
  with a decent starting refund prompt.
- `metric.py` - `metric(example, prediction, trace=None) -> float`. Calls the TS
  bridge, returns `holdout_trust - LENGTH_WEIGHT*length_penalty - RULE_WEIGHT*rule_penalty`.
- `optimize.py` - configures the LM, runs COPRO, writes `out/best-instruction.json`,
  prints the per-round trajectory. `--dry-run` is the keyless loop.
- `out/best-instruction.json` - the selected instruction (generated).

## Optimizer

COPRO. It rewrites the module's instruction wholesale each round with a proposer
model and selects on a custom scalar metric over a small trainset. Wholesale
rewriting (not appending) is what keeps the prompt from the append-only growth
the regularizers exist to fight. MIPROv2 also tunes few-shot demos, which this
instruction-only, execution-delegated task does not use, so COPRO is the fit.

## Regularization formula

    score = holdout_trust
            - LENGTH_WEIGHT * length_penalty(token_estimate)
            - RULE_WEIGHT   * rule_penalty(rule_count)

with the constants in `metric.py`:

- `TARGET_TOKENS = 500` - soft target; at or below it the length penalty is zero.
- `HARD_MAX_TOKENS = 1500` - hard ceiling; past it the length penalty is severe
  and keeps climbing, so a near-20k-token prompt scores terribly even at perfect
  goal achievement.
- `LENGTH_WEIGHT = 60.0` - points lost at the hard ceiling; overshoot drives the
  score deeply negative.
- `MAX_RULES = 6` - rule budget; at or below it the rule-count penalty is zero.
- `RULE_WEIGHT = 4.0` - points lost per rule beyond the budget.

`length_penalty` is 0 below the target, ramps 0->1 linearly to the hard ceiling,
then climbs at twice the slope past it. `rule_penalty` is 0 up to the budget then
grows linearly. The effect: a concise, few-rule instruction that hits the goal
beats a long, many-rule one that hits the same goal.

## Setup

Using uv:

    cd py/dspy_optimizer
    uv venv
    uv pip install -r requirements.txt

Or venv + pip:

    cd py/dspy_optimizer
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt

The venv, `__pycache__`, and `*.pyc` are gitignored.

## Commands

Run from `py/` (the parent of the `dspy_optimizer` package) so the module path
resolves, with the venv active. The TS bridge is invoked via the repo's
`node_modules/.bin/tsx`, so `npm install` must have been run at the repo root.

    cd py
    source dspy_optimizer/.venv/bin/activate

Dry run (keyless: DummyLM proposer + `--mock` bridge; demonstrates the bloated
candidate losing to a concise one):

    python -m dspy_optimizer.optimize --dry-run

Live run (Anthropic `claude-opus-4-8` proposer + `--live` bridge; needs
`ANTHROPIC_API_KEY`):

    export ANTHROPIC_API_KEY=sk-ant-...
    python -m dspy_optimizer.optimize

Both print the per-round trajectory (holdout_trust, tokens, rules, score) and
write `out/best-instruction.json`.
