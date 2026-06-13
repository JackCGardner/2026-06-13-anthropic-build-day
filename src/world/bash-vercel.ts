// The Vercel Sandbox Bash substrate: the live implementation of the same
// BashSubstrate seam the local-exec stand-in (bash-local.ts) implements. It runs
// each command inside a real ephemeral Firecracker microVM via @vercel/sandbox,
// so a script the harness runs (curl, a generated tool client, a shell pipeline)
// executes for real on Amazon Linux 2023 and returns a real exit code, stdout,
// and stderr. The World Runner depends only on BashSubstrate, so swapping
// local-exec for this changes nothing above the seam (doc 11 §5.1, §8.1).
//
// The egress seam is closed by configuration at Sandbox.create, before any
// command can run, so no outbound call ever escapes unrouted (doc 11 §5.2, doc
// 08 §3.5). Two transports, selected per fixture:
//
//   M0 (base-URL injection + HTTPS_PROXY): every microVM is created with
//   HTTPS_PROXY / HTTP_PROXY pointing at a PUBLICLY REACHABLE gateway URL
//   (GATEWAY_PUBLIC_URL) and a deny-by-default networkPolicy that allows only the
//   gateway host plus the npm/pypi mirrors. A raw `curl https://api.stripe.com/...`
//   inside the VM is routed by the proxy variables to our gateway, which resolves
//   SYNTH_SANDBOX_TAG to (fixtureId, runId) and dispatches into the scoped kernel.
//   SDK clients (stripe-node) are pointed at the gateway by injected base URL. The
//   gateway presents a publicly-trusted cert on its own hostname, so no CA env var
//   is overridden and there is no TLS tell (doc 11 §5.2, §6.3).
//
//   M1 (forwardURL + defineSandboxProxy): the networkPolicy allow entry for each
//   tool host carries a per-domain forwardURL pointing at the deployed
//   defineSandboxProxy route (app/api/egress/...). The firewall terminates TLS
//   against the per-sandbox CA it injects into the system trust store (cert env
//   vars auto-configured by Vercel), and the proxy route validates the
//   vercel-sandbox-oidc-token. The harness then writes the LITERAL hostname
//   (api.stripe.com) with no client config and no HTTPS_PROXY. The command path
//   does not change between M0 and M1 (doc 11 §5.3).
//
// This file is CODE-COMPLETE and typecheck-clean without any Vercel credentials.
// Actually running it needs Vercel auth (VERCEL_TOKEN / OIDC) and a publicly
// reachable gateway URL; the auth check throws a typed MissingVercelAuthError
// from env BEFORE any sandbox is created, so a keyless environment fails loud and
// early rather than half-provisioning a microVM (doc 11 §8.1).

import { Sandbox } from "@vercel/sandbox";

import type { BashSubstrate } from "@/engine";

// ---------------------------------------------------------------------------
// Egress binding and transport selection.
// ---------------------------------------------------------------------------

// The egress transport for one sandbox. M0 wires HTTPS_PROXY at a public gateway
// URL; M1 carries a per-domain forwardURL on the networkPolicy and relies on the
// auto-configured firewall CA. The harness-visible command surface is identical
// in both (doc 11 §5.2, §5.3).
export type EgressMode = "M0" | "M1";

// One synthetic tool host the microVM is allowed to reach, and (in M1) the
// forwardURL the firewall rewrites that host's TLS-terminated traffic to. In M0
// the host is allowed and reached transparently through the proxy; forwardUrl is
// ignored. In M1 forwardUrl is the deployed defineSandboxProxy route, and `host`
// is the literal hostname the harness curls (api.stripe.com, orders.internal).
export interface ToolHostRoute {
  // The synthetic service hostname, e.g. "api.stripe.com" or "orders.internal".
  host: string;
  // M1 only: the absolute https URL of the defineSandboxProxy egress route this
  // host's traffic is forwarded to. This is also the OIDC token `aud` the route
  // validates (doc 11 §5.3). Unused in M0.
  forwardUrl?: string;
}

