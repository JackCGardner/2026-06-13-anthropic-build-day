// The egress gateway: the synthetic-world seam that turns a real outbound HTTP
// call from a sandboxed shell into a deterministic kernel dispatch. It is a
// standalone Node http server, not a framework route, so the CLI can stand it up
// keyless on an ephemeral localhost port and point a sandbox's HTTP(S)_PROXY and
// base URL at it.
//
// Per request it: reads the per-sandbox binding tag header to resolve the
// (fixtureId, runId) the call belongs to, resolves that fixture's scoped
// WorldState, maps the request host or path prefix to a tool_id, normalizes the
// intercepted call into an EgressRequest, dispatches it to the matching kernel,
// writes the full causal trace chain (egress begin -> tool_dispatch ->
// state_mutation(s) -> tool_dispatch end -> egress end) through the single trace
// writer the World Runner owns, strips the observability fields (state_mutations,
// any injected latency) from the wire body, and serializes a wire-faithful HTTP
// response with the kernel's status, headers, and JSON body.
//
// An unbound tag, a missing tag, or a path that maps to no tool is a loud
// failure: the gateway answers 502 with an error envelope and emits a trace
// event, never silently serving a default. This keeps a misconfigured sandbox
// visible in the trace rather than producing a quietly wrong run.
//
// The trace writer is injected (`trace`) rather than owned here so the World
// Runner stays the single writer of `seq` for a fixture. The world resolver is
// injected (`resolveWorld`) so the gateway never reaches into runner internals.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

// The header a bound sandbox carries on every outbound call. The local bash
// substrate injects it into the request environment; the gateway reads it to
// resolve which fixture's hidden state this call belongs to. The value is the
// opaque tag the gateway handed back from `bind`.
export const SANDBOX_TAG_HEADER = "x-synth-sandbox-tag" as const;

// The environment variable name the substrate sets so its outbound HTTP carries
// the binding tag. Exposed so the bash substrate and the gateway agree on it.
export const SANDBOX_TAG_ENV = "SYNTH_SANDBOX_TAG" as const;

// The single trace writer the gateway emits through. The World Runner owns this:
// it assigns `seq` and `ts` so the per-fixture trace stays a total order. The
// gateway supplies everything else, including the run_id and fixture_id the
// binding resolved, and reads back the assigned `seq` to parent the next hop.
export type GatewayTraceWriter = (
  event: Omit<TraceEvent, "v" | "seq" | "ts">,
) => TraceEvent;

// How the gateway resolves a bound fixture to its scoped per-tool world. The
// World Runner seeds one WorldState per kernel tool id for a fixture and exposes
// it here; the gateway dispatches a request to the slice for the resolved
// tool_id. Returning undefined means the fixture is not (or no longer) live, and
// the gateway rejects the call loud.
export type WorldResolver = (
  fixtureId: string,
) => Record<string, WorldState> | undefined;

export interface CreateEgressGatewayOptions {
  resolveWorld: WorldResolver;
  trace: GatewayTraceWriter;
}

// The binding a sandbox tag resolves to: the fixture whose world the call hits,
// the run the trace belongs to, and the harness version that frames each event.
interface SandboxBinding {
  fixtureId: string;
  runId: string;
  harnessVersion: HarnessVersion;
}

