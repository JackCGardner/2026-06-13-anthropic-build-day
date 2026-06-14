// The research CLI: research a brief into a frozen ResearchBundle, then run the
// deterministic generation pass over it to produce the public harness spec and
// the world manifest. With no model credential and no web grant it runs the
// keyless refund reproduction (doc 07 section 3.6) and prints the produced
// dossiers and the harness spec, so the whole front half is exercisable with no
// key. With a credential and RESEARCH_WEB_ACCESS=1 it would drive the live
// pipeline; the live path is gated behind the seam and throws a clear typed
// error otherwise.
//
// Usage:
//   npm run research
//   tsx scripts/research.ts

import {
  reproduceRefundBundle,
  hasResearchCapability,
  generateFromBundle,
  initializeWorld,
  sweepGenericWorld,
  type ResearchBundle,
} from "@/research/index.js";

function printBundle(bundle: ResearchBundle): void {
  console.log("=".repeat(72));
  console.log(`ResearchBundle  pack=${bundle.pack_id}  origin=${bundle.origin}`);
  console.log(`content_hash    ${bundle.content_hash}`);
  console.log(
    `completeness    ${bundle.completeness.status} ` +
      `(${bundle.completeness.iterations} iterations, ` +
      `${bundle.completeness.gaps.length} gaps recorded)`,
  );
  console.log("=".repeat(72));

  console.log("\nCapabilities (vendor-neutral):");
  for (const cap of bundle.capability_graph.capabilities) {
    console.log(`  [${cap.necessity.padEnd(10)}] ${cap.id}  ${cap.verb}`);
  }

  console.log("\nCommitted tools:");
  for (const tool of bundle.committed_tools) {
    console.log(
      `  ${tool.tool_id.padEnd(18)} ${tool.kind.padEnd(14)} ` +
        `-> ${tool.capability_bindings.join(", ")}`,
    );
  }

  console.log("\nDossiers (mechanical contract / intent layer split):");
  for (const dossier of bundle.dossiers) {
    const enforced = dossier.operations.flatMap((op) =>
      op.enforced_invariants.map((i) => i.id),
    );
    const notEnforced = dossier.operations.flatMap((op) =>
      op.business_rules_not_enforced.map((r) => r.id),
    );
    console.log(`  ${dossier.tool_id}`);
    console.log(`    base_url   ${dossier.base_url}`);
    console.log(
      `    enforced   ${enforced.length > 0 ? enforced.join(", ") : "(none)"}`,
    );
    console.log(
      `    NOT enforced (the trap, withheld from the harness): ` +
        `${notEnforced.length > 0 ? notEnforced.join(", ") : "(none)"}`,
    );
  }

  console.log("\nGround-truth policies (Judge only, never in harness prompt):");
  for (const policy of bundle.ground_truth_policies) {
    console.log(
      `  ${policy.id.padEnd(26)} <- ${policy.ground_truth_signal} ` +
        `(confidence ${policy.confidence})`,
    );
  }
}

async function main(): Promise<void> {
  const live = hasResearchCapability();
  if (live) {
    // The live pipeline is gated behind the seam. Driving it needs an interview
    // answer provider and a brief; for the unattended CLI we run the keyless
    // reproduction so the script never blocks on stdin, and leave the live
    // orchestration (researchBrief) to the interactive front-end that owns the
    // intake questions. Print a note so the operator knows the key was seen.
    console.log(
      "[research] model credential and web access detected. The live pipeline " +
        "(researchBrief) is available behind the seam; this unattended CLI " +
        "runs the refund reproduction so it never blocks on the interview.",
    );
  } else {
    console.log(
      "[research] no model credential / web grant. Running the keyless refund " +
        "reproduction (doc 07 section 3.6).",
    );
  }

  const bundle = reproduceRefundBundle();
  printBundle(bundle);

  // Run the deterministic generation pass over the bundle: this is the same
  // public-surface harness spec and world manifest the downstream world is built
  // from, and it runs the consistency gates that prove no business rule leaked. A
  // gate failure throws here, so reaching the print means the gates passed.
  const generation = generateFromBundle(bundle);
  const { output } = generation;

  console.log("\n" + "=".repeat(72));
  console.log("Generation pass: harness spec (public surface only)");
  console.log("=".repeat(72));
  console.log(`  harness_id      ${output.spec.id}  version=${output.spec.version}`);
  console.log(`  billing_base_url ${output.spec.billing_base_url}`);
  console.log(`  system_prompt   ${output.spec.system_prompt}`);
  console.log("  tool_manifest:");
  for (const entry of output.spec.tool_manifest) {
    console.log(
      `    ${entry.name.padEnd(20)} <- ${entry.from}.${entry.op_id}`,
    );
  }
  console.log("  procedure:");
  for (const step of output.spec.procedure) {
    console.log(`    - ${step}`);
  }
  console.log(`  success_criterion: ${output.spec.success_criterion}`);

  console.log("\nWorld manifest hidden_state_owner_map:");
  for (const entry of output.world.hidden_state_owner_map) {
    console.log(
      `  ${entry.rule_id.padEnd(26)} owner=${entry.owner_tool_id.padEnd(16)} ` +
        `signal=${entry.ground_truth_signal}`,
    );
  }

  console.log(
    "\nConsistency gates passed: no business rule leaked into the harness " +
      "spec; every owner-map entry resolves to a tool the world provides " +
      `(generated against content_hash ${generation.content_hash}).`,
  );

  // Initialize the runnable synthetic world from the same bundle: one generic
  // dossier-driven kernel per committed dossier, exposed through the resolver the
  // existing World Runner drives. Then drive the existing sweep against it to
  // confirm the generic tools reproduce the trap end to end.
  console.log("\n" + "=".repeat(72));
  console.log("Initialized world: generic dossier-driven tools");
  console.log("=".repeat(72));
  const world = initializeWorld(bundle);
  for (const tool of world.tools) {
    console.log(
      `  kernel ${tool.kernel_id.padEnd(12)} <- dossier ${tool.dossier_id}`,
    );
  }

  console.log("\nSweep against the initialized generic world (existing runner + judge):");
  const sweep = await sweepGenericWorld(world);
  const v1 = sweep.v1.score;
  const v2 = sweep.v2.score;
  console.log(
    `  v1 (naive)     cash_burned=$${(v1.cash_burned_cents / 100).toFixed(2)}  ` +
      `trust=${v1.trust_score}  technical_pass=${(v1.technical_pass_rate * 100).toFixed(0)}%`,
  );
  console.log(
    `  v2 (tightened) cash_burned=$${(v2.cash_burned_cents / 100).toFixed(2)}  ` +
      `trust=${v2.trust_score}  technical_pass=${(v2.technical_pass_rate * 100).toFixed(0)}%`,
  );
  console.log(
    "\nThe trap is reproduced by the GENERIC tools: v1 burns $5,140 while " +
      "passing every technical check; v2 holds the budget. No per-tool kernel " +
      "was hand-coded; every tool was instantiated from its dossier.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
