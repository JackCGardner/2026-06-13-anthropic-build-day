// The shape the evidence viewer renders. It is the JSON contract the in-process
// sweep route returns and the components consume. It is built entirely from
// engine types so the viewer never carries its own copy of a scored number:
// RunScore, TraceEvent, and HarnessSpec all come from @/engine and the harness
// spec module. The route computes this on the server with no API key; the page
// hands it to the components below.

import type { RunScore, TraceEvent, HarnessVersion } from "@/engine";
import type { HarnessSpec } from "@/harness/specs/types.js";

// One fixture's full evidence within a version: the scored verdict the Judge
// produced, the raw trace the World Runner wrote, and the terminal decision the
// harness reached. The verdict carries dollar impact and failure tags; the
// events carry the replayable timeline the Trace panel renders.
export interface FixtureEvidence {
  fixture_id: string;
  // A short human label for the fixture selector, e.g. "Out of window".
  label: string;
  // The ticket subject, shown as context above the trace.
  ticket_subject: string;
  // The terminal decision the harness reached for this fixture.
  terminal_decision: "refunded" | "escalated" | "blocked" | "errored";
  // Whether the Judge ruled this fixture correct. Mirrors the matching
  // FixtureVerdict.correct on the RunScore; the Trace panel uses it to decide
  // whether a 200 on a refund is the thesis line (a wrong payout) or a clean one.
  correct: boolean;
  // The full append-only trace, in seq order.
  events: TraceEvent[];
}

// One harness version's complete evidence: its pinned spec, its run-level score,
// and the per-fixture traces. The verdicts on the RunScore align by fixture_id
// with the entries in `fixtures`.
export interface VersionEvidence {
  version: HarnessVersion;
  spec: HarnessSpec;
  score: RunScore;
  fixtures: FixtureEvidence[];
}

// The top-level payload: both versions, ready to diff side by side.
export interface SweepResult {
  v1: VersionEvidence;
  v2: VersionEvidence;
}
