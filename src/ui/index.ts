// The evidence viewer UI: the three-panel viewer over the keyless sweep. The
// page imports EvidenceViewer and the SweepResult contract from here; the data
// route fills the contract in-process with no API key.

export type {
  SweepResult,
  VersionEvidence,
  FixtureEvidence,
} from "./types.js";

export { EvidenceViewer } from "./components/EvidenceViewer.js";
export type { EvidenceViewerProps } from "./components/EvidenceViewer.js";
export { VersionSelector } from "./components/VersionSelector.js";
export { HarnessSpecPanel } from "./components/HarnessSpecPanel.js";
export { TracePanel } from "./components/TracePanel.js";
export { BusinessDashboard } from "./components/BusinessDashboard.js";
export { Odometer } from "./components/Odometer.js";
export { TransformChart } from "./components/TransformChart.js";

export {
  dollars,
  pct,
  trustTier,
  fixtureLabel,
  FIXTURE_LABELS,
} from "./format.js";
export type { TrustTier } from "./format.js";
