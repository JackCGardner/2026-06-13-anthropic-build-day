// Derives readable timeline rows from the raw trace. The Trace panel renders the
// causal chain shell -> egress -> tool_dispatch -> state_mutation, so this keeps
// only those four kinds (plus the begin/point phases that carry the readable
// line) and projects each into a short, monospace-friendly string.
//
// Two rows carry the thesis and are flagged for highlight:
//   refund  a 200 returned on a refund egress for a fixture that should have
//           been blocked (the green check over a bad payout)
//   budget  the parented hidden budget decrement caused by that refund (the
//           money leaving, traced as a state_mutation under the egress)

import type { TraceEvent } from "@/engine";

export type ThesisKind = "refund" | "budget" | null;

export interface TraceRow {
  seq: number;
  kind: "shell" | "egress" | "tool_dispatch" | "state_mutation";
  // The primary one-line summary.
  line: string;
  // Optional second line of detail (status, before/after, reason).
  detail?: string;
  // Set when this row is one of the two thesis-carrying lines.
  thesis: ThesisKind;
}

const RENDERED_KINDS = new Set([
  "shell",
  "egress",
  "tool_dispatch",
  "state_mutation",
]);

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" ? v : undefined;
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key];
  return typeof v === "number" ? v : undefined;
}

function isRefundEgress(url: string | undefined): boolean {
  if (!url) return false;
  return /refund/i.test(url);
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search : "");
  } catch {
    return url;
  }
}

export interface DerivedTrace {
  rows: TraceRow[];
}

export function deriveTrace(
  events: TraceEvent[],
  terminalDecision: string,
  // Whether the Judge ruled this fixture correct. A 200 on a refund is the thesis
  // line only when it was a mistake: a green technical check over money that
  // should not have moved. A correct, legitimate payout is not highlighted.
  verdictCorrect: boolean,
): DerivedTrace {
  const rows: TraceRow[] = [];

  // The two thesis lines only carry the thesis when the run was a bad payout: a
  // refund egress returned 200 and the Judge ruled it wrong, followed by the
  // budget decrement that paid it out.
  const decisionWasBad = terminalDecision === "refunded" && !verdictCorrect;

  for (const e of events) {
    if (!RENDERED_KINDS.has(e.kind)) continue;
    const p = e.payload;

    if (e.kind === "shell" && e.span.phase === "begin") {
      const cmd = str(p, "command") ?? "";
      rows.push({
        seq: e.seq,
        kind: "shell",
        line: cmd,
        thesis: null,
      });
      continue;
    }

    if (e.kind === "egress") {
      const url = str(p, "url");
      if (e.span.phase === "begin") {
        const method = str(p, "method") ?? "GET";
        rows.push({
          seq: e.seq,
          kind: "egress",
          line: `${method} ${url ? shortUrl(url) : ""}`.trim(),
          thesis: null,
        });
      } else if (e.span.phase === "end") {
        const status = num(p, "status");
        const refund = isRefundEgress(url);
        const thesisRefund = refund && status === 200 && decisionWasBad;
        rows.push({
          seq: e.seq,
          kind: "egress",
          line: `${status ?? "?"} ${url ? shortUrl(url) : ""}`.trim(),
          detail:
            status === 200 && refund
              ? "billing API accepted the refund"
              : undefined,
          thesis: thesisRefund ? "refund" : null,
        });
      }
      continue;
    }

    if (e.kind === "tool_dispatch" && e.span.phase === "begin") {
      const toolId = str(p, "tool_id") ?? "";
      rows.push({
        seq: e.seq,
        kind: "tool_dispatch",
        line: `dispatch -> ${toolId}`,
        thesis: null,
      });
      continue;
    }

    if (e.kind === "state_mutation") {
      const key = str(p, "key") ?? "";
      const before = p["before"];
      const after = p["after"];
      const reason = str(p, "reason");
      // The budget decrement caused by a bad refund is the second thesis line:
      // the hidden monthly budget dropping with no business-rule check. It is a
      // decrement on a budget key in a run whose terminal decision was a payout.
      const isBudgetDecrement =
        /budget/i.test(key) &&
        typeof before === "number" &&
        typeof after === "number" &&
        after < before;
      const thesisBudget =
        isBudgetDecrement && decisionWasBad ? "budget" : null;
      rows.push({
        seq: e.seq,
        kind: "state_mutation",
        line: `${key}: ${formatVal(before)} -> ${formatVal(after)}`,
        detail: reason,
        thesis: thesisBudget,
      });
      continue;
    }
  }

  return { rows };
}

function formatVal(v: unknown): string {
  if (typeof v === "number") return v.toLocaleString("en-US");
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "null";
  return JSON.stringify(v);
}
