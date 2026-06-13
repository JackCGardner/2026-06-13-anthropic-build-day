// The shared egress core: the transport-agnostic trap logic that turns one
// intercepted outbound HTTP call into a deterministic kernel dispatch and a
// wire-faithful HTTP response, while writing the full causal trace chain. Both
// the local Node http gateway (src/world/gateway.ts) and the deployed Next.js
// forwardURL route (app/api/egress/[[...path]]/route.ts) drive this one module,
// so the trap is defined exactly once and the two transports differ only in how
// they obtain the binding tag and the raw request bytes.
//
// The core does four things per request, given a resolved binding and a world
// resolver:
//   1. resolve the tool_id from the request host or path prefix,
//   2. dispatch the normalized EgressRequest into the matching kernel against
//      the fixture's scoped WorldState,
//   3. write the causal trace chain (egress begin -> tool_dispatch begin ->
//      state_mutation(s) -> tool_dispatch end -> egress end) through the single
//      injected trace writer the World Runner owns,
//   4. strip the observability channel (state_mutations, the enforced-invariant
//      overlay header) from the bytes and return a wire-faithful response.
//
// A missing or unbound tag, or a host/path that maps to no tool, is a loud
// failure: the core answers 502 with a faithful error envelope and emits a trace
// point, never silently serving a default kernel or a default fixture. The trace
// writer is injected so the World Runner stays the single writer of `seq`; the
// world resolver is injected so the core never reaches into runner internals.

import type {
  EgressRequest,
  ToolResponse,
  TraceEvent,
  WorldState,
  HarnessVersion,
} from "@/engine";
import { kernelFor } from "@/engine/kernels/index.js";
import {
  STRIPE_TOOL_ID,
  ORDERS_TOOL_ID,
  CUSTOMERS_TOOL_ID,
  POLICY_TOOL_ID,
  ZENDESK_TOOL_ID,
} from "@/engine/kernels/index.js";

// The header a bound sandbox carries on every outbound call in the M0 transport.
// The local bash substrate injects it into the request environment; the gateway
// reads it to resolve which fixture's hidden state this call belongs to. The
// value is the opaque tag the World Runner handed back from `bind`. In the M1
// forwardURL transport the binding is carried instead by the validated OIDC
// token's sandbox identity, but both transports converge on the same core.
export const SANDBOX_TAG_HEADER = "x-synth-sandbox-tag" as const;

// The environment variable name the substrate sets so its outbound HTTP carries
// the binding tag. Exposed so the bash substrate and both transports agree on it.
export const SANDBOX_TAG_ENV = "SYNTH_SANDBOX_TAG" as const;

// The single trace writer the core emits through. The World Runner owns this: it
// assigns `seq` and `ts` so the per-fixture trace stays a total order. The core
// supplies everything else, including the run_id and fixture_id the binding
// resolved, and reads back the assigned `seq` to parent the next hop.
export type EgressTraceWriter = (
  event: Omit<TraceEvent, "v" | "seq" | "ts">,
) => TraceEvent;

// How the core resolves a bound fixture to its scoped per-tool world. The World
// Runner seeds one WorldState per kernel tool id for a fixture and exposes it
// here; the core dispatches a request to the slice for the resolved tool_id.
// Returning undefined means the fixture is not (or no longer) live, and the core
// rejects the call loud.
export type WorldResolver = (
  fixtureId: string,
) => Record<string, WorldState> | undefined;

// The binding a sandbox identity resolves to: the fixture whose world the call
// hits, the run the trace belongs to, and the harness version that frames each
// event. The M0 transport resolves this from the tag header; the M1 transport
// resolves it from the validated OIDC sandbox identity. Either way the core
// receives an already-resolved binding.
export interface SandboxBinding {
  fixtureId: string;
  runId: string;
  harnessVersion: HarnessVersion;
}

