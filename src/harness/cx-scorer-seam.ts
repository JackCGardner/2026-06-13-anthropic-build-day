// The customer-experience scorer seam, documented for the live path. The Judge
// scores every dimension deterministically except one: the customer-experience
// dimension, which is a judgment call and goes through the CxScorer seam from
// the frozen contracts. In the keyless build that seam is the deterministic stub
// already shipped as deterministicCxScorer in the engine: it returns a fixed
// score with a templated rationale, so the dashboard numbers are a pure function
// of code plus fixtures and need no key.
//
// The live implementation is one temperature-0 Claude call gated behind a key.
// It shares the exact CxScorer signature, so the Judge does not change when the
// implementation is swapped: the Judge calls scorer(input) and reads back a
// { score, rationale }, whether that came from the stub or the model.
//
// The live seam, when built, takes the same CxScorerInput (the fixture id and
// the slice of trace for the legitimate refund being scored), renders that slice
// into a prompt, makes a single temperature-0 call, and parses the model's
// reply into CxScorerResult. It reads auth from ANTHROPIC_API_KEY or the ambient
// Claude Code login and throws a clear typed error when neither is present,
// exactly as the live harness does, so a keyless run falls back to the
// deterministic stub rather than failing. This module states that seam; it adds
// no model call to the keyless build.

import type { CxScorer } from "@/engine";

// The factory shape the live customer-experience scorer fills. It is provided a
// model id (pinned to Opus for the live path) and returns a CxScorer with the
// frozen signature. The keyless build never calls this; it uses the
// deterministic stub from the engine. The live build supplies an implementation
// that makes the single temperature-0 call described above.
export type LiveCxScorerFactory = (options: { model: string }) => CxScorer;
