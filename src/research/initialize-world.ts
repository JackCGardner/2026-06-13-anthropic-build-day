// Initialize a runnable synthetic world from a frozen ResearchBundle (doc 07
// section 5). It instantiates one generic dossier-driven kernel per committed
// dossier and exposes them as a KernelResolver the existing World Runner, sweep,
// and optimize drive unchanged. The generic kernels enforce only each dossier's
// declared enforced_invariants and never load the intent layer, so a world built
// here reproduces the same faithful behavior the hand kernels produce, including
// the $5,140 trap, with no per-tool hand-coding.
//
// This is the bridge from research to evaluation: the front half researches a
// brief into dossiers, the generation pass emits the public surface, and this
// module turns those dossiers into the actual tools the agent under test calls.
// Nothing here changes the hand kernels' authority. The runner's default
// resolver is still the hand registry; a caller drives the generic world only by
// passing this module's resolver to runSweep.

import type { Fixture, ToolDossier, ToolKernel } from "@/engine";
import {
  createGenericKernel,
  STRIPE_TOOL_ID,
  ORDERS_TOOL_ID,
  CUSTOMERS_TOOL_ID,
  POLICY_TOOL_ID,
  ZENDESK_TOOL_ID,
} from "@/engine/kernels/index.js";
import { createJudge, deterministicCxScorer } from "@/engine";
import type { HarnessVersion, RunScore } from "@/engine";
import {
  runSweep,
  scriptedHarnessV1,
  scriptedHarnessV2,
  type KernelResolver,
  type RunResult,
} from "@/world/index.js";
import { loadRefundPack } from "@/scenarios/refund/index.js";

import type { ResearchBundle } from "./types.js";

// The short kernel-service id each dossier is instantiated under. The World
// Runner routes egress to these ids and seeds hidden state under them; the pack
// authors keep descriptive dossier ids. This is the same dossier-id-to-kernel-id
// correspondence the seeding uses, stated here so the generic registry binds a
// dossier to the slot the runner dispatches to.
const KERNEL_ID_FOR_DOSSIER: Record<string, string> = {
  stripe_payments: STRIPE_TOOL_ID,
  orders: ORDERS_TOOL_ID,
  customers: CUSTOMERS_TOOL_ID,
  policy_store: POLICY_TOOL_ID,
  zendesk_support: ZENDESK_TOOL_ID,
};

// One instantiated generic tool: the kernel id the runner dispatches to and the
// dossier it was built from. Carried so a caller can report which dossier backs
// which kernel slot in the initialized world.
export interface InitializedTool {
  kernel_id: string;
  dossier_id: string;
  kernel: ToolKernel;
}

// A runnable synthetic world initialized from a bundle: the generic kernels keyed
// by the runner's short kernel id, the tool list for reporting, and a resolver
// the World Runner drives unchanged. The resolver returns undefined for an
// unknown tool, exactly as the hand registry does, so the runner's unknown-tool
// path is unchanged.
export interface InitializedWorld {
  pack_id: string;
  tools: InitializedTool[];
  resolveKernel: KernelResolver;
}

// Build the runnable world from a bundle's dossiers. Each dossier is mapped to
// its kernel slot and instantiated as a generic kernel; a dossier whose id has no
// kernel-slot mapping is skipped (it has no home in the runner's state scoping).
// The returned resolver is the single seam the runner needs to drive the generic
// tools instead of the hand kernels.
export function initializeWorld(bundle: ResearchBundle): InitializedWorld {
  const tools: InitializedTool[] = [];
  const byKernelId = new Map<string, ToolKernel>();

  for (const dossier of bundle.dossiers) {
    const kernelId = KERNEL_ID_FOR_DOSSIER[dossier.tool_id];
    if (kernelId === undefined) continue;
    const kernel = createGenericKernel(dossier as ToolDossier);
    byKernelId.set(kernelId, kernel);
    tools.push({ kernel_id: kernelId, dossier_id: dossier.tool_id, kernel });
  }

  return {
    pack_id: bundle.pack_id,
    tools,
    resolveKernel: (toolId: string) => byKernelId.get(toolId),
  };
}

// One harness version's result against the initialized generic world: the
// aggregate RunScore the Judge computed (technical pass, Cash Burned, Trust
// Score) plus the run id, so a caller can confirm the trap reproduces.
export interface GenericSweepVersionResult {
  version: HarnessVersion;
  score: RunScore;
  run: RunResult;
}

// Run and judge one harness version against the initialized generic world. It
// reuses the production fixtures, scripted harness, World Runner, and
// deterministic Judge unchanged; the only substitution is the kernel resolver,
// so the score is computed exactly as the keyless sweep computes it but with the
// generic dossier-driven tools serving every call.
async function sweepGenericVersion(
  world: InitializedWorld,
  version: HarnessVersion,
  fixtures: Fixture[],
  rubric: ReturnType<typeof loadRefundPack>["rubric"],
): Promise<GenericSweepVersionResult> {
  const harness = version === "v1" ? scriptedHarnessV1 : scriptedHarnessV2;
  const run = await runSweep(
    `generic_${version}`,
    harness,
    fixtures,
    world.resolveKernel,
  );

  const judge = createJudge(deterministicCxScorer);
  const score = await judge.scoreRun({
    runId: run.runId,
    harnessVersion: version,
    rubric,
    fixtures: run.fixtures.map((f) => ({
      fixtureId: f.fixtureId,
      fixture: f.fixture,
      events: f.events,
    })),
  });

  return { version, score, run };
}

// Drive the existing sweep against the initialized generic world for both harness
// versions. Deterministic and keyless: no shell, no model, no network. This is
// the proof that the generic dossier-driven tools reproduce the trap end to end:
// v1 burns $5,140 and v2 holds the budget, the same numbers the hand-kernel sweep
// produces, because the generic kernels enforce the same declared invariants and
// withhold the same business rules.
export async function sweepGenericWorld(
  world: InitializedWorld,
): Promise<{ v1: GenericSweepVersionResult; v2: GenericSweepVersionResult }> {
  const pack = loadRefundPack();
  const [v1, v2] = await Promise.all([
    sweepGenericVersion(world, "v1", pack.fixtures, pack.rubric),
    sweepGenericVersion(world, "v2", pack.fixtures, pack.rubric),
  ]);
  return { v1, v2 };
}
