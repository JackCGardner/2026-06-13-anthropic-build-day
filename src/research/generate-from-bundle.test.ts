// Keyless proof of the generation pass and the initialized generic world (doc 07
// section 5). From the refund reproduction bundle the generation pass must emit a
// public harness spec and a world manifest that pass the deterministic
// consistency gates, leaking no business rule; and the world initialized from the
// same bundle must, when the existing sweep drives it through the GENERIC
// dossier-driven kernels, reproduce the trap exactly: v1 burns $5,140 and v2
// holds the budget, with the same Trust Scores the hand-kernel sweep produces.

import { describe, it, expect } from "vitest";
import { reproduceRefundBundle } from "./reproduce.js";
import {
  generateFromBundle,
  checkBundleGates,
  bundleToGenerateInput,
} from "./generate-from-bundle.js";
import { initializeWorld, sweepGenericWorld } from "./initialize-world.js";
import { runSweepInProcess } from "@/world/index.js";
import { EXPECTED_CASH_BURNED_CENTS } from "@/scenarios/refund/index.js";

describe("generation pass over a research bundle", () => {
  it("emits a spec and world manifest that pass every consistency gate", () => {
    const bundle = reproduceRefundBundle();
    const result = generateFromBundle(bundle);

    // The gates ran inside generateFromBundle and did not throw; re-run them to
    // assert the pass explicitly and confirm no violation slipped through.
    const gates = checkBundleGates(bundle);
    expect(gates.ok).toBe(true);
    expect(gates.violations).toHaveLength(0);

    // The result carries the bundle provenance so the world is auditable back to
    // the frozen research artifact it was generated from.
    expect(result.pack_id).toBe(bundle.pack_id);
    expect(result.content_hash).toBe(bundle.content_hash);
    expect(result.origin).toBe("reproduction");
  });

  it("projects only the public surface into the generation input", () => {
    const bundle = reproduceRefundBundle();
    const input = bundleToGenerateInput(bundle);
    expect(input.packId).toBe(bundle.pack_id);
    expect(input.brief).toBe(bundle.brief);
    expect(input.dossiers).toBe(bundle.dossiers);
  });

  it("the harness spec leaks no business rule intent text", () => {
    const bundle = reproduceRefundBundle();
    const { output } = generateFromBundle(bundle);

    // Collect every hidden business rule intent from the bundle's dossiers.
    const ruleIntents: string[] = [];
    for (const dossier of bundle.dossiers) {
      for (const op of dossier.operations) {
        for (const rule of op.business_rules_not_enforced) {
          ruleIntents.push(rule.intent.toLowerCase());
        }
      }
    }
    expect(ruleIntents.length).toBeGreaterThan(0);

    const surfaces = [
      output.spec.system_prompt,
      output.spec.success_criterion,
      ...output.spec.procedure,
      ...output.spec.tool_manifest.map((t) => t.description),
    ].map((s) => s.toLowerCase());

    for (const intent of ruleIntents) {
      for (const surface of surfaces) {
        expect(surface.includes(intent)).toBe(false);
      }
    }
  });

  it("the owner map covers every business rule with a real world tool", () => {
    const bundle = reproduceRefundBundle();
    const { output } = generateFromBundle(bundle);

    const worldToolIds = new Set(output.world.tools.map((t) => t.tool_id));
    for (const entry of output.world.hidden_state_owner_map) {
      expect(worldToolIds.has(entry.owner_tool_id)).toBe(true);
    }
  });
});

describe("initialized generic world reproduces the trap via the generic tools", () => {
  it("instantiates one generic kernel per committed dossier", () => {
    const world = initializeWorld(reproduceRefundBundle());
    const dossierIds = world.tools.map((t) => t.dossier_id).sort();
    expect(dossierIds).toEqual(
      ["customers", "orders", "policy_store", "stripe_payments", "zendesk_support"].sort(),
    );
    // Every tool resolves to a kernel through the resolver the runner drives.
    for (const tool of world.tools) {
      expect(world.resolveKernel(tool.kernel_id)).toBe(tool.kernel);
    }
    // An unknown tool resolves to undefined, exactly as the hand registry does.
    expect(world.resolveKernel("does_not_exist")).toBeUndefined();
  });

  it("burns exactly $5,140 at v1 and holds the budget at v2 through generic kernels", async () => {
    const world = initializeWorld(reproduceRefundBundle());
    const sweep = await sweepGenericWorld(world);

    expect(sweep.v1.score.cash_burned_cents).toBe(EXPECTED_CASH_BURNED_CENTS);
    expect(sweep.v1.score.cash_burned_cents).toBe(514000);
    expect(sweep.v2.score.cash_burned_cents).toBe(0);
  });

  it("produces the same Trust Scores and technical pass as the hand-kernel sweep", async () => {
    const world = initializeWorld(reproduceRefundBundle());
    const generic = await sweepGenericWorld(world);
    const hand = await runSweepInProcess();

    // The generic dossier-driven kernels reproduce the hand kernels' verdicts:
    // same Trust Score and technical pass on both harness versions.
    expect(generic.v1.score.trust_score).toBe(hand.v1.score.trust_score);
    expect(generic.v2.score.trust_score).toBe(hand.v2.score.trust_score);
    expect(generic.v1.score.technical_pass_rate).toBe(
      hand.v1.score.technical_pass_rate,
    );
    expect(generic.v2.score.technical_pass_rate).toBe(
      hand.v2.score.technical_pass_rate,
    );
  });
});
