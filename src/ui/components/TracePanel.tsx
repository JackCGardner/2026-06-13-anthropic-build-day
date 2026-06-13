"use client";

import { useMemo, useState } from "react";
import type { FixtureEvidence } from "../types.js";
import { deriveTrace } from "../trace-view.js";
import { fixtureLabel } from "../format.js";

export interface TracePanelProps {
  // The selected version's per-fixture evidence. The user picks one fixture and
  // the panel replays its trace.
  fixtures: FixtureEvidence[];
  // The version label, shown in the eyebrow so the trace's provenance is clear.
  version: string;
}

const DECISION_LABEL: Record<string, string> = {
  refunded: "refunded",
  escalated: "escalated",
  blocked: "blocked",
  errored: "errored",
};

// A readable, replayable timeline of one fixture's trace. It renders the causal
// chain shell -> egress -> tool_dispatch -> state_mutation and highlights the two
// thesis-carrying lines: the 200 on a refund that should have been blocked, and
// the parented hidden budget decrement.
export function TracePanel({ fixtures, version }: TracePanelProps) {
  const [selected, setSelected] = useState<string>(
    fixtures[0]?.fixture_id ?? "",
  );

  const active =
    fixtures.find((f) => f.fixture_id === selected) ?? fixtures[0];

  const rows = useMemo(() => {
    if (!active) return [];
    return deriveTrace(active.events, active.terminal_decision, active.correct)
      .rows;
  }, [active]);

  if (!active) {
    return (
      <section className="panel trace">
        <div className="panel-head">
          <h2>Trace</h2>
        </div>
        <div className="panel-body">No trace available.</div>
      </section>
    );
  }

  return (
    <section className="panel trace">
      <div className="panel-head">
        <h2>Trace</h2>
        <div className="trace-controls">
          <span className="eyebrow">{version}</span>
          <select
            className="fixture-select"
            value={active.fixture_id}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Select fixture"
          >
            {fixtures.map((f) => (
              <option key={f.fixture_id} value={f.fixture_id}>
                {fixtureLabel(f.fixture_id)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel-body">
        <div className="trace-context">
          <div>
            <div className="subject">{active.ticket_subject}</div>
            <div className="fixture-id">{active.fixture_id}</div>
          </div>
          <span
            className="decision-chip"
            data-decision={active.terminal_decision}
          >
            {DECISION_LABEL[active.terminal_decision] ??
              active.terminal_decision}
          </span>
        </div>

        <ul className="timeline">
          {rows.map((r) => (
            <li
              key={r.seq}
              className="tl-row"
              data-thesis={r.thesis !== null}
              data-thesis-kind={r.thesis ?? undefined}
            >
              <span className="tl-rail">
                <span className="tl-dot" data-kind={r.kind} />
              </span>
              <span className="tl-kind">{r.kind}</span>
              <span className="tl-body">
                <span className="tl-line">
                  <span className="em">{r.line}</span>
                  {r.thesis === "refund" ? (
                    <span className="thesis-tag">green check, bad payout</span>
                  ) : null}
                  {r.thesis === "budget" ? (
                    <span className="thesis-tag">money left the budget</span>
                  ) : null}
                </span>
                {r.detail ? (
                  <span className="tl-detail">{r.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