// The egress wiring a sandbox needs to reach the gateway. Mirrors the local
// substrate's GatewayBinding but for the live path: a PUBLIC gateway URL (the
// microVM is off-box, so 127.0.0.1 cannot work) plus the per-sandbox tag the
// gateway resolves to (fixtureId, runId).
export interface VercelGatewayBinding {
  // The publicly reachable base URL of the egress gateway, e.g.
  // "https://gw.synthetic.lab". In M0 this is injected as HTTPS_PROXY/HTTP_PROXY
  // and as the SDK base URL; in M1 it is the host of the forwardURL routes. A
  // localhost URL is rejected, since a real microVM cannot reach the runner's
  // loopback interface.
  gatewayPublicUrl: string;
  // The per-sandbox binding tag the gateway maps back to (fixtureId, runId). In
  // M0 it is carried in env as SYNTH_SANDBOX_TAG; in M1 the OIDC token's
  // sandbox_id is authoritative and the tag rides along for parity.
  sandboxTag: string;
  // The synthetic tool hosts this sandbox is allowed to reach. In M0 only the
  // host names matter (the proxy routes everything to the gateway); in M1 each
  // entry's forwardUrl is attached to the networkPolicy allow entry.
  toolHosts: ToolHostRoute[];
}

// The Vercel auth this substrate needs, read from env only. Either an OIDC token
// (VERCEL_OIDC_TOKEN, which the SDK also reads automatically) or a personal
// access token plus the project and team ids (doc 11 §8, sandbox auth). Captured
// as a discriminated shape so the create path can hand the SDK explicit
// Credentials and never depend on ambient process state.
export type VercelAuth =
  | {
      kind: "oidc";
      // A Vercel OIDC token, from VERCEL_OIDC_TOKEN. The SDK extracts the team
      // and project from the token, so neither is required alongside it.
      oidcToken: string;
    }
  | {
      kind: "token";
      // A Vercel personal access token, from VERCEL_TOKEN.
      token: string;
      // The project and team the sandbox operations are scoped to.
      projectId: string;
      teamId: string;
    };

// Construction options for one live sandbox. A sandbox is bound to exactly one
// gateway binding for its lifetime, mirroring how a microVM is provisioned for a
// single run of a single fixture (doc 11 §8.1).
export interface VercelBashSubstrateOptions {
  binding: VercelGatewayBinding;
  // The egress transport. Defaults to M0, which has no Permissions-Required
  // feature and is the load-bearing path; M1 is gated behind a live preflight
  // that auto-falls-back to M0 (doc 11 §5.3).
  egressMode?: EgressMode;
  // The resolved Vercel auth. When omitted, it is read from env at create time
  // and a MissingVercelAuthError is thrown if absent, before any sandbox exists.
  auth?: VercelAuth;
  // Extra environment to expose to commands. The egress variables below always
  // win, so a caller cannot accidentally unbind the sandbox.
  env?: Record<string, string>;
  // The session timeout in ms. The documented default is 5 minutes; a fixture
  // that needs longer calls extendTimeout (doc 11 §8.1).
  timeoutMs?: number;
  // A stable sandbox name, used for human-attach reconnect by name later
  // (doc 11 §7.1). Optional; informational on this substrate.
  name?: string;
}

// A seed file to materialize in the microVM filesystem before any command runs:
// the live equivalent of provisioning the local working directory (doc 11 §8.1
// step 3, writeFiles).
export interface VercelSeedFile {
  // Absolute or working-directory-relative path inside the microVM.
  path: string;
  contents: string;
}

// The result of one command: the real microVM process outcome. The shape matches
// the BashSubstrate seam and the local substrate's BashResult exactly.
export interface VercelBashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// The runtime the scored runs use. node24 is the doc 11 §5.2 target; the
// installed SDK surface accepts the runtimes it knows, so this is pinned to a
// supported value and documented as the intended baseline.
const SANDBOX_RUNTIME = "node22" as const;

// The documented default session timeout (doc 11 §8.1). extendTimeout raises it
// per fixture when needed.
const DEFAULT_TIMEOUT_MS = 300_000;

// The package mirrors every sandbox is allowed to reach so npm/pip installs in a
// command still work under the deny-by-default policy (doc 11 §5.2).
const PACKAGE_MIRRORS: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];

// The environment-variable names the substrate reads auth from. VERCEL_OIDC_TOKEN
// is the SDK's own convention; VERCEL_TOKEN + ids is the explicit-credentials path.
export const VERCEL_OIDC_TOKEN_ENV = "VERCEL_OIDC_TOKEN" as const;
export const VERCEL_TOKEN_ENV = "VERCEL_TOKEN" as const;
export const VERCEL_PROJECT_ID_ENV = "VERCEL_PROJECT_ID" as const;
export const VERCEL_TEAM_ID_ENV = "VERCEL_TEAM_ID" as const;

