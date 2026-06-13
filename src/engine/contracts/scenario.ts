// The scenario pack: the generalization unit. A brief, the fixtures (visible
// ticket plus hidden ground-truth state), the rubric (business-fit dimensions
// and weights), and a train/held-out split. The refund pack is pack number one.
// Ground truth is fixture-defined so the dollar figure is deterministic and
// does not drift between rehearsal and demo.

import { z } from "zod";
import { ToolDossierSchema } from "./dossier.js";

// The visible support ticket a fixture presents to the harness.
export const TicketSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
  customer_email: z.string(),
  order_id: z.string().optional(),
});
export type Ticket = z.infer<typeof TicketSchema>;

// The correct terminal action for a fixture, anchored to its hidden state.
export const CorrectActionSchema = z.enum(["refund", "escalate", "block"]);
export type CorrectAction = z.infer<typeof CorrectActionSchema>;

// The hidden ground truth the Judge scores against. `dollar_impact_cents` is
// what the bad refund costs if auto-issued; zero for the one legitimate case.
export const GroundTruthSchema = z.object({
  correct_action: CorrectActionSchema,
  // The businessRulesNotEnforced id violated if this is auto-refunded.
  rule_violated_if_auto_refunded: z.string().optional(),
  dollar_impact_cents: z.number().int().nonnegative(),
  // The failure tags the Judge should emit if the harness mishandles this case.
  expected_failure_tags: z.array(z.string()),
});
export type GroundTruth = z.infer<typeof GroundTruthSchema>;

// Per-(tool, fixture) seed state: keyed records written into a tool's slice
// before the harness starts. The owning tool is the map key.
export const FixtureSeedStateSchema = z.record(
  z.string(), // tool_id
  z.object({
    records: z.record(z.string(), z.record(z.string(), z.unknown())),
    monthly_refund_budget_cents: z.number().int().optional(),
  }),
);
export type FixtureSeedState = z.infer<typeof FixtureSeedStateSchema>;

// One fixture: the visible ticket, the seed for every owning tool's hidden
// state, and the ground truth used only by the Judge.
export const FixtureSchema = z.object({
  id: z.string(),
  ticket: TicketSchema,
  hidden_state: FixtureSeedStateSchema,
  ground_truth: GroundTruthSchema,
});
export type Fixture = z.infer<typeof FixtureSchema>;

// A single business-fit dimension and its weight in the Trust Score. The CX
// dimension is the one scored by an LLM call; all others are deterministic.
export const RubricDimensionSchema = z.object({
  id: z.string(),
  description: z.string(),
  weight: z.number().min(0),
  // True only for the customer-experience dimension scored by the CxScorer.
  llm_scored: z.boolean(),
});
export type RubricDimension = z.infer<typeof RubricDimensionSchema>;

// The rubric: weighted dimensions aggregated into a 0-100 Trust Score, plus
// the narrow technical-pass definition stated on screen.
export const RubricSchema = z.object({
  dimensions: z.array(RubricDimensionSchema),
  // The Trust Score scale maximum; dimension weights are normalized into it.
  trust_score_max: z.number().default(100),
});
export type Rubric = z.infer<typeof RubricSchema>;

// Train/held-out split: arrays of fixture ids. The headline optimizer metric
// is the held-out Trust Score.
export const SplitsSchema = z.object({
  train: z.array(z.string()),
  held_out: z.array(z.string()),
});
export type Splits = z.infer<typeof SplitsSchema>;

// The full pack: everything a run needs, validated on load.
export const ScenarioPackSchema = z.object({
  id: z.string(),
  brief: z.string(),
  fixtures: z.array(FixtureSchema),
  dossiers: z.array(ToolDossierSchema),
  rubric: RubricSchema,
  splits: SplitsSchema,
});
export type ScenarioPack = z.infer<typeof ScenarioPackSchema>;
