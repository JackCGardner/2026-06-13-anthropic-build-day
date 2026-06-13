"use client";

import type { RunScore } from "@/engine";

export interface TransformChartProps {
  v1: RunScore;
  v2: RunScore;
}

// The load-bearing visual. Three normalized series plotted across two stations
// (v1, v2): the technical-pass line stays pinned flat at the top while Cash Burned
// falls to zero and Trust climbs. All three share a 0-100% vertical axis so the
// flat line and the two moving lines read against the same scale.
export function TransformChart({ v1, v2 }: TransformChartProps) {
  const W = 560;
  const H = 240;
  const padL = 44;
  const padR = 88;
  const padT = 22;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const x = (station: 0 | 1): number => padL + station * plotW;
  // value is 0..1; y inverts so 1 sits at the top.
  const y = (value: number): number => padT + (1 - value) * plotH;

  // Normalize each series to 0..1. Cash uses the v1 figure as the worst case so
  // the v1 station sits near the top and v2 drops to the floor.
  const cashMax = Math.max(v1.cash_burned_cents, v2.cash_burned_cents, 1);
  const cash1 = v1.cash_burned_cents / cashMax;
  const cash2 = v2.cash_burned_cents / cashMax;
  const trust1 = v1.trust_score / 100;
  const trust2 = v2.trust_score / 100;
  const tech1 = v1.technical_pass_rate;
  const tech2 = v2.technical_pass_rate;

  const gridYs = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg
      className="chart-svg"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Technical pass held flat while Cash Burned fell and Trust rose"
    >
      {gridYs.map((g) => (
        <g key={g}>
          <line
            className="grid-line"
            x1={padL}
            x2={padL + plotW}
            y1={y(g)}
            y2={y(g)}
          />
          <text className="axis-label" x={padL - 8} y={y(g) + 3} textAnchor="end">
            {Math.round(g * 100)}
          </text>
        </g>
      ))}

      {/* station labels */}
      <text className="axis-label" x={x(0)} y={H - 12} textAnchor="middle">
        v1 naive
      </text>
      <text className="axis-label" x={x(1)} y={H - 12} textAnchor="middle">
        v2 tightened
      </text>

      {/* cash series */}
      <line
        className="series-cash"
        x1={x(0)}
        y1={y(cash1)}
        x2={x(1)}
        y2={y(cash2)}
      />
      <circle className="node node-cash" cx={x(0)} cy={y(cash1)} r={4.5} />
      <circle className="node node-cash" cx={x(1)} cy={y(cash2)} r={4.5} />

      {/* trust series */}
      <line
        className="series-trust"
        x1={x(0)}
        y1={y(trust1)}
        x2={x(1)}
        y2={y(trust2)}
      />
      <circle className="node node-trust" cx={x(0)} cy={y(trust1)} r={4.5} />
      <circle className="node node-trust" cx={x(1)} cy={y(trust2)} r={4.5} />

      {/* technical-pass: pinned flat at the top */}
      <line
        className="series-flat"
        x1={x(0)}
        y1={y(tech1)}
        x2={x(1)}
        y2={y(tech2)}
      />
      <circle className="node node-flat" cx={x(0)} cy={y(tech1)} r={4} />
      <circle className="node node-flat" cx={x(1)} cy={y(tech2)} r={4} />

      {/* right-edge value labels */}
      <text className="vlabel" x={x(1) + 10} y={y(tech2) + 4}>
        tech 100%
      </text>
      <text className="vlabel" x={x(1) + 10} y={y(trust2) + 4}>
        trust {Math.round(v2.trust_score)}
      </text>
      <text className="vlabel" x={x(1) + 10} y={y(cash2) + 4}>
        cash $0
      </text>
    </svg>
  );
}
