"use client";

import { useState } from "react";
import type { HarnessVersion } from "@/engine";
import type { SweepResult } from "../types.js";
import { VersionSelector } from "./VersionSelector.js";
import { HarnessSpecPanel } from "./HarnessSpecPanel.js";
import { TracePanel } from "./TracePanel.js";
import { BusinessDashboard } from "./BusinessDashboard.js";

export interface EvidenceViewerProps {
  // The full sweep evidence for both versions. The page fetches this from the
  // in-process keyless sweep route and hands it down; this component never
  // fetches.
  data: SweepResult;
}

// The interactive shell over the three evidence panels. It owns the single piece
// of view state, the selected harness version, and hands each panel the slice it
// renders. The before/after is one toggle away in every panel at once.
export function EvidenceViewer({ data }: EvidenceViewerProps) {
  const [version, setVersion] = useState<HarnessVersion>("v1");
  const evidence = version === "v1" ? data.v1 : data.v2;

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">
            Synthetic Harness Lab <span className="mark">/ Evidence Viewer</span>
          </h1>
          <p className="app-sub">
            A thin viewer over the deterministic, keyless sweep. The same harness
            passes every technical check in both versions; the trace tells you
            what it cost. Toggle v1 to v2 to see Cash Burned and Trust transform
            while technical pass holds flat.
          </p>
        </div>
        <VersionSelector
          value={version}
          onChange={setVersion}
          labels={{ v1: "naive", v2: "tightened" }}
        />
      </header>

      <div className="panel-grid">
        <HarnessSpecPanel
          spec={evidence.spec}
          v1={data.v1.spec}
          v2={data.v2.spec}
        />
        <TracePanel fixtures={evidence.fixtures} version={version} />
        <BusinessDashboard
          active={evidence.score}
          activeVersion={version}
          v1={data.v1.score}
          v2={data.v2.score}
        />
      </div>
    </div>
  );
}