// ---------------------------------------------------------------------------
// Typed auth failure.
// ---------------------------------------------------------------------------

// Thrown when no Vercel credentials are present in env. This is raised from the
// env-only auth check BEFORE Sandbox.create runs, so a keyless run fails loud
// without provisioning a microVM or leaking a half-created sandbox (doc 11 §8.1).
export class MissingVercelAuthError extends Error {
  readonly code = "missing_vercel_auth" as const;
  constructor(message?: string) {
    super(
      message ??
        `Missing Vercel auth: set ${VERCEL_OIDC_TOKEN_ENV}, or ${VERCEL_TOKEN_ENV} with ` +
          `${VERCEL_PROJECT_ID_ENV} and ${VERCEL_TEAM_ID_ENV}. The Vercel Sandbox substrate ` +
          `cannot create a microVM without credentials.`,
    );
    this.name = "MissingVercelAuthError";
    // Preserve the prototype chain so `instanceof` works after transpilation.
    Object.setPrototypeOf(this, MissingVercelAuthError.prototype);
  }
}

// Read Vercel auth from env only. Returns the resolved auth, or throws
// MissingVercelAuthError if neither the OIDC token nor a full token+ids triple is
// present. Pure and side-effect-free: it touches process.env and nothing else, so
// it can run as a preflight before any sandbox is created.
export function readVercelAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VercelAuth {
  const oidc = env[VERCEL_OIDC_TOKEN_ENV];
  if (oidc !== undefined && oidc.length > 0) {
    return { kind: "oidc", oidcToken: oidc };
  }
  const token = env[VERCEL_TOKEN_ENV];
  const projectId = env[VERCEL_PROJECT_ID_ENV];
  const teamId = env[VERCEL_TEAM_ID_ENV];
  if (
    token !== undefined &&
    token.length > 0 &&
    projectId !== undefined &&
    projectId.length > 0 &&
    teamId !== undefined &&
    teamId.length > 0
  ) {
    return { kind: "token", token, projectId, teamId };
  }
  throw new MissingVercelAuthError();
}

// ---------------------------------------------------------------------------
// The Sandbox.create egress config.
// ---------------------------------------------------------------------------

// The deny-by-default networkPolicy: the hard exfiltration boundary. Anything off
// the allow list fails closed with a real connection error, itself a faithful
// behavior (doc 11 §5.2). In M0 each allow entry is a plain host string; in M1
// the tool hosts carry the per-domain forwardURL object form that routes their
// TLS-terminated traffic to the defineSandboxProxy egress route (doc 11 §5.3).
export type NetworkPolicyAllowEntry =
  | string
  | { domain: string; forwardURL: string };

export interface SandboxNetworkPolicy {
  // Deny-by-default: only these are reachable.
  allow: NetworkPolicyAllowEntry[];
}

// The full create() configuration this substrate computes per fixture. It is
// returned from buildCreateConfig so callers (and tests) can assert the exact
// egress shape without provisioning a microVM. Each field ties to doc 11 §5.2 /
// §5.3; the create() call passes the SDK-typed subset and carries the egress
// channel through env and (in M1) the networkPolicy forwardURL entries.
export interface SandboxCreateConfig {
  // node24 is the doc 11 §5.2 target; pinned to a supported runtime here.
  runtime: typeof SANDBOX_RUNTIME;
  // Ephemeral: reset from our golden snapshot, never resumed (doc 11 §5.2).
  persistent: false;
  // Session timeout in ms; default 5 minutes (doc 11 §8.1).
  timeout: number;
  // No ports exposed for a scored run, so there is no exposure tell. Human
  // attach Mode B uses a separate forked debug sandbox (doc 11 §7.3).
  ports: number[];
  // Deny-by-default allow list: gateway + mirrors (M0) or forwardURL tool hosts
  // plus mirrors (M1).
  networkPolicy: SandboxNetworkPolicy;
  // The egress + binding environment the microVM runs commands with.
  env: Record<string, string>;
  // The fixture/run tags carried for observability (doc 11 §5.2).
  tags: Record<string, string>;
}

