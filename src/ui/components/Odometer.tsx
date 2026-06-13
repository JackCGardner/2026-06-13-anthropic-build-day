"use client";

import { useMemo } from "react";

export interface OdometerProps {
  // The figure in cents. Rendered as a fixed-width dollar odometer so the digits
  // roll when the version changes ($5,140.00 -> $0.00).
  cents: number;
}

// A dollar odometer. Each digit column holds a 0-9 strip translated to the right
// digit; the CSS transition rolls it when the value changes. Separators (comma,
// dot) are static columns so the layout never reflows.
export function Odometer({ cents }: OdometerProps) {
  // Build a fixed-width formatted string so the column count is stable across
  // values. Pad to at least five integer digits so $0.00 and $5,140.00 align.
  const formatted = useMemo(() => formatFixed(cents), [cents]);

  return (
    <div className="odometer" aria-label={`$${(cents / 100).toFixed(2)}`}>
      <span className="cur">$</span>
      <span className="digits" aria-hidden="true">
        {formatted.split("").map((ch, i) => {
          if (ch >= "0" && ch <= "9") {
            const d = Number(ch);
            return (
              <span className="odo-col" key={i}>
                <span
                  className="odo-strip"
                  style={{ transform: `translateY(${-d * 38}px)` }}
                >
                  {Array.from({ length: 10 }, (_, n) => (
                    <span key={n}>{n}</span>
                  ))}
                </span>
              </span>
            );
          }
          return (
            <span className="odo-col sep" key={i}>
              {ch}
            </span>
          );
        })}
      </span>
    </div>
  );
}

// Formats cents into a comma-grouped fixed string with two decimals and a stable
// minimum width, e.g. 0 -> "0,000.00", 514000 -> "5,140.00". Width is driven by
// the larger of the two demo values so the odometer never changes column count.
function formatFixed(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100);
  const frac = Math.abs(cents) % 100;
  // Pad whole part to four digits so it groups as "X,XXX" consistently.
  const wholeStr = String(whole).padStart(4, "0");
  const grouped = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${String(frac).padStart(2, "0")}`;
}
