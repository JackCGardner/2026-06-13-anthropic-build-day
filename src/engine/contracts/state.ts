// Hidden world state: the source of business truth, owned by the World Runner
// and scoped per (fixtureId, toolId) so no tool is omniscient. The synthetic
// Stripe literally cannot read the fraud flag, because that fact is owned by
// the orders tool's slice. State carries a version that bumps on every
// mutation, feeding the response cache key and the replay-fidelity check.

import { z } from "zod";

// A stored record is an open key-value object, e.g. a charge or a refund.
export const WorldRecordSchema = z.record(z.string(), z.unknown());
export type WorldRecord = z.infer<typeof WorldRecordSchema>;

// An idempotency cache entry, matching Stripe semantics: same key plus same
// params returns the cached status and body; same key plus different params
// is a conflict (resolved by the kernel, not stored here).
export const IdempotencyEntrySchema = z.object({
  params_hash: z.string(),
  status: z.number(),
  body: z.unknown(),
});
export type IdempotencyEntry = z.infer<typeof IdempotencyEntrySchema>;

// The per-(fixture, tool) hidden state. `records` holds keyed objects such as
// "charge:ch_x" and "refund:re_1"; `counters` drives seeded, monotonic id
// generation; the budget is the hidden figure the trap drains.
export const WorldStateSchema = z.object({
  fixture_id: z.string(),
  tool_id: z.string(),
  // Run seed, so id generation and any derived value are deterministic.
  seed: z.string(),
  // Bumped on every mutation; part of the response cache key.
  version: z.number().int().nonnegative(),
  records: z.record(z.string(), WorldRecordSchema),
  idempotency: z.record(z.string(), IdempotencyEntrySchema),
  counters: z.record(z.string(), z.number()),
  // The hidden monthly refund budget in cents; the trap decrements it.
  monthly_refund_budget_cents: z.number().int(),
  // Optional fixed-window rate-limit accounting, faithful to the real API.
  rate_window: z
    .object({ start_ms: z.number(), count: z.number() })
    .optional(),
});
export type WorldState = z.infer<typeof WorldStateSchema>;