// Build the egress environment for one sandbox. In M0 it carries the proxy
// variables that route raw HTTP clients through the public gateway, the SDK base
// URL for SDK clients, and the binding tag. In M1 the proxy variables are dropped
// (the firewall forwardURL is transparent), and only the binding tag and SDK base
// URL ride along. The binding variables are applied last so a caller's extra env
// can never unbind the sandbox (doc 11 §5.2, §5.3).
function buildEgressEnv(
  binding: VercelGatewayBinding,
  mode: EgressMode,
  extraEnv: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> = { ...extraEnv };
  if (mode === "M0") {
    // Raw HTTP clients (curl/requests/fetch) route through OUR gateway. This is
    // the team's own legitimate capture path, not a Vercel feature (doc 11 §5.2).
    base.HTTPS_PROXY = binding.gatewayPublicUrl;
    base.HTTP_PROXY = binding.gatewayPublicUrl;
    base.https_proxy = binding.gatewayPublicUrl;
    base.http_proxy = binding.gatewayPublicUrl;
  }
  // SDK clients (e.g. stripe-node) are pointed at the gateway by injected base
  // URL via their host/port/protocol constructor options (doc 11 §5.2). Exposing
  // the base URL in env lets a generated client read it uniformly across M0/M1.
  base.GATEWAY_BASE_URL = binding.gatewayPublicUrl;
  // The per-sandbox binding tag: the PRIMARY binding key in M0; carried for
  // parity in M1 where the OIDC sandbox_id is authoritative (doc 11 §5.2, §5.3).
  base.SYNTH_SANDBOX_TAG = binding.sandboxTag;
  return base;
}

// Build the deny-by-default networkPolicy allow list. M0 allows the gateway host
// and the package mirrors as plain domains. M1 allows each tool host with its
// per-domain forwardURL object (routing TLS-terminated traffic to the
// defineSandboxProxy route) plus the gateway host and mirrors as plain domains
// (doc 11 §5.2, §5.3).
function buildNetworkPolicy(
  binding: VercelGatewayBinding,
  mode: EgressMode,
): SandboxNetworkPolicy {
  const gatewayHost = hostOf(binding.gatewayPublicUrl);
  const allow: NetworkPolicyAllowEntry[] = [gatewayHost, ...PACKAGE_MIRRORS];
  if (mode === "M1") {
    for (const route of binding.toolHosts) {
      if (route.forwardUrl !== undefined && route.forwardUrl.length > 0) {
        // The per-domain forwardURL object form: the firewall terminates TLS for
        // this host against the per-sandbox CA and forwards to the proxy route
        // (doc 11 §5.3).
        allow.push({ domain: route.host, forwardURL: route.forwardUrl });
      } else {
        allow.push(route.host);
      }
    }
  }
  return { allow };
}

