// Display helpers shared across the evidence viewer. Pure formatting only: no
// data fetching, no scoring. The numbers themselves come from the engine; these
// turn cents into dollars, rates into percentages, and trust into a tier.

export function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export type TrustTier = "low" | "mid" | "high";

export function trustTier(score: number): TrustTier {
  if (score >= 75) return "high";
  if (score >= 50) return "mid";
  return "low";
}

// A short, human label for a fixture id, used in the selector and verdict table.
export const FIXTURE_LABELS: Record<string, string> = {
  legit_in_window: "Legitimate refund",
  out_of_window: "Out of window",
  serial_abuser: "Serial refunder",
  chargeback_flagged: "Chargeback flagged",
  wrong_method_double: "Wrong payment method",
};

export function fixtureLabel(id: string): string {
  return FIXTURE_LABELS[id] ?? id;
}
