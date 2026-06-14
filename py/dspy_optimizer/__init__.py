"""DSPy instruction optimizer for the refund-resolution harness.

The optimizable artifact is the harness instruction (system prompt plus
procedure). Execution lives in TypeScript: the live Agent SDK harness runs the
candidate across the synthetic refund world and the deterministic judge scores
it. This package carries the instruction, proposes variants with a DSPy
instruction optimizer, and selects the variant that best achieves the business
goal under two regularizers that keep the prompt short and the rule set small.
"""