// The normalized inbound call, transport-agnostic. Both transports parse their
// raw bytes into this shape before handing it to the core: the proxy form of an
// intercepted call carries an absolute URL, the base-URL form carries a path
// with the synthetic host in `host`; both reduce to (host, method, path, query,
// headers, body) here.
export interface NormalizedRequest {
  // The synthetic service host the call targeted, if known. Undefined when the
  // call was a path-only base-URL rewrite to the gateway itself.
  host: string | undefined;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

// The wire response the core returns: the kernel's faithful status, headers, and
// JSON body, with the observability channel already stripped. A transport
// serializes this to actual bytes.
export interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// ---------------------------------------------------------------------------
// Tool-id resolution. A real sandbox calls real hostnames (api.stripe.com, the
// internal orders/customers services, the policy store, the Zendesk API). The
// core resolves the tool_id first from the request host and falls back to the
// path prefix, so both a host-routed proxy/forwardURL call and a base-URL
// rewritten call resolve to the same kernel. The path prefixes mirror exactly
// what each kernel's router matches, so a resolved request always lands on a
// real route inside its kernel.
// ---------------------------------------------------------------------------

// Hostnames the synthetic services answer on. The substrate may route outbound
// calls by host to these names; the core maps each to its short kernel id.
// Matching is suffix-based so api.stripe.com and stripe.local both resolve,
// which keeps the fixtures and the proxy config readable.
const HOST_TO_TOOL: ReadonlyArray<{ suffix: string; toolId: string }> = [
  { suffix: "stripe.com", toolId: STRIPE_TOOL_ID },
  { suffix: "stripe.local", toolId: STRIPE_TOOL_ID },
  { suffix: "orders.local", toolId: ORDERS_TOOL_ID },
  { suffix: "orders.internal", toolId: ORDERS_TOOL_ID },
  { suffix: "customers.local", toolId: CUSTOMERS_TOOL_ID },
  { suffix: "customers.internal", toolId: CUSTOMERS_TOOL_ID },
  { suffix: "policy.local", toolId: POLICY_TOOL_ID },
  { suffix: "policy.internal", toolId: POLICY_TOOL_ID },
  { suffix: "zendesk.com", toolId: ZENDESK_TOOL_ID },
  { suffix: "zendesk.local", toolId: ZENDESK_TOOL_ID },
];

// Path prefixes each kernel routes under. Ordered longest-first so a more
// specific prefix wins; every entry corresponds to a route the kernel matches.
const PATH_PREFIX_TO_TOOL: ReadonlyArray<{ prefix: string; toolId: string }> = [
  { prefix: "/api/v2/tickets", toolId: ZENDESK_TOOL_ID },
  { prefix: "/v1/refunds", toolId: STRIPE_TOOL_ID },
  { prefix: "/v1/charges", toolId: STRIPE_TOOL_ID },
  { prefix: "/orders", toolId: ORDERS_TOOL_ID },
  { prefix: "/customers", toolId: CUSTOMERS_TOOL_ID },
  { prefix: "/policy", toolId: POLICY_TOOL_ID },
];

// Resolve a tool_id from the request host, then the path prefix. Returns
// undefined when neither matches, which the core treats as an unknown tool and
// rejects loud rather than guessing a kernel.
export function resolveToolId(
  host: string | undefined,
  path: string,
): string | undefined {
  const hostname = normalizeHost(host);
  if (hostname.length > 0) {
    for (const entry of HOST_TO_TOOL) {
      if (hostname === entry.suffix || hostname.endsWith(`.${entry.suffix}`)) {
        return entry.toolId;
      }
    }
  }
  for (const entry of PATH_PREFIX_TO_TOOL) {
    if (path === entry.prefix || path.startsWith(`${entry.prefix}/`)) {
      return entry.toolId;
    }
  }
  return undefined;
}

// Strip the port and lowercase a Host header value. A localhost host (the
// gateway itself, hit via base-URL rewriting) is not a synthetic service, so it
// yields an empty hostname and resolution falls through to the path prefix.
function normalizeHost(host: string | undefined): string {
  if (host === undefined) return "";
  const bare = host.split(":")[0]?.toLowerCase() ?? "";
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]") {
    return "";
  }
  return bare;
}

// ---------------------------------------------------------------------------
// The core dispatch. A transport calls handleEgress with the binding it
// resolved (or undefined for an unbound/missing identity), the normalized
// request, and the World Runner's injected trace writer and world resolver.
// ---------------------------------------------------------------------------

export interface HandleEgressInput {
  // The resolved binding, or undefined when the transport could not place the
  // call (missing/unknown tag, invalid OIDC token). The core rejects loud.
  binding: SandboxBinding | undefined;
  // The opaque sandbox identity the transport observed, surfaced on the
  // EgressRequest and the rejection trace even when no binding resolved.
  sandboxId: string | undefined;
  request: NormalizedRequest;
  trace: EgressTraceWriter;
  resolveWorld: WorldResolver;
}

