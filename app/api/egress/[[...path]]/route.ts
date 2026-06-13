// The forwardURL egress route: the deployed, real-sandbox face of the same
// synthetic boundary the local Node gateway exposes. A live Vercel Sandbox is
// created with a networkPolicy whose tool-host allow entries carry a forwardURL
// pointing at this route (doc 11 §5.3). When the harness inside that sandbox
// writes the literal hostname (api.stripe.com, the internal services), the
// firewall terminates TLS against the per-sandbox CA, signs the call with a
// vercel-sandbox-oidc-token, reconstructs the original request into
// vercel-forwarded-* headers, and forwards it here.
//
// This handler is the defineSandboxProxy target. It:
//   1. validates the vercel-sandbox-oidc-token (signature, issuer, expiry, and
//      aud equal to this route's forwardURL) via defineSandboxProxy from
//      @vercel/sandbox/proxy, extracting the authenticated team/project/sandbox,
//   2. reconstructs the target (method, literal host, path, headers) from the
//      vercel-forwarded-* headers the proxy validation exposes,
//   3. resolves the bound (fixtureId, runId) for that sandbox identity,
//   4. dispatches into the matching kernel against the scoped WorldState through
//      the exact same shared egress core the local gateway uses, writing the
//      same causal trace chain,
//   5. returns the wire-faithful HTTP response with the observability channel
//      stripped.
//
// Every failure is loud. An unbound or invalid token, an unconfigured runner, or
// a host/path that maps to no tool answers a faithful error envelope with the
// right status and never silently serves a default. The trap logic is not
// duplicated here: it lives in src/world/egress-core.ts, shared with the local
// gateway, so the two transports differ only in how they obtain the binding and
// the raw request bytes.

import {
  handleEgress,
  decodeBody,
  JSON_HEADERS,
  type NormalizedRequest,
  type WireResponse,
} from "@/world/egress-core.js";
import { egressBindingStore } from "@/world/egress-binding-store.js";
import {
  verifySandboxProxyRequest,
  SandboxProxyUnavailableError,
} from "@/world/sandbox-proxy.js";

// The dispatch stands up the synthetic kernels and the shared trace writer,
// which are Node modules, and the defineSandboxProxy validation needs Node
// crypto, so this handler runs on the Node.js runtime.
export const runtime = "nodejs";

// Each forwarded call carries fresh hidden state and a fresh token, so the route
// is never cacheable and is recomputed per request.
export const dynamic = "force-dynamic";

// The forwardURL this route is registered as. The validated token's audience
// must equal it; defineSandboxProxy enforces the binding when we pass it. The
// deployment sets it to the public URL of this route. When unset, validation
// still runs but does not pin the audience, which the live preflight flags.
const FORWARD_URL = process.env.SYNTH_EGRESS_FORWARD_URL;

