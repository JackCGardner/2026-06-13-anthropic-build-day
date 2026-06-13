# Synthetic Harness Lab

Anthropic Build Day, San Francisco - June 13, 2026.

This project explores a simple but sharp idea: coding agents are getting good at
creating the harnesses they need to solve a specific problem, but "the harness
runs" is not the same thing as "the harness solves the real business problem."

Synthetic Harness Lab is a hackathon prototype for agent-generated coding
harnesses that can be evaluated and improved inside synthetic sandboxes before
they are trusted in the real world.

## Vision

A user describes a problem. Instead of hand-writing the full agent workflow, an
LLM designs the harness around the task:

- what context it needs
- what tools it should have
- what procedures it should follow
- what outputs it should optimize for
- what evidence should count as success

The next step is the important part: the harness does not immediately operate in
the real environment. It is placed inside a synthetic sandbox where tool use is
simulated by stateful LLM-backed environments.

For example, a `bash` command is not necessarily real bash. It can be a synthetic
shell agent with its own filesystem state, constraints, logs, failure modes, and
hidden business context. The same pattern can apply to APIs, ticketing systems,
databases, browsers, Slack, CRMs, test suites, and domain-specific tools.

That synthetic world lets us ask a different question:

> Does this agent harness behave well for the problem we actually care about?

## Core Loop

1. **Generate the harness**
   - Start from a business or operational problem.
   - Let the agent design its own task-specific workflow, tools, context model,
     and success criteria.

2. **Build the synthetic sandbox**
   - Replace real tools with LLM-backed simulators.
   - Give each synthetic tool its own state and behavior.
   - Model realistic constraints, incomplete information, ambiguity, and
     business-specific edge cases.

3. **Run scenario sweeps**
   - Test the harness against many synthetic situations.
   - Vary personas, goals, hidden states, environmental failures, and priorities.
   - Capture traces of decisions, tool calls, recoveries, and final outcomes.

4. **Judge from the right perspective**
   - Score the harness on business outcomes and problem-solving quality, not only
     on technical correctness.
   - Use judge agents, rubrics, and task-specific evaluators to identify where
     the harness is brittle, overconfident, under-tooled, or misaligned.

5. **Optimize the harness**
   - Use DSPy-style optimization to improve prompts, tool definitions, routing,
     and judging criteria.
   - Iterate until the harness is not just functional, but meaningfully better at
     the target task.

## Why This Matters

Agent tooling is often evaluated as if the main question is whether the agent can
complete a technical sequence. In real work, the harder question is whether the
agent is solving the right problem in the right way.

Synthetic sandboxes make it possible to test that gap cheaply and repeatedly.
They let us pressure-test agent behavior before exposing it to production
systems, real customers, real tickets, real files, or real spend.

## Initial Prototype Direction

The hackathon build will likely focus on:

- a task description format for harness generation
- a small set of synthetic tool agents, starting with shell-like execution
- trace capture for every synthetic tool call
- judge prompts for business-aligned evaluation
- DSPy-driven iteration over harness prompts and tool specs
- a demo scenario that shows the harness improving over repeated synthetic runs

## License

MIT
