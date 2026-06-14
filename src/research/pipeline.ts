// The research pipeline orchestrator (doc 07 section 3, stages 0 through 5). It
// wires the typed stages into the bounded sequence the brief describes: intake
// interview, capability decomposition, candidate discovery, contract
// acquisition, the bounded completeness loop, the human-review gate, and the
// commit. Every web or model call goes through the seam, so the orchestrator is
// gated: with no research capability it throws the typed
// MissingResearchCapabilityError at the first stage and makes no network call.
//
// For the known refund brief the keyless reproduction (reproduce.ts) returns the
// committed bundle directly, bypassing this orchestrator, so the downstream is
// exercisable without a key. This orchestrator is the live path the seam
// unlocks; it produces the same ResearchBundle shape the reproduction does, so
// the generation pass reads either identically.

import type { ToolDossier } from "@/engine";

import {
  type ResearchCapability,
  createLiveResearchCapability,
} from "./seam.js";
import {
  type IntakeQuestion,
  type IntakeAnswerProvider,
  type RuleReviewProvider,
  intakeInterview,
  decomposeCapabilities,
  discoverCandidates,
  acquireContracts,
  completenessCheck,
  reviewBusinessRules,
  commitResearchBundle,
} from "./stages.js";
import type { ResearchBundle, CompletenessReport } from "./types.js";

// The hard cap on the completeness loop (doc 07 section 3.4). The orchestrator
// re-enters discovery and acquisition only for uncovered capabilities and
// commits what it has at the budget.
const COMPLETENESS_BUDGET = 3;

// The inputs to one live research run. The capability is supplied by the caller
// (the CLI constructs the live seam); when omitted the orchestrator constructs
// the live seam from the environment and throws keyless. The providers supply
// the user's interview answers and the reviewer's rule dispositions, so the same
// orchestrator drives an attended CLI run and an unattended verification run.
export interface ResearchBriefInput {
  pack_id: string;
  brief: string;
  intakeQuestions: IntakeQuestion[];
  answerProvider: IntakeAnswerProvider;
  reviewProvider?: RuleReviewProvider;
  // The research seam. When omitted the orchestrator builds the live seam from
  // the environment, which throws MissingResearchCapabilityError keyless.
  capability?: ResearchCapability;
}

// Run the full live research pipeline and commit a frozen ResearchBundle. Every
// stage is gated on the seam, so a keyless caller fails fast at intake with the
// typed error and no network call is made. The bounded completeness loop
// re-enters discovery for uncovered capabilities up to the budget; the
// human-review gate confirms the enforcement delta before commit.
export async function researchBrief(
  input: ResearchBriefInput,
): Promise<ResearchBundle> {
  const capability =
    input.capability ?? createLiveResearchCapability();

  // Stage 0: adaptive intake interview. Gathers the stack and the governing
  // policies that become ground truth, tolerating unknowns via recommendations.
  const intake = await intakeInterview({
    brief: input.brief,
    questions: input.intakeQuestions,
    answerProvider: input.answerProvider,
    capability,
  });

  // Stage 1: decompose into vendor-neutral capabilities.
  const graph = await decomposeCapabilities({
    brief: intake.brief,
    intake,
    capability,
  });

  // Stages 2 through 4: discover candidates, acquire contracts, check
  // completeness, re-entering only for uncovered capabilities up to the budget.
  let dossiers: ToolDossier[] = [];
  let committedTools = await discoverCandidates({ graph, capability });
  let report: CompletenessReport = completenessCheck({
    graph,
    dossiers,
    iterations: 0,
  });
  let iterations = 0;

  while (iterations < COMPLETENESS_BUDGET) {
    const acquired = await acquireContracts({
      candidates: committedTools,
      graph,
      capability,
    });
    dossiers = acquired.map((a) => a.dossier);
    iterations += 1;
    report = completenessCheck({ graph, dossiers, iterations });
    if (report.status === "complete") break;

    // Re-enter discovery only for the capabilities still uncovered, with the
    // current graph, so the loop converges on the missing tools rather than
    // re-researching the whole set (doc 07 section 3.4).
    const uncovered = report.gaps
      .filter((g) => g.blocking)
      .map((g) => g.capability_id);
    if (uncovered.length === 0) break;
    const reDiscovered = await discoverCandidates({
      graph: {
        ...graph,
        capabilities: graph.capabilities.filter((c) =>
          uncovered.includes(c.id),
        ),
      },
      capability,
    });
    // Merge newly discovered tools, deduplicated by tool id.
    const byId = new Map(committedTools.map((t) => [t.tool_id, t]));
    for (const tool of reDiscovered) {
      if (!byId.has(tool.tool_id)) byId.set(tool.tool_id, tool);
    }
    committedTools = [...byId.values()];
  }

  // Stage 4b: human-review gate on the enforcement delta. Only kept and edited
  // rules survive into the committed dossiers.
  const reviewed = await reviewBusinessRules({
    dossiers,
    reviewProvider: input.reviewProvider,
  });

  // Stage 5: commit the frozen, content-addressed bundle.
  return commitResearchBundle({
    pack_id: input.pack_id,
    brief: intake.brief,
    capability_graph: graph,
    committed_tools: committedTools,
    dossiers: reviewed.dossiers,
    ground_truth_policies: intake.policies,
    completeness: report,
    rule_reviews: reviewed.reviews,
    origin: "live",
  });
}