// One handler serves every method the synthetic APIs accept. Next dispatches
// each HTTP verb to the matching export, so they all delegate to one core.
async function handle(request: Request): Promise<Response> {
  try {
    return await dispatchForwarded(request);
  } catch (error) {
    // A SandboxProxyUnavailableError means this deployment is not a live Vercel
    // sandbox forwarding target (the proxy entrypoint or the firewall headers
    // are absent). That is a loud configuration failure, not a per-request one:
    // answer 502 so an unconfigured deployment is visibly inert.
    if (error instanceof SandboxProxyUnavailableError) {
      return errorResponse(502, "egress_proxy_unavailable", error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(502, "gateway_error", message);
  }
}

// The core of the route: validate the token, resolve the binding and world, and
// drive the shared egress core. Returns the wire-faithful Response.
async function dispatchForwarded(request: Request): Promise<Response> {
  // Step 1 + 2: validate the OIDC token and reconstruct the original target. A
  // missing proxy entrypoint throws SandboxProxyUnavailableError (handled
  // above); an invalid token returns ok:false, which we reject loud as 401.
  const verification = await verifySandboxProxyRequest(request, {
    ...(FORWARD_URL !== undefined ? { audience: FORWARD_URL } : {}),
  });

  if (!verification.ok) {
    // The token failed validation: bad signature, wrong issuer, expired, or aud
    // mismatch. This is an authentication failure, answered loud with a faithful
    // envelope. There is no bound fixture to trace it against.
    return errorResponse(401, "invalid_sandbox_token", verification.reason);
  }

  const { identity, forwarded } = verification;

  // The World Runner must have configured the route with a trace writer; without
  // one there is no single writer to keep seq a total order, so the route cannot
  // serve. This is a loud misconfiguration, not a per-request failure.
  const trace = egressBindingStore.trace;
  if (trace === undefined) {
    return errorResponse(
      503,
      "egress_unconfigured",
      "The forwardURL route has no trace writer configured; the World Runner has not registered its egress sink.",
    );
  }

  // Step 3: resolve the bound (fixtureId, runId) for the authenticated sandbox
  // identity. The World Runner stamped this binding at Sandbox.create, keyed by
  // the OIDC sandbox_id. An unbound identity is rejected loud by the core.
  const binding = egressBindingStore.resolveBinding(identity.sandboxId);

  // Read and decode the body once. The kernels parse form-encoded (Stripe) and
  // JSON (internal services) bodies, so we hand the decoded payload through.
  const rawBody = await readRequestBody(request);
  const contentType = forwarded.headers["content-type"] ?? request.headers.get("content-type") ?? undefined;
  const body = decodeBody(rawBody, contentType);

  const { path, query } = splitPathAndQuery(forwarded.path);

  // The normalized request the shared core consumes. The host is the literal
  // hostname the harness wrote, carried in the vercel-forwarded-* headers, so
  // host-based tool resolution lands on the same kernel as the local gateway.
  const normalized: NormalizedRequest = {
    host: forwarded.host,
    method: forwarded.method.toUpperCase(),
    path,
    query,
    headers: forwarded.headers,
    body,
  };

  // Steps 4 + 5: dispatch through the shared core. It writes the egress ->
  // tool_dispatch -> state_mutation -> tool_dispatch end -> egress end chain and
  // returns the wire-faithful response with the observability channel stripped.
  const wire: WireResponse = handleEgress({
    binding,
    sandboxId: identity.sandboxId,
    request: normalized,
    trace,
    resolveWorld: egressBindingStore.resolveWorld,
  });

  return serializeWire(wire);
}

// Read the request body as a string. GET/DELETE with no body yield the empty
// string, which decodeBody maps to null.
async function readRequestBody(request: Request): Promise<string> {
  if (request.body === null) return "";
  try {
    return await request.text();
  } catch {
    return "";
  }
}

// Split a reconstructed target path into its pathname and decoded query record.
// The forwarded path may carry a query string; the kernels read the query map.
function splitPathAndQuery(rawPath: string): {
  path: string;
  query: Record<string, string>;
} {
  const qIndex = rawPath.indexOf("?");
  if (qIndex === -1) {
    return { path: rawPath, query: {} };
  }
  const path = rawPath.slice(0, qIndex);
  const query: Record<string, string> = {};
  const params = new URLSearchParams(rawPath.slice(qIndex + 1));
  for (const [k, v] of params.entries()) {
    query[k] = v;
  }
  return { path, query };
}

// Serialize a WireResponse from the core into a real HTTP Response. The body is
// JSON, the kernel's status and headers are preserved, and content-type defaults
// to application/json since every kernel speaks JSON.
function serializeWire(wire: WireResponse): Response {
  const payload = JSON.stringify(wire.body ?? null);
  const headers = new Headers();
  for (const [k, v] of Object.entries(wire.headers)) {
    headers.set(k, v);
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(payload, { status: wire.status, headers });
}

// A faithful error envelope, matching the shape the local gateway and the
// kernels use, so a harness sees the same error body regardless of transport.
function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  const body = JSON.stringify({
    error: { type: "api_error", code, message },
  });
  const headers = new Headers(JSON_HEADERS);
  return new Response(body, { status, headers });
}

// Every HTTP verb the synthetic APIs accept routes to the one handler. Next.js
// requires a named export per method on a Route Handler.
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
