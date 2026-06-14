// The generation pass over a frozen ResearchBundle (doc 07 section 5). It takes
// the bundle the research step committed and emits the two artifacts the
// synthetic world is built from: the public harness spec the agent under test is
// driven from, and the world manifest that names which generic tools to
// instantiate from which dossiers plus the hidden-state owner map the Judge
// reads. It then runs the existing deterministic consistency gates over both, so
// a bundle whose dossiers would leak a business rule into the public surface, or
// name a tool the world cannot provide, is rejected before any world is stood up.
//
// This module adds nothing to the gates themselves: it reuses generator.ts
// unchanged, so the same resolution, leak, and owner-map gates that protect a
// hand-authored generation also protect one driven from a researched bundle. The
// only new surface here is the bundle-to-GenerateInput projection and a thin
// result type that carries the bundle's provenance alongside the generation
// output, so a caller can cite the content hash the world was generated against.

import type { ResearchBundle } from "./types.js";
import { REFUND_HARNESS_SPEC_V1 } from "@/harness/specs/index.js";
import {
  generate,
  buildWorldManifest,
  runConsistencyGates,
  type GenerationOutput,
  type GateResult,
} from "@/harness/generator.js";

// The result of generating from a bundle: the public harness spec and world
// manifest the world is built from, plus the bundle provenance (pack id, content
// hash, origin) so the world the gates passed can be traced back to the exact
// committed research artifact it was generated from.
export interface BundleGenerationResult {
  pack_id: string;
  content_hash: string;
  origin: ResearchBundle["origin"];
  output: GenerationOutput;
}

// Project a ResearchBundle to the inputs the deterministic generation pass reads.
// Only the public-surface fields cross over: the pack id the world manifest keys
// on, the brief the spec is generated from, and the dossiers whose public
// surface the spec is written against and whose intent layer the gates read to
// prove no rule leaked. The bundle's ground-truth policies and review record stay
// behind; they are the Judge's, not the harness's.
export function bundleToGenerateInput(bundle: ResearchBundle): {
  packId: string;
  brief: string;
  dossiers: ResearchBundle["dossiers"];
} {
  return {
    packId: bundle.pack_id,
    brief: bundle.brief,
    dossiers: bundle.dossiers,
  };
}

// Run the deterministic generation pass over a committed bundle. It emits the
// harness spec and world manifest, runs the consistency gates, and throws on any
// gate violation (generate() does the throwing, with the full violation set in
// the message). The returned result carries the bundle provenance so the world
// is auditable back to the frozen research artifact. The keyless default uses the
// pinned spec inside generate(); a caller that ran the live spec writer passes
// the produced spec through, where the same gates reject any leak.
export function generateFromBundle(
  bundle: ResearchBundle,
  spec?: GenerationOutput["spec"],
): BundleGenerationResult {
  const input = bundleToGenerateInput(bundle);
  const output = generate({ ...input, spec });
  return {
    pack_id: bundle.pack_id,
    content_hash: bundle.content_hash,
    origin: bundle.origin,
    output,
  };
}

// Run the consistency gates over a bundle's generation without throwing, for a
// caller that wants to inspect the violations rather than fail fast. It builds
// the generation output the same way generateFromBundle does, then returns the
// gate result. A pure function: no model, no I/O.
export function checkBundleGates(
  bundle: ResearchBundle,
  spec?: GenerationOutput["spec"],
): GateResult {
  const input = bundleToGenerateInput(bundle);
  // Build the same generation output the world would see, but evaluate the gates
  // directly so a caller gets the violation set rather than the thrown error
  // generate() raises on a failing gate. The spec defaults to the pinned v1 spec,
  // matching generate()'s keyless default.
  const output: GenerationOutput = {
    spec: spec ?? REFUND_HARNESS_SPEC_V1,
    world: buildWorldManifest(input.packId, input.dossiers),
  };
  return runConsistencyGates(output, input.dossiers);
}
