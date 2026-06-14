// Content-addressing for the ResearchBundle. The bundle is frozen by a sha256
// over its canonicalized body, so the downstream generation pass can cite the
// same hash and a replayed reproduction yields a byte-identical bundle. The hash
// is computed over a stable JSON serialization with object keys sorted, so two
// structurally equal bundles hash identically regardless of key insertion order.

import { createHash } from "node:crypto";

// Serialize a value to JSON with object keys sorted at every level, so the
// output is stable under key reordering. Arrays keep their order, which is
// meaningful for the bundle (capability and tool order is part of the artifact).
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

// Compute the content hash of a bundle body (the bundle without its own hash
// field). Returns a "sha256:" prefixed hex digest, matching the dossier
// content-hash convention in doc 07 section 4.
export function contentHash(body: unknown): string {
  const canonical = JSON.stringify(canonicalize(body));
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${digest}`;
}