// The public surface the World Runner drives. `bind` registers a sandbox tag
// before a harness starts issuing calls; `unbind` retires it when the fixture
// finishes; `close` tears the server down. `url` and `port` are the ephemeral
// localhost address the substrate injects as the base URL and proxies through;
// the OS assigns the port at listen time, which is why the factory is async.
export interface EgressGateway {
  url: string;
  port: number;
  bind(
    tag: string,
    fixtureId: string,
    runId: string,
    harnessVersion: HarnessVersion,
  ): void;
  unbind(tag: string): void;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tool-id resolution. A real sandbox calls real hostnames (api.stripe.com, the
// internal orders/customers services, the policy store, the Zendesk API). The
// gateway resolves the tool_id first from the request host and falls back to the
// path prefix, so both a host-routed proxy call and a base-URL-rewritten call to
// the gateway resolve to the same kernel. The path prefixes mirror exactly what
// each kernel's router matches, so a resolved request always lands on a real
// route inside its kernel.
// ---------------------------------------------------------------------------

// Hostnames the synthetic services answer on. The substrate may route outbound
// calls by host (via the proxy) to these names; the gateway maps each to its
// short kernel id. Matching is suffix-based so api.stripe.com and stripe.local
// both resolve, which keeps the fixtures and the proxy config readable.
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
// undefined when neither matches, which the gateway treats as an unknown tool and
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

// Strip the port and lowercase a Host header value. A localhost host (the gateway
// itself, hit via base-URL rewriting) is not a synthetic service, so it yields an
// empty hostname and resolution falls through to the path prefix.
function normalizeHost(host: string | undefined): string {
  if (host === undefined) return "";
  const bare = host.split(":")[0]?.toLowerCase() ?? "";
  if (bare === "localhost" || bare === "127.0.0.1" || bare === "[::1]") {
    return "";
  }
  return bare;
}

// ---------------------------------------------------------------------------
// Request normalization. The proxy form of an intercepted call carries an
// absolute request URL (http://api.stripe.com/v1/refunds); the base-URL form
// carries a path-only target with the synthetic host in the Host header. Both
// normalize to the same EgressRequest.
// ---------------------------------------------------------------------------

interface ParsedTarget {
  host: string | undefined;
  path: string;
  query: Record<string, string>;
}

function parseTarget(req: IncomingMessage): ParsedTarget {
  const rawUrl = req.url ?? "/";
  const headerHost = firstHeader(req.headers.host);
  // An absolute-form request line (proxy style) carries scheme://host/path.
  // A path-only target relies on the Host header for the synthetic service.
  const base = `http://${headerHost ?? "localhost"}`;
  const url = new URL(rawUrl, base);
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    query[k] = v;
  }
  const isAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl);
  const host = isAbsolute ? url.host : headerHost;
  return { host, path: url.pathname, query };
}

// Read a single header value, collapsing the array form Node may hand back.
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

// Flatten Node's header bag into the flat string record the EgressRequest and
// the kernels read. Multi-value headers collapse to their first value, which is
// faithful for the single-valued headers these synthetic APIs read.
function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const first = firstHeader(v);
    if (first !== undefined) out[k] = first;
  }
  return out;
}

// Read the full request body as a string. The kernels parse both form-encoded
// (Stripe) and JSON (internal services) bodies, so the gateway hands the raw
// string through for GET/DELETE with no body and the decoded payload otherwise.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

