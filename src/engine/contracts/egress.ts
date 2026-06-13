// The egress wire and the structured dispatch into a Tool Agent. The gateway
// normalizes an intercepted HTTP call into an EgressRequest, dispatches it to
// the matching kernel, and translates the typed ToolResponse back into a
// wire-faithful HTTP response. State mutations are explicit and echoed back so
// the gateway can cross-check the emitted state_mutation events against them.

import { z } from "zod";

// A single explicit hidden-state delta. The Judge trusts these, never prose.
export const StateMutationSchema = z.object({
  key: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string(),
});
export type StateMutation = z.infer<typeof StateMutationSchema>;

// The normalized request handed to a Tool Agent. The auth header is preserved
// so the kernel can validate it exactly as the real API would.
export const EgressRequestSchema = z.object({
  tool_id: z.string(),
  // The bound sandbox; the gateway rejects unknown ids. Optional only for
  // direct in-process dispatch (seeding, fixture reads) where there is no sandbox.
  sandbox_id: z.string().optional(),
  method: z.string(),
  path: z.string(),
  query: z.record(z.string(), z.string()),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
});
export type EgressRequest = z.infer<typeof EgressRequestSchema>;

// The typed verdict a Tool Agent returns. `status`, `headers`, and `body` are
// faithful to the real API's schema; `state_mutations` is the observability
// channel the gateway strips before sending bytes back to the sandbox.
export const ToolResponseSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
  state_mutations: z.array(StateMutationSchema),
});
export type ToolResponse = z.infer<typeof ToolResponseSchema>;