// The single entry point both transports share. Resolves the tool_id and world,
// dispatches into the kernel, emits the full trace chain, and returns the
// wire-faithful response. Loud on every failure: no default kernel, no default
// fixture, no silent success.
export function handleEgress(input: HandleEgressInput): WireResponse {
  const { binding, sandboxId, request, trace, resolveWorld } = input;
  const { host, method, path, query, headers, body } = request;
  const url = host !== undefined ? `http://${host}${path}` : path;

  // A missing or unbound identity is a loud failure: there is no fixture to
  // scope the call to. Emit a trace point so the misconfiguration is visible.
  if (binding === undefined) {
    return rejectUnbound({ trace, sandboxId, method, url, host, path, query, headers, body });
  }

  const toolId = resolveToolId(host, path);
  const world = resolveWorld(binding.fixtureId);

  // An unknown tool or an unresolvable world is a loud failure: the core never
  // serves a default kernel or a default fixture.
  if (toolId === undefined || world === undefined) {
    return rejectUnknownTool({
      trace,
      binding,
      method,
      url,
      toolId,
      req: {
        tool_id: toolId ?? "",
        ...(sandboxId !== undefined ? { sandbox_id: sandboxId } : {}),
        method,
        path,
        query,
        headers,
        body,
      },
    });
  }

  const egressReq: EgressRequest = {
    tool_id: toolId,
    ...(sandboxId !== undefined ? { sandbox_id: sandboxId } : {}),
    method,
    path,
    query,
    headers,
    body,
  };

  return dispatch({ trace, binding, req: egressReq, url, world });
}

// The unbound/missing-identity rejection: a single egress point event records
// the bad call and the 502 the sandbox sees. There is no run to parent it to, so
// the event stands alone under a synthetic unbound run id.
function rejectUnbound(args: {
  trace: EgressTraceWriter;
  sandboxId: string | undefined;
  method: string;
  url: string;
  host: string | undefined;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}): WireResponse {
  const { trace, sandboxId, method, url, host, path, query, headers, body } = args;
  const errorBody = {
    error: {
      type: "api_error",
      code: "unbound_sandbox",
      message:
        sandboxId === undefined
          ? `Missing sandbox identity; the sandbox is not bound to a fixture.`
          : `Unknown sandbox identity '${sandboxId}'; no fixture is bound.`,
    },
  };
  trace({
    run_id: "unbound",
    fixture_id: "unbound",
    harness_version: "v1",
    parent_seq: null,
    actor: "bash",
    kind: "egress",
    span: { id: "eg_unbound", phase: "point" },
    payload: {
      method,
      url,
      request_headers: headers,
      request_body: body,
      status: 502,
      response_body: errorBody,
      rejected: "unbound_sandbox",
      host: host ?? "",
      path,
      query,
    },
  });
  return { status: 502, headers: JSON_HEADERS, body: errorBody };
}

// The unknown-tool rejection: the identity was bound, so the event is parented
// under the fixture's run, but no kernel matched the host/path. Answer 502 with
// a faithful envelope and record the rejection.
function rejectUnknownTool(args: {
  trace: EgressTraceWriter;
  binding: SandboxBinding;
  method: string;
  url: string;
  toolId: string | undefined;
  req: EgressRequest;
}): WireResponse {
  const { trace, binding, method, url, toolId, req } = args;
  const errorBody = {
    error: {
      type: "api_error",
      code: "unknown_tool",
      message:
        toolId === undefined
          ? `No synthetic tool routes ${method} ${url}.`
          : `No live world for fixture '${binding.fixtureId}'.`,
    },
  };
  trace({
    run_id: binding.runId,
    fixture_id: binding.fixtureId,
    harness_version: binding.harnessVersion,
    parent_seq: null,
    actor: "bash",
    kind: "egress",
    span: { id: `eg_unknown_${method}`, phase: "point" },
    payload: {
      method,
      url,
      request_headers: req.headers,
      request_body: req.body,
      status: 502,
      response_body: errorBody,
      rejected: "unknown_tool",
    },
  });
  return { status: 502, headers: JSON_HEADERS, body: errorBody };
}

