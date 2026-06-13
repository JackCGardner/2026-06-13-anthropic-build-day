"use client";

import { useState } from "react";
import type { HarnessSpec } from "@/harness/specs/types.js";

export interface HarnessSpecPanelProps {
  // The currently selected version's spec, shown in "spec" mode.
  spec: HarnessSpec;
  // Both specs, so "diff" mode can highlight the procedure steps v2 adds.
  v1: HarnessSpec;
  v2: HarnessSpec;
}

type Mode = "spec" | "diff";

// Renders the pinned harness spec. The spec is rule-silent by construction: it
// lists the tools, the procedure, and the single mechanical constraint, and never
// names the hidden business rules. The diff mode lines v1 against v2 and marks the
// pre-screen and escalation steps v2 adds, which is the entire tightening.
export function HarnessSpecPanel({ spec, v1, v2 }: HarnessSpecPanelProps) {
  const [mode, setMode] = useState<Mode>("spec");

  return (
    <section className="panel spec">
      <div className="panel-head">
        <h2>Harness Spec</h2>
        <div className="spec-modes">
          <button
            className="spec-mode"
            data-active={mode === "spec"}
            onClick={() => setMode("spec")}
          >
            {spec.version} spec
          </button>
          <button
            className="spec-mode"
            data-active={mode === "diff"}
            onClick={() => setMode("diff")}
          >
            v1 to v2 diff
          </button>
        </div>
      </div>

      <div className="panel-body">
        {mode === "spec" ? (
          <SpecView spec={spec} />
        ) : (
          <DiffView v1={v1} v2={v2} />
        )}
      </div>
    </section>
  );
}

function SpecView({ spec }: { spec: HarnessSpec }) {
  return (
    <>
      <div className="spec-field">
        <h3>System prompt</h3>
        <p className="spec-prose">{spec.system_prompt}</p>
      </div>

      <div className="spec-field">
        <h3>Tool manifest</h3>
        <div className="tool-pills">
          {spec.tool_manifest.map((t) => (
            <span key={t.name} className="tool-pill" title={t.description}>
              {t.name}
            </span>
          ))}
        </div>
      </div>

      <div className="spec-field">
        <h3>Procedure</h3>
        <ol className="spec-list">
          {spec.procedure.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>

      <div className="spec-field">
        <h3>Graded on</h3>
        <p className="spec-prose">{spec.success_criterion}</p>
      </div>

      <p className="rule-silent-note">
        Rule-silent by construction. The 30-day window, original-method-only,
        manager approval, and fraud review never appear here; the billing API
        never enforces them.
      </p>
    </>
  );
}

function DiffView({ v1, v2 }: { v1: HarnessSpec; v2: HarnessSpec }) {
  // A step is "added" if it does not appear verbatim in v1. v2 keeps the same
  // tool surface, so the diff that matters is entirely in the procedure.
  const v1Steps = new Set(v1.procedure.map(normalize));
  return (
    <>
      <div className="spec-field">
        <h3>Procedure: v1 to v2</h3>
        <ol className="spec-list">
          {v2.procedure.map((step, i) => {
            const added = !v1Steps.has(normalize(step));
            return (
              <li key={i} data-diff={added ? "added" : "kept"}>
                {step}
                {added ? <span className="diff-badge">added in v2</span> : null}
              </li>
            );
          })}
        </ol>
      </div>

      <p className="rule-silent-note">
        v2 adds the pre-screen and escalation steps without ever naming a rule as
        enforced. The rules live in the policy document the tightened harness now
        chooses to read. Same tools, same single mechanical constraint, different
        procedure.
      </p>
    </>
  );
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