// Decode the request body into the shape a kernel reads. A JSON content type is
// parsed to an object; everything else (form-encoded, empty) is passed through as
// the raw string, which the kernels' parseBody already handles.
function decodeBody(raw: string, contentType: string | undefined): unknown {
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

// ---------------------------------------------------------------------------
// The gateway factory.
// ---------------------------------------------------------------------------

export async function createEgressGateway(
  options: CreateEgressGatewayOptions,
): Promise<EgressGateway> {
  const { resolveWorld, trace } = options;
  const bindings = new Map<string, SandboxBinding>();

  const server: Server = createServer((req, res) => {
    handleRequest(req)
      .then(({ status, headers, body }) => {
        writeResponse(res, status, headers, body);
      })
      .catch((error: unknown) => {
        // A thrown handler is itself a loud failure: answer 502 with a faithful
        // error envelope so a broken request never hangs the sandbox.
        const message = error instanceof Error ? error.message : String(error);
        writeResponse(res, 502, JSON_HEADERS, {
          error: { type: "api_error", code: "gateway_error", message },
        });
      });
  });

  // Resolve the binding, world slice, and tool kernel, dispatch, and emit the
  // full trace chain. Returns the wire response (status, headers, stripped body).
  async function handleRequest(req: IncomingMessage): Promise<WireResponse> {
    const headers = flattenHeaders(req);
    const tag = headers[SANDBOX_TAG_HEADER];
    const { host, path, query } = parseTarget(req);
    const method = (req.method ?? "GET").toUpperCase();
    const rawBody = await readBody(req);
    const body = decodeBody(rawBody, headers["content-type"]);
    const url = host !== undefined ? `http://${host}${path}` : path;

    // A missing or unbound tag is a loud failure: there is no fixture to scope
    // the call to, so the gateway cannot serve it. Emit a trace point so the
    // misconfiguration is visible, then answer 502.
    const binding = tag !== undefined ? bindings.get(tag) : undefined;
    if (binding === undefined) {
      return rejectUnbound(tag, method, url, host, path, query, headers, body);
    }

    const toolId = resolveToolId(host, path);
    const world = resolveWorld(binding.fixtureId);

    // An unknown tool or an unresolvable world is a loud failure: the gateway
    // never serves a default kernel or a default fixture.
    if (toolId === undefined || world === undefined) {
      return rejectUnknownTool(binding, method, url, toolId, {
        tool_id: toolId ?? "",
        sandbox_id: tag,
        method,
        path,
        query,
        headers,
        body,
      });
    }

    const egressReq: EgressRequest = {
      tool_id: toolId,
      sandbox_id: tag,
      method,
      path,
      query,
      headers,
      body,
    };

    return dispatch(binding, egressReq, url, world);
  }

  // The unbound/missing-tag rejection: a single egress point event records the
  // bad call and the 502 the sandbox sees. There is no run to parent it to, so
  // the event stands alone under a synthetic unbound run id.
  function rejectUnbound(
    tag: string | undefined,
    method: string,
    url: string,
    host: string | undefined,
    path: string,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: unknown,
  ): WireResponse {
    const errorBody = {
      error: {
        type: "api_error",
        code: "unbound_sandbox",
        message:
          tag === undefined
            ? `Missing ${SANDBOX_TAG_HEADER}; the sandbox is not bound to a fixture.`
            : `Unknown sandbox tag '${tag}'; no fixture is bound.`,
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

  // The unknown-tool rejection: the tag was bound, so the event is parented under
  // the fixture's run, but no kernel matched the host/path. Answer 502 with a
  // faithful envelope and record the rejection.
  function rejectUnknownTool(
    binding: SandboxBinding,
    method: string,
    url: string,
    toolId: string | undefined,
    req: EgressRequest,
  ): WireResponse {
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

  // The happy path: emit the egress begin, the tool_dispatch begin, run the
  // kernel against the scoped state, emit each state_mutation parented to the
  // dispatch, then close the dispatch and the egress. The wire body is the
  // kernel's body with the observability channel stripped.
  function dispatch(
    binding: SandboxBinding,
    req: EgressRequest,
    url: string,
    world: Record<string, WorldState>,
  ): WireResponse {
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
    // and any injected-latency field never cross to the sandbox; only the
    // faithful status, headers, and JSON body do.
    return {
      status: response.status,
      headers: stripObservabilityHeaders(response.headers),
      body: response.body,
    };
  }

  // Bind to an ephemeral localhost port. The OS assigns the port on the
  // listening event, so the factory resolves once the address is known.
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    port,
    bind(tag, fixtureId, runId, harnessVersion) {
      bindings.set(tag, { fixtureId, runId, harnessVersion });
    },
    unbind(tag) {
      bindings.delete(tag);
    },
    close() {
      return new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Wire serialization helpers.
// ---------------------------------------------------------------------------

interface WireResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json",
};

// Serialize the wire response: a JSON body with the kernel's status and headers.
// The content type defaults to application/json since every kernel speaks JSON.
function writeResponse(
  res: import("node:http").ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): void {
  const payload = JSON.stringify(body ?? null);
  const outHeaders: Record<string, string> = { ...headers };
  if (!hasHeader(outHeaders, "content-type")) {
    outHeaders["content-type"] = "application/json";
  }
  outHeaders["content-length"] = String(Buffer.byteLength(payload));
  res.writeHead(status, outHeaders);
  res.end(payload);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

// Drop the gateway-internal headers a kernel may attach for the trace overlay
// (the enforced-invariants list) so the bytes the sandbox sees stay wire-faithful
// to the real API, which never sends them.
function stripObservabilityHeaders(
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