// The happy path: emit the egress begin, the tool_dispatch begin, run the kernel
// against the scoped state, emit each state_mutation parented to the dispatch,
// then close the dispatch and the egress. The wire body is the kernel's body
// with the observability channel stripped.
function dispatch(args: {
  trace: EgressTraceWriter;
  binding: SandboxBinding;
  req: EgressRequest;
  url: string;
  world: Record<string, WorldState>;
}): WireResponse {
  const { trace, binding, req, url, world } = args;
  const frame = {
    run_id: binding.runId,
    fixture_id: binding.fixtureId,
    harness_version: binding.harnessVersion,
  } as const;

  const egressBegin = trace({
    ...frame,
    parent_seq: null,
    actor: "bash",
    kind: "egress",
    span: { id: `eg_${req.tool_id}`, phase: "begin" },
    payload: {
      method: req.method,
      url,
      request_headers: req.headers,
      request_body: req.body,
    },
  });

  const kernel = kernelFor(req.tool_id);
  const state = world[req.tool_id];

  // A resolved tool_id with no registered kernel or no seeded slice is still a
  // loud failure: close the egress 502 rather than serving an empty body.
  if (kernel === undefined || state === undefined) {
    const errorBody = {
      error: {
        type: "api_error",
        code: "unknown_tool",
        message: `No kernel for tool '${req.tool_id}'.`,
      },
    };
    trace({
      ...frame,
      parent_seq: egressBegin.seq,
      actor: "bash",
      kind: "egress",
      span: { id: egressBegin.span.id, phase: "end" },
      payload: {
        status: 502,
        url,
        response_body: errorBody,
        rejected: "unknown_tool",
      },
    });
    return { status: 502, headers: JSON_HEADERS, body: errorBody };
  }

  const dispatchBegin = trace({
    ...frame,
    parent_seq: egressBegin.seq,
    actor: `tool:${req.tool_id}`,
    kind: "tool_dispatch",
    span: { id: `td_${req.tool_id}`, phase: "begin" },
    payload: { tool_id: req.tool_id, request: req },
  });

  const response: ToolResponse = kernel(req, state);

  // Echo every hidden-state delta as an explicit state_mutation parented to the
  // dispatch. This is the observability channel: the Judge trusts these lines,
  // and they are emitted here but stripped from the bytes the sandbox receives.
  for (const mutation of response.state_mutations) {
    trace({
      ...frame,
      parent_seq: dispatchBegin.seq,
      actor: `tool:${req.tool_id}`,
      kind: "state_mutation",
      span: { id: `sm_${req.tool_id}`, phase: "point" },
      payload: {
        key: mutation.key,
        before: mutation.before,
        after: mutation.after,
        reason: mutation.reason,
      },
    });
  }

  trace({
    ...frame,
    parent_seq: dispatchBegin.seq,
    actor: `tool:${req.tool_id}`,
    kind: "tool_dispatch",
    span: { id: dispatchBegin.span.id, phase: "end" },
    payload: { status: response.status, body: response.body },
  });

  trace({
    ...frame,
    parent_seq: egressBegin.seq,
    actor: "bash",
    kind: "egress",
    span: { id: egressBegin.span.id, phase: "end" },
    payload: {
      status: response.status,
      url,
      response_headers: response.headers,
      response_body: response.body,
      enforced_invariants_checked: invariantsHeader(response.headers),
    },
  });

  // Strip the observability channel from the wire response. `state_mutations`
  // and any injected-latency field never cross to the sandbox; only the faithful
  // status, headers, and JSON body do.
  return {
    status: response.status,
    headers: stripObservabilityHeaders(response.headers),
    body: response.body,
  };
}

// ---------------------------------------------------------------------------
// Shared wire helpers. Both transports reuse these so the bytes they emit are
// identical regardless of which one served the call.
// ---------------------------------------------------------------------------

export const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json",
};

// Drop the gateway-internal headers a kernel may attach for the trace overlay
// (the enforced-invariants list) so the bytes the sandbox sees stay wire-faithful
// to the real API, which never sends them.
export function stripObservabilityHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-enforced-invariants") continue;
    out[k] = v;
  }
  return out;
}

// Pull the kernel's enforced-invariant list off the response header so the egress
// end event can surface exactly what the API gated on, for the demo overlay.
function invariantsHeader(
  headers: Record<string, string>,
): string[] | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-enforced-invariants" && v.length > 0) {
      return v.split(",");
    }
  }
  return undefined;
}

// Decode a request body into the shape a kernel reads. A JSON content type is
// parsed to an object; everything else (form-encoded, empty) is passed through
// as the raw string, which the kernels' parseBody already handles. Shared so
// both transports normalize bodies identically.
export function decodeBody(raw: string, contentType: string | undefined): unknown {
  if (raw.length === 0) return null;
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