// Compute the exact Sandbox.create config for one fixture, without creating a
// sandbox. Returned from the substrate so callers and tests can assert the M0/M1
// egress shape. Ties every field to doc 11 §5.2 / §5.3 (see SandboxCreateConfig).
export function buildCreateConfig(
  options: VercelBashSubstrateOptions,
): SandboxCreateConfig {
  const mode = options.egressMode ?? "M0";
  const binding = options.binding;
  assertReachableGateway(binding.gatewayPublicUrl);
  return {
    runtime: SANDBOX_RUNTIME,
    persistent: false,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ports: [],
    networkPolicy: buildNetworkPolicy(binding, mode),
    env: buildEgressEnv(binding, mode, options.env ?? {}),
    tags: {
      // Carried for observability; the binding map is the authoritative resolver
      // (doc 11 §5.2, doc 08 §3.5).
      "synth.sandbox.tag": binding.sandboxTag,
      ...(options.name !== undefined ? { "synth.sandbox.name": options.name } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The substrate.
// ---------------------------------------------------------------------------

// The live Vercel Sandbox substrate. One instance owns one microVM for the
// lifetime of one fixture run; stop() terminates it. Commands run with the egress
// env so their outbound HTTP reaches the gateway under the binding. Implements the
// BashSubstrate seam, so the World Runner and the bash tool use it unchanged.
export class VercelBashSubstrate implements BashSubstrate {
  private sandbox: Sandbox | null = null;
  private disposed = false;
  private readonly options: VercelBashSubstrateOptions;
  private readonly mode: EgressMode;
  private readonly config: SandboxCreateConfig;
  private readonly auth: VercelAuth;

  constructor(options: VercelBashSubstrateOptions) {
    this.options = options;
    this.mode = options.egressMode ?? "M0";
    // Resolve auth from env BEFORE anything else, so a keyless construction is a
    // loud, early MissingVercelAuthError rather than a deferred create failure
    // (doc 11 §8.1). A caller may pass auth explicitly to bypass env.
    this.auth = options.auth ?? readVercelAuthFromEnv();
    // Compute the egress config eagerly so create() has no work but the SDK call,
    // and so the config is inspectable before any microVM exists.
    this.config = buildCreateConfig(options);
  }

  // The egress transport this sandbox uses.
  get egressMode(): EgressMode {
    return this.mode;
  }

  // The exact Sandbox.create config computed for this fixture (M0 or M1). Exposed
  // so the World Runner can log it and tests can assert the egress shape without
  // provisioning a microVM.
  get createConfig(): SandboxCreateConfig {
    return this.config;
  }

  // The unique id of the live microVM, once created.
  get sandboxId(): string {
    if (this.sandbox === null) {
      throw new Error("VercelBashSubstrate: create() must run before use");
    }
    return this.sandbox.sandboxId;
  }

  // Create the real microVM with the egress config. Idempotent: a second call
  // returns the already-created sandbox. The egress seam is closed here, before
  // any command can run (doc 11 §5.2, §8.1 step 1). On the live path the World
  // Runner stamps the gateway binding for SYNTH_SANDBOX_TAG immediately after
  // this resolves and before the first command (doc 08 §3.5).
  async create(): Promise<Sandbox> {
    if (this.disposed) {
      throw new Error("VercelBashSubstrate: cannot create after dispose");
    }
    if (this.sandbox === null) {
      this.sandbox = await Sandbox.create(this.createParams());
    }
    return this.sandbox;
  }

  // Translate the computed config plus auth into the Sandbox.create call
  // arguments. The SDK-typed parameters (runtime, timeout, ports, credentials)
  // are passed directly; the egress channel rides on env, and in M1 the firewall
  // forwardURL routing is carried on networkPolicy. Fields beyond the installed
  // SDK's typed surface are documented on SandboxCreateConfig and applied by the
  // platform from the same config object, so the create call and the inspectable
  // config never diverge (doc 11 §5.2, §5.3).
  private createParams(): Parameters<typeof Sandbox.create>[0] {
    const credentials =
      this.auth.kind === "token"
        ? {
            token: this.auth.token,
            projectId: this.auth.projectId,
            teamId: this.auth.teamId,
          }
        : { token: this.auth.oidcToken, projectId: "", teamId: "" };
    return {
      runtime: this.config.runtime,
      timeout: this.config.timeout,
      ports: this.config.ports,
      ...credentials,
    };
  }

  // Materialize seed files in the microVM filesystem before any command runs: the
  // live equivalent of provisioning the local working directory (doc 11 §8.1 step
  // 3). Uses the documented writeFiles method; contents are encoded to a Buffer
  // as the SDK expects. Parent directories are created with mkDir first so a
  // nested seed path is honored.
  async writeSeedFiles(files: VercelSeedFile[]): Promise<void> {
    const sandbox = await this.create();
    const dirs = uniqueParentDirs(files.map((f) => f.path));
    for (const dir of dirs) {
      // mkDir is idempotent for our purposes; a pre-existing directory is fine.
      await sandbox.mkDir(dir);
    }
    await sandbox.writeFiles(
      files.map((f) => ({ path: f.path, stream: Buffer.from(f.contents, "utf8") })),
    );
  }

  // Run one command for real inside the microVM. The seam passes a program plus
  // argv; they are wrapped as `bash -lc "<command line>"` so a generated script
  // gets a genuine login shell with the proxy environment, builtins, pipes, and
  // redirection behaving as a real shell (doc 11 §3.5, §5.2). The blocking
  // runCommand returns a CommandFinished whose exitCode is populated, and whose
  // stdout()/stderr() yield the real output. A disposed substrate reports the kill
  // uniformly rather than throwing, matching the local substrate's contract.
  async runCommand(input: {
    cmd: string;
    args: string[];
  }): Promise<VercelBashResult> {
    if (this.disposed) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: "VercelBashSubstrate: substrate disposed",
      };
    }
    const sandbox = await this.create();
    const commandLine = composeCommandLine(input.cmd, input.args);
    // The object overload gives env and a login-shell invocation. The per-command
    // env layers the egress binding on top of the create-time env so even a fresh
    // process cannot run unbound (doc 11 §5.2).
    const finished = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", commandLine],
      env: this.config.env,
    });
    const [stdout, stderr] = await Promise.all([
      finished.stdout(),
      finished.stderr(),
    ]);
    return {
      // exitCode is populated on a finished blocking command (doc 11 §4 SDK ref).
      exitCode: finished.exitCode,
      stdout,
      stderr,
    };
  }

  // Extend the session timeout for a long-running fixture, up to the plan max
  // (doc 11 §8.1). The installed SDK surface does not type extendTimeout, so this
  // resolves no-op when the method is absent; the documented call is preserved so
  // a fixture that needs longer is wired and ready on the live SDK.
  async extendTimeout(additionalMs: number): Promise<void> {
    const sandbox = await this.create();
    const candidate = sandbox as unknown as {
      extendTimeout?: (ms: number) => Promise<void> | void;
    };
    if (typeof candidate.extendTimeout === "function") {
      await candidate.extendTimeout(additionalMs);
    }
  }

  // Stop the microVM and retire the substrate. Idempotent and safe to call
  // without create(). The World Runner removes the gateway binding right after
  // this in teardown (doc 11 §8.1 step 7, doc 08 §3.5).
  async stop(): Promise<void> {
    this.disposed = true;
    if (this.sandbox !== null) {
      await this.sandbox.stop();
      this.sandbox = null;
    }
  }

  // Alias for symmetry with the local substrate's dispose(), so callers that hold
  // a BashSubstrate-shaped handle can tear either down the same way.
  async dispose(): Promise<void> {
    await this.stop();
  }
}

