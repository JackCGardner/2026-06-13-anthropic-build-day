// The defineSandboxProxy adapter: a thin, typed boundary around the documented
// @vercel/sandbox/proxy surface the M1 forwardURL transport depends on. The
// forwardURL route is the defineSandboxProxy target: the Vercel firewall
// terminates TLS for a forwarding domain against the per-sandbox CA, signs the
// outbound call with a vercel-sandbox-oidc-token, and reconstructs the original
// request into vercel-forwarded-* headers. defineSandboxProxy validates that
// token (signature, issuer, expiry, and aud equal to this route's forwardURL)
// and exposes the authenticated sandbox identity (team_id, project_id,
// sandbox_id) plus the reconstructed target (doc 11 §5.3).
//
// We isolate that dependency here, behind a dynamic import, for one product
// reason: the proxy entrypoint and the live firewall only exist in the deployed
// Vercel environment with sandbox credentials. The rest of the system, and the
// keyless build and test sweep, must not require it. So this module loads it
// lazily and surfaces a clear typed failure when it is absent, exactly as the
// live preflight that auto-falls-back to the M0 transport expects (doc 11 §5.3).

// The authenticated sandbox identity defineSandboxProxy extracts from a valid
// vercel-sandbox-oidc-token. These are the claims the route binds against: the
// sandbox_id is the M1 binding key the World Runner stamped at Sandbox.create.
export interface SandboxProxyIdentity {
  teamId: string;
  projectId: string;
  sandboxId: string;
}

// The reconstructed inbound call defineSandboxProxy hands back: the literal
// hostname the harness wrote (carried in the vercel-forwarded-* headers) and the
// method, path, and headers of the original request, before TLS termination at
// the forwarding domain. The route normalizes this into a NormalizedRequest.
export interface SandboxProxyForwarded {
  method: string;
  host: string;
  path: string;
  headers: Record<string, string>;
}

// The verified result of validating one forwarded request. `ok: false` carries
// a faithful reason the route rejects loud with, never serving a default.
export type SandboxProxyVerification =
  | {
      ok: true;
      identity: SandboxProxyIdentity;
      forwarded: SandboxProxyForwarded;
    }
  | { ok: false; reason: string };

// Raised when the proxy entrypoint is unavailable at runtime: the deployment is
// not a live Vercel sandbox forwarding target (no @vercel/sandbox/proxy module,
// no firewall-injected headers). The route catches this and answers loud so an
// unconfigured deployment is visibly inert rather than quietly wrong.
export class SandboxProxyUnavailableError extends Error {
  override readonly name = "SandboxProxyUnavailableError";
  constructor(message: string) {
    super(message);
  }
}

// The shape we expect from @vercel/sandbox/proxy. defineSandboxProxy returns a
// proxy whose verify() validates the vercel-sandbox-oidc-token on an incoming
// Request and yields the identity and the reconstructed target. We type only the
// surface we use so the dynamic import stays checkable without the package's own
// types being present at build time.
interface DefineSandboxProxyModule {
  defineSandboxProxy: (config?: {
    // The forwardURL this route is registered as. The token's aud must equal it;
    // passing it lets defineSandboxProxy enforce the audience binding.
    audience?: string;
  }) => {
    verify: (request: Request) => Promise<{
      teamId: string;
      projectId: string;
      sandboxId: string;
      method: string;
      host: string;
      path: string;
      headers: Record<string, string>;
    }>;
  };
}

// Lazily load the proxy entrypoint. The specifier is held in a variable so the
// keyless build does not try to resolve the subpath, which the installed sandbox
// version does not yet expose; the live deployment that pins the proxy-capable
// version resolves it at runtime.
const PROXY_MODULE_SPECIFIER = "@vercel/sandbox/proxy";

async function loadProxyModule(): Promise<DefineSandboxProxyModule> {
  try {
    const mod = (await import(
      /* webpackIgnore: true */ PROXY_MODULE_SPECIFIER
    )) as unknown as DefineSandboxProxyModule;
    if (typeof mod.defineSandboxProxy !== "function") {
      throw new SandboxProxyUnavailableError(
        `${PROXY_MODULE_SPECIFIER} did not export defineSandboxProxy`,
      );
    }
    return mod;
  } catch (error) {
    if (error instanceof SandboxProxyUnavailableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SandboxProxyUnavailableError(
      `${PROXY_MODULE_SPECIFIER} is unavailable in this deployment: ${message}. ` +
        `The forwardURL transport requires a live Vercel sandbox forwarding target.`,
    );
  }
}

// Validate one forwarded request against the documented defineSandboxProxy
// contract. Throws SandboxProxyUnavailableError when the proxy entrypoint is
// absent (the route maps that to a loud configuration error); returns ok:false
// when the token itself is invalid (bad signature, wrong issuer, expired, or aud
// mismatch), which the route also rejects loud but as an auth failure.
export async function verifySandboxProxyRequest(
  request: Request,
  options: { audience?: string },
): Promise<SandboxProxyVerification> {
  const mod = await loadProxyModule();
  const proxy = mod.defineSandboxProxy(
    options.audience !== undefined ? { audience: options.audience } : undefined,
  );
  try {
    const verified = await proxy.verify(request);
    return {
      ok: true,
      identity: {
        teamId: verified.teamId,
        projectId: verified.projectId,
        sandboxId: verified.sandboxId,
      },
      forwarded: {
        method: verified.method,
        host: verified.host,
        path: verified.path,
        headers: verified.headers,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid vercel-sandbox-oidc-token: ${message}` };
  }
}
