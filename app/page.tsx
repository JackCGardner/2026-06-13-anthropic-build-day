// The evidence viewer page. It loads the keyless sweep on the server (calling the
// in-process World Runner + judge directly, no HTTP hop and no API key) and hands
// the result to the client EvidenceViewer, which owns the v1/v2 toggle and the
// three panels. The page does the one piece of shaping the viewer needs: it maps
// the world-level sweep result onto the viewer contract, deriving each fixture's
// terminal decision from its run-end event and its correctness from the matching
// judge verdict. Everything below the EvidenceViewer is pure presentation.

import type { TraceEvent, TerminalDecision, RunScore } from "@/engine";
import { runSweepInProcess } from "@/world/index.js";
import type {
  SweepVersionResult,
  SweepFixtureResult,
} from "@/world/index.js";
import { EvidenceViewer, fixtureLabel } from "@/ui";
import type {
  SweepResult,
  VersionEvidence,
  FixtureEvidence,
} from "@/ui";

// The sweep stands up the synthetic world and the deterministic kernels, which
// are Node modules, so this page renders on the Node.js runtime. It is
// recomputed per request to keep the module graph simple; the sweep is fast and
// fully deterministic, so the rendered numbers are stable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The terminal decision the harness reached for a fixture, read from the run-end
// event the World Runner wrote. Falls back to "errored" only if no run-end event
// is present, which never happens for a completed run.
function terminalDecision(events: TraceEvent[]): TerminalDecision {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e && e.kind === "run" && e.span.phase === "end") {
      const d = e.payload["terminal_decision"];
      if (
        d === "refunded" ||
        d === "escalated" ||
        d === "blocked" ||
        d === "errored"
      ) {
        return d;
      }
    }
  }
  return "errored";
}

// Whether the judge ruled this fixture correct, read from the run-level score's
// matching verdict. The Trace panel uses this to tell a wrong payout (a green
// check over money that should not have moved) from a clean, legitimate refund.
function verdictCorrect(score: RunScore, fixtureId: string): boolean {
  const v = score.fixture_verdicts.find((x) => x.fixture_id === fixtureId);
  return v ? v.correct : false;
}

// Map one world-level fixture result onto the viewer's FixtureEvidence: attach a
// human label, the ticket subject for context, the derived terminal decision,
// and the judge's correctness flag, keeping the full trace for replay.
function toFixtureEvidence(
  fixture: SweepFixtureResult,
  score: RunScore,
): FixtureEvidence {
  return {
    fixture_id: fixture.fixture_id,
    label: fixtureLabel(fixture.fixture_id),
    ticket_subject: fixture.ticket.subject,
    terminal_decision: terminalDecision(fixture.events),
    correct: verdictCorrect(score, fixture.fixture_id),
    events: fixture.events,
  };
}

function toVersionEvidence(v: SweepVersionResult): VersionEvidence {
  return {
    version: v.version,
    spec: v.spec,
    score: v.score,
    fixtures: v.fixtures.map((f) => toFixtureEvidence(f, v.score)),
  };
}

export default async function HomePage() {
  const sweep = await runSweepInProcess();
  const data: SweepResult = {
    v1: toVersionEvidence(sweep.v1),
    v2: toVersionEvidence(sweep.v2),
  };

  return <EvidenceViewer data={data} />;
}
