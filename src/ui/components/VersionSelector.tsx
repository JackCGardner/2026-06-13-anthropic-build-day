"use client";

import type { HarnessVersion } from "@/engine";

export interface VersionSelectorProps {
  value: HarnessVersion;
  onChange: (version: HarnessVersion) => void;
  // Optional labels under each version, e.g. "naive" / "tightened".
  labels?: Record<HarnessVersion, string>;
}

// The v1/v2 toggle that drives the whole viewer. It is the single control that
// makes the before/after obvious: every panel re-renders against the selected
// version's evidence.
export function VersionSelector({
  value,
  onChange,
  labels,
}: VersionSelectorProps) {
  const versions: HarnessVersion[] = ["v1", "v2"];
  return (
    <div className="version-selector" role="tablist" aria-label="Harness version">
      {versions.map((v) => (
        <button
          key={v}
          role="tab"
          data-version={v}
          data-active={value === v}
          aria-selected={value === v}
          onClick={() => onChange(v)}
        >
          {v}
          {labels ? ` ${labels[v]}` : ""}
        </button>
      ))}
    </div>
  );
}