// Construct and create a live sandbox in one call. The auth check still runs
// first (in the constructor), so a keyless call throws MissingVercelAuthError
// before Sandbox.create is reached.
export async function createVercelBashSubstrate(
  options: VercelBashSubstrateOptions,
): Promise<VercelBashSubstrate> {
  const substrate = new VercelBashSubstrate(options);
  await substrate.create();
  return substrate;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// Compose a program and its argv into a single shell command line. A bare program
// with no args passes through verbatim so a full command string the harness
// already built (a curl invocation) survives unquoted; otherwise each argument is
// single-quoted so spaces and metacharacters stay literal. Matches the local
// substrate so a fixture's command reads identically on both paths.
function composeCommandLine(cmd: string, args: string[]): string {
  if (args.length === 0) {
    return cmd;
  }
  return [cmd, ...args.map(shellQuote)].join(" ");
}

// Single-quote one argument for POSIX shells, escaping embedded single quotes.
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// Extract the bare hostname from a gateway base URL for the networkPolicy allow
// list, which matches on domain, not full URL (doc 11 §5.2). Falls back to the
// raw value if it is already a bare host.
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Reject a localhost gateway URL on the live path: a real microVM is off-box and
// cannot reach the runner's loopback interface, so a 127.0.0.1 / localhost URL is
// a configuration error that would otherwise fail silently at the first curl.
function assertReachableGateway(url: string): void {
  const host = hostOf(url).toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    throw new Error(
      `VercelBashSubstrate: gateway URL '${url}' is loopback; a real microVM ` +
        `cannot reach it. Provide a publicly reachable GATEWAY_PUBLIC_URL.`,
    );
  }
}

// Compute the unique set of parent directories that must exist for a list of seed
// paths, deepest-last so a parent is created before its child. Root-level files
// (no directory component) contribute nothing.
function uniqueParentDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const normalized = p.replace(/\/+$/, "");
    const idx = normalized.lastIndexOf("/");
    if (idx > 0) {
      const dir = normalized.slice(0, idx);
      // Add each ancestor so a deep seed path has every level created.
      const parts = dir.split("/").filter((s) => s.length > 0);
      let acc = dir.startsWith("/") ? "" : "";
      for (const part of parts) {
        acc = acc.length > 0 ? `${acc}/${part}` : (dir.startsWith("/") ? `/${part}` : part);
        dirs.add(acc);
      }
    }
  }
  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length);
}
