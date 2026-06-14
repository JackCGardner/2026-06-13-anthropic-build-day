// Shared helpers for the deterministic State Kernels. A kernel is a pure-ish
// function (EgressRequest, WorldState) => ToolResponse: it reads and writes its
// own scoped slice of hidden world state, enforces only the invariants its real
// API enforces, and echoes every hidden-state delta back as a StateMutation.
// Nothing here calls a model and nothing here is random; ids are seeded and
// monotonic so the same request against the same state always yields the same
// response and the same mutations.

import type {
  EgressRequest,
  IdempotencyEntry,
  StateMutation,
  ToolResponse,
  WorldState,
} from "../contracts/index.js";

// A scoped view over one tool's slice of hidden world state. Every kernel
// touches state only through this store so that each mutation is explicit and
// the new state version is threaded through deterministically. The store
// accumulates a mutation log; the kernel returns it verbatim as
// ToolResponse.state_mutations, and the same deltas are what a caller would
// emit as state_mutation trace events.
export class ScopedStore {
  private mutations: StateMutation[] = [];

  constructor(private state: WorldState) {}

  // Read a keyed record, e.g. "charge:ch_x" or "refund:re_1". Undefined when
  // the record does not exist; kernels decide the faithful status code.
  get(key: string): Record<string, unknown> | undefined {
    return this.state.records[key];
  }

  // Read the single record whose key belongs to a family, e.g. "policy" matches
  // the seeded "policy:refund". Keys are scanned in insertion order; the first
  // match wins. Used by a singleton-resource read (a GET with no id in the path)
  // that returns the one record its family holds. Undefined when none exists.
  firstByPrefix(family: string): Record<string, unknown> | undefined {
    const prefix = `${family}:`;
    for (const [key, value] of Object.entries(this.state.records)) {
      if (key.startsWith(prefix)) return value;
    }
    return undefined;
  }

  // The current monthly refund budget in cents. The hidden figure the trap drains.
  budgetCents(): number {
    return this.state.monthly_refund_budget_cents;
  }

  // Write or overwrite a keyed record. Bumps the state version and logs the
  // delta with a human-readable reason the Judge and viewer can read.
  set(key: string, value: Record<string, unknown>, reason: string): void {
    const before = this.state.records[key];
    this.state.records[key] = value;
    this.state.version += 1;
    this.mutations.push({ key, before, after: value, reason });
  }

  // Decrement the monthly refund budget by a positive amount of cents. This is
  // the one mutation that carries the thesis: a faithful refund moves money and
  // the API never consulted a business rule before it did.
  decrementBudget(amountCents: number, reason: string): void {
    const before = this.state.monthly_refund_budget_cents;
    const after = before - amountCents;
    this.state.monthly_refund_budget_cents = after;
    this.state.version += 1;
    this.mutations.push({
      key: "stripe.monthly_refund_budget_cents",
      before,
      after,
      reason,
    });
  }

  // Record an idempotency outcome so a retried request with the same key and
  // params returns the cached body and emits no new budget mutation, exactly as
  // real Stripe behaves. Idempotency bookkeeping is internal, so it is not
  // surfaced as a hidden-state mutation the Judge scores against.
  recordIdempotency(
    key: string,
    paramsHash: string,
    status: number,
    body: unknown,
  ): void {
    this.state.idempotency[key] = { params_hash: paramsHash, status, body };
  }

  getIdempotency(key: string): IdempotencyEntry | undefined {
    return this.state.idempotency[key];
  }

  // Allocate the next seeded, monotonic id for a prefix, e.g. ("re") -> "re_1".
  // Counters live in state so ids are stable across a deterministic replay.
  nextId(prefix: string): string {
    const current = this.state.counters[prefix] ?? 0;
    const next = current + 1;
    this.state.counters[prefix] = next;
    return `${prefix}_${next}`;
  }

  // The accumulated, ordered list of deltas to echo back to the caller.
  drainMutations(): StateMutation[] {
    return this.mutations;
  }
}

// Build a faithful JSON response. The body is serialized by the gateway; the
// kernel returns the typed object so a caller can both trace it and re-encode it.
export function jsonResponse(
  status: number,
  body: unknown,
  mutations: StateMutation[] = [],
): ToolResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body,
    state_mutations: mutations,
  };
}

// A wire-faithful error envelope. Stripe nests errors under an `error` object
// with a `code`; the orders/customers/policy/zendesk services use a flat shape.
// `style` selects the envelope so each kernel matches its real API.
export function errorResponse(
  status: number,
  code: string,
  message: string,
  style: "stripe" | "flat" = "flat",
): ToolResponse {
  const body =
    style === "stripe"
      ? { error: { type: errorTypeForStatus(status), code, message } }
      : { error: code, message };
  return jsonResponse(status, body);
}

function errorTypeForStatus(status: number): string {
  if (status === 404) return "invalid_request_error";
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  return "api_error";
}

// Parse a request body that may arrive as parsed JSON, a form-encoded string,
// or an already-decoded record. Stripe speaks application/x-www-form-urlencoded;
// the internal services speak JSON. This normalizes all three to a flat record
// of string values so a kernel reads fields uniformly.
export function parseBody(body: unknown): Record<string, string> {
  if (body === null || body === undefined) return {};
  if (typeof body === "string") return parseFormEncoded(body);
  if (typeof body === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = v === undefined || v === null ? "" : String(v);
    }
    return out;
  }
  return {};
}

function parseFormEncoded(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : pair.slice(eq + 1);
    out[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return out;
}

// A stable, order-insensitive hash of request params for idempotency conflict
// detection. Deterministic and dependency-free: sorted key=value pairs joined.
export function hashParams(params: Record<string, string>): string {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

// Read the final, non-empty path segment, e.g. "/orders/ord_1" -> "ord_1" and
// "/customers/jane%40acme.com" -> "jane@acme.com". Used by the GET-by-id tools.
export function lastPathSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  const seg = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  return decodeURIComponent(seg);
}
