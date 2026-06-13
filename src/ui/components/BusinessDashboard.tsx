"use client";

import type { RunScore, HarnessVersion } from "@/engine";
import { Odometer } from "./Odometer.js";
import { TransformChart } from "./TransformChart.js";
import { dollars, pct, fixtureLabel, trustTier } from "../format.js";

export interface BusinessDashboardProps {
  // The currently selected version's score, driving the metric cards.
  active: RunScore;
  activeVersion: HarnessVersion;
  // Both scores, so the chart can plot the v1 to v2 transform regardless of which
  // version is selected for the metric cards.
  v1: RunScore;
  v2: RunScore;
}

// The load-bearing panel. A Cash Burned odometer and a Trust Score for the
// selected version, a pinned-technical vs moving-business chart across both
// versions, and a per-fixture verdict table with dollar impacts and failure tags.
export function BusinessDashboard({
  active,
  activeVersion,
  v1,
  v2,
}: BusinessDashboardProps) {
  const tier = trustTier(active.trust_score);

  return (
    <section className="panel dashboard">
      <div className="panel-head">
        <h2>Business Dashboard</h2>
        <span className="eyebrow">judged on business fit, not green checks</span>
      </div>

      <div className="panel-body">
        <div className="metric-stack">
          <div className="metric-card cash" data-version={activeVersion}>
            <div className="label">Cash Burned</div>
            <Odometer cents={active.cash_burned_cents} />
            <div className="delta">
              {dollars(v1.cash_burned_cents)} {"->"}{" "}
              {dollars(v2.cash_burned_cents)} across v1 to v2
            </div>
          </div>

          <div className="metric-card trust" data-tier={tier}>
            <div className="label">Trust Score</div>
            <div className="trust-row">
              <span className="trust-num">
                {Math.round(active.trust_score)}
                <span className="max">/100</span>
              </span>
            </div>
            <div className="delta">
              {Math.round(v1.trust_score)} {"->"} {Math.round(v2.trust_score)}{" "}
              across v1 to v2
            </div>
          </div>

          <div className="metric-card tech">
            <div className="label">Technical pass</div>
            <div className="trust-row">
              <span className="trust-num">{pct(active.technical_pass_rate)}</span>
            </div>
            <div className="tech-badge">
              <span className="pin" />
              pinned flat across both versions
            </div>
          </div>
        </div>

        <div className="chart-wrap">
          <div className="chart-legend">
            <span className="legend-item">
              <span className="legend-swatch dashed" /> Technical pass
            </span>
            <span className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: "var(--bad)" }}
              />{" "}
              Cash Burned
            </span>
            <span className="legend-item">
              <span
                className="legend-swatch"
                style={{ background: "var(--good)" }}
              />{" "}
              Trust Score
            </span>
          </div>
          <TransformChart v1={v1} v2={v2} />
          <p className="chart-caption">
            Technical pass held flat at <b>100%</b> while Cash Burned went{" "}
            <b>{dollars(v1.cash_burned_cents)}</b> {"->"}{" "}
            <b>{dollars(v2.cash_burned_cents)}</b> and Trust{" "}
            <b>{Math.round(v1.trust_score)}</b> {"->"}{" "}
            <b>{Math.round(v2.trust_score)}</b>.
          </p>
        </div>

        <div className="verdicts">
          <h3>Per-fixture verdicts ({activeVersion})</h3>
          <table className="verdict-table">
            <thead>
              <tr>
                <th>Fixture</th>
                <th>Verdict</th>
                <th className="num">Dollar impact</th>
                <th>Failure tags</th>
              </tr>
            </thead>
            <tbody>
              {active.fixture_verdicts.map((vd) => (
                <tr key={vd.fixture_id}>
                  <td>
                    <span className="fx-name">
                      {fixtureLabel(vd.fixture_id)}
                    </span>{" "}
                    <span className="fx-id">{vd.fixture_id}</span>
                  </td>
                  <td>
                    <span
                      className="verdict-status"
                      data-correct={vd.correct}
                    >
                      <span className="ico" />
                      {vd.correct ? "correct" : "wrong"}
                    </span>
                  </td>
                  <td
                    className={`num ${
                      vd.dollar_impact_cents > 0 ? "impact-pos" : "impact-zero"
                    }`}
                  >
                    {dollars(vd.dollar_impact_cents)}
                  </td>
                  <td>
                    <div className="tags">
                      {vd.failure_tags.length === 0 ? (
                        <span className="tag none">none</span>
                      ) : (
                        vd.failure_tags.map((t) => (
                          <span className="tag" key={t}>
                            {t}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
