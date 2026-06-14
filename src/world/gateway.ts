// The egress gateway: the synthetic-world seam that turns a real outbound HTTP
// call from a sandboxed shell into a deterministic kernel dispatch. It is a
// standalone Node http server, not a framework route, so the CLI can stand it up
// keyless on an ephemeral localhost port and point a sandbox's HTTP(S)_PROXY and
// base URL at it.
//
// This file owns only the local-transport concerns: standing up the Node http
// server, reading the per-sandbox binding tag header, normalizing the
// intercepted request bytes, and serializing the wire response. The trap itself
// (resolve binding -> tool_id -> kernel dispatch -> trace hops -> wire-faithful
// response with observability stripped) lives in the shared egress core, which
// the deployed Next.js forwardURL route also drives. The two transports differ
// only in how they obtain the binding and the raw bytes; the kernel dispatch and
// trace writing are defined once, in egress-core.ts.
//
// An unbound tag, a missing tag, or a path that maps to no tool is a loud
// failure: the core answers 502 with an error envelope and emits a trace event,
// never silently serving a default. This keeps a misconfigured sandbox visible
// in the trace rather than producing a quietly wrong run.
//
// The trace writer is injected (`trace`) rather than owned here so the World
// Runner stays the single writer of `seq` for a fixture. The world resolver is
// injected (`resolveWorld`) so the gateway never reaches into runner internals.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { HarnessVersion } from "@/engine";
import {
  handleEgress,
  handleEgressWithPersona,
  decodeBody,
  resolveToolId,
  SANDBOX_TAG_HEADER,
  SANDBOX_TAG_ENV,
  JSON_HEADERS,
  type SandboxBinding,
  type WorldResolver,
  type PersonaRegistry,
  type CallOrigin,
  type EgressTraceWriter,
  type NormalizedRequest,
  type WireResponse,
} from "./egress-core.js";

// Re-export the binding header/env names and the tool resolver so existing
// callers that imported them from the gateway keep working unchanged.
export { resolveToolId, SANDBOX_TAG_HEADER, SANDBOX_TAG_ENV };

// The trace writer the gateway emits through, kept as a named alias for the
// World Runner's existing call sites.
export type GatewayTraceWriter = EgressTraceWriter;

// The world resolver type, re-exported for the World Runner's existing imports.
export type { WorldResolver };

export interface CreateEgressGatewayOptions {
  resolveWorld: WorldResolver;
  trace: GatewayTraceWriter;
  // The optional per-tool persona registry. When present, an intercepted call is
  // served through the async persona path (kernel-first, advisory enrichment,
  // re-validation) instead of the synchronous kernel dispatch. The kernel remains
  // the authority for status, money, and state; the persona may enrich only the
  // message prose. Omitted (the default) keeps the gateway on the synchronous
  // kernel path, byte-identical to a scored run with no persona. The registry is
  // only consulted when a credential is present, which the caller gates on.
  personas?: PersonaRegistry;
  // Who drives the calls this gateway serves, stamped onto every trace event so
  // one unified trace can tell a scored run from a human session from a persona
  // dispatch. Defaults to a harness call, which leaves every payload unchanged.
  origin?: CallOrigin;
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
// Request normalization. The proxy form of an intercepted call carries an
// absolute request URL (http://api.stripe.com/v1/refunds); the base-URL form
// carries a path-only target with the synthetic host in the Host header. Both
// normalize to the same NormalizedRequest the shared core consumes.
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

// ---------------------------------------------------------------------------
// The gateway factory.
// ---------------------------------------------------------------------------

export async function createEgressGateway(
  options: CreateEgressGatewayOptions,
): Promise<EgressGateway> {
  const { resolveWorld, trace, personas, origin } = options;
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

  // Parse the request bytes, resolve the binding from the tag header, and hand
  // the normalized request to the shared core, which writes the trace chain and
  // returns the wire-faithful response.
  async function handleRequest(req: IncomingMessage): Promise<WireResponse> {
    const headers = flattenHeaders(req);
    const tag = headers[SANDBOX_TAG_HEADER];
    const { host, path, query } = parseTarget(req);
    const method = (req.method ?? "GET").toUpperCase();
    const rawBody = await readBody(req);
    const body = decodeBody(rawBody, headers["content-type"]);

    const binding = tag !== undefined ? bindings.get(tag) : undefined;
    const request: NormalizedRequest = {
      host,
      method,
      path,
      query,
      headers,
      body,
    };

    // With no persona registry the synchronous kernel path serves the call,
    // byte-identical to a scored run. With one, the async persona path is taken;
    // it falls back to the kernel for any tool the registry does not resolve, so
    // an unregistered tool is still served identically.
    if (personas === undefined) {
      return handleEgress({
        binding,
        sandboxId: tag,
        request,
        trace,
        resolveWorld,
        ...(origin !== undefined ? { origin } : {}),
      });
    }

    return handleEgressWithPersona({
      binding,
      sandboxId: tag,
      request,
      trace,
      resolveWorld,
      personas,
      ...(origin !== undefined ? { origin } : {}),
    });
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
// Wire serialization. Turning a WireResponse from the core into bytes is a
// local-transport concern, so it stays here.
// ---------------------------------------------------------------------------

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
