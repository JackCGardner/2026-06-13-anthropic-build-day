// Keyless proofs for the Vercel Sandbox substrate. These run with NO Vercel
// credentials and touch NO network: they assert the auth boundary fails loud and
// early, and that the computed Sandbox.create egress config has the exact M0/M1
// shape the deployed gateway and forwardURL route expect. None of these tests
// constructs a real microVM; the substrate's constructor runs the env-only auth
// check before anything else, so a keyless construction either throws or yields
// an inspectable config without provisioning anything.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  VercelBashSubstrate,
  readVercelAuthFromEnv,
  buildCreateConfig,
  MissingVercelAuthError,
  VERCEL_OIDC_TOKEN_ENV,
  VERCEL_TOKEN_ENV,
  VERCEL_PROJECT_ID_ENV,
  VERCEL_TEAM_ID_ENV,
  type VercelGatewayBinding,
} from "./bash-vercel.js";

// The Vercel auth env vars the substrate reads. Each test snapshots and clears
// them so the keyless assertions are not contaminated by an ambient credential
// (a developer running inside an authenticated Vercel session).
const AUTH_ENV_KEYS = [
  VERCEL_OIDC_TOKEN_ENV,
  VERCEL_TOKEN_ENV,
  VERCEL_PROJECT_ID_ENV,
  VERCEL_TEAM_ID_ENV,
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of AUTH_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    const prior = savedEnv[key];
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
});

// A publicly reachable gateway binding the M0/M1 config builds against. It is
// never reached over the network in these tests; only the computed config is
// inspected. A real host (not loopback) is required so the substrate's
// reachability check passes.
const BINDING: VercelGatewayBinding = {
  gatewayPublicUrl: "https://gw.synthetic.lab",
  sandboxTag: "tag_run42_wrong_method_double",
  toolHosts: [
    { host: "api.stripe.com", forwardUrl: "https://gw.synthetic.lab/api/egress" },
    { host: "orders.internal", forwardUrl: "https://gw.synthetic.lab/api/egress" },
  ],
};

describe("VercelBashSubstrate: keyless auth boundary", () => {
  it("throws MissingVercelAuthError on construction with no Vercel auth and creates no sandbox", () => {
    // No env auth is set (cleared in beforeEach). Construction runs the env-only
    // auth check BEFORE any Sandbox.create, so it throws synchronously.
    let thrown: unknown;
    try {
      new VercelBashSubstrate({ binding: BINDING });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingVercelAuthError);
    expect((thrown as MissingVercelAuthError).code).toBe("missing_vercel_auth");
    // The message names every credential path so a keyless operator knows what to set.
    expect((thrown as Error).message).toContain(VERCEL_OIDC_TOKEN_ENV);
    expect((thrown as Error).message).toContain(VERCEL_TOKEN_ENV);
  });

  it("readVercelAuthFromEnv resolves an OIDC token when present", () => {
    process.env[VERCEL_OIDC_TOKEN_ENV] = "oidc-abc";
    const auth = readVercelAuthFromEnv();
    expect(auth.kind).toBe("oidc");
    expect(auth).toMatchObject({ kind: "oidc", oidcToken: "oidc-abc" });
  });

  it("readVercelAuthFromEnv resolves a token triple when present", () => {
    process.env[VERCEL_TOKEN_ENV] = "tok";
    process.env[VERCEL_PROJECT_ID_ENV] = "prj_1";
    process.env[VERCEL_TEAM_ID_ENV] = "team_1";
    const auth = readVercelAuthFromEnv();
    expect(auth).toMatchObject({
      kind: "token",
      token: "tok",
      projectId: "prj_1",
      teamId: "team_1",
    });
  });

  it("a partial token triple (no team) still throws MissingVercelAuthError", () => {
    process.env[VERCEL_TOKEN_ENV] = "tok";
    process.env[VERCEL_PROJECT_ID_ENV] = "prj_1";
    expect(() => readVercelAuthFromEnv()).toThrow(MissingVercelAuthError);
  });

  it("an explicitly passed auth lets construction succeed keyless without a sandbox", () => {
    // Passing auth bypasses env; the constructor computes the config eagerly and
    // never calls Sandbox.create, so this is safe with no credentials in env.
    const substrate = new VercelBashSubstrate({
      binding: BINDING,
      auth: { kind: "token", token: "tok", projectId: "prj_1", teamId: "team_1" },
    });
    expect(substrate.egressMode).toBe("M0");
    expect(substrate.createConfig.runtime).toBeDefined();
  });
});

describe("buildCreateConfig: the M0 vs M1 egress shape", () => {
  it("M0 wires HTTPS_PROXY at the public gateway and the binding tag, with deny-by-default allow", () => {
    const config = buildCreateConfig({ binding: BINDING, egressMode: "M0" });

    expect(config.persistent).toBe(false);
    expect(config.ports).toEqual([]);

    // M0 routes raw HTTP clients through OUR gateway via the proxy variables.
    expect(config.env.HTTPS_PROXY).toBe("https://gw.synthetic.lab");
    expect(config.env.HTTP_PROXY).toBe("https://gw.synthetic.lab");
    expect(config.env.https_proxy).toBe("https://gw.synthetic.lab");
    expect(config.env.GATEWAY_BASE_URL).toBe("https://gw.synthetic.lab");
    expect(config.env.SYNTH_SANDBOX_TAG).toBe("tag_run42_wrong_method_double");

    // Deny-by-default allow: gateway host + package mirrors, all plain domains.
    expect(config.networkPolicy.allow).toContain("gw.synthetic.lab");
    expect(config.networkPolicy.allow).toContain("registry.npmjs.org");
    expect(config.networkPolicy.allow).toContain("pypi.org");
    // No per-domain forwardURL objects in M0.
    expect(
      config.networkPolicy.allow.some((e) => typeof e === "object"),
    ).toBe(false);
  });

  it("M1 drops the proxy vars and carries a per-domain forwardURL for each tool host", () => {
    const config = buildCreateConfig({ binding: BINDING, egressMode: "M1" });

    // The firewall forwardURL is transparent, so M1 has no HTTPS_PROXY.
    expect(config.env.HTTPS_PROXY).toBeUndefined();
    expect(config.env.HTTP_PROXY).toBeUndefined();
    // The binding tag and SDK base URL still ride along.
    expect(config.env.SYNTH_SANDBOX_TAG).toBe("tag_run42_wrong_method_double");
    expect(config.env.GATEWAY_BASE_URL).toBe("https://gw.synthetic.lab");

    // Each tool host appears as a per-domain forwardURL object pointing at the
    // deployed defineSandboxProxy route.
    const stripeEntry = config.networkPolicy.allow.find(
      (e) => typeof e === "object" && e.domain === "api.stripe.com",
    );
    expect(stripeEntry).toEqual({
      domain: "api.stripe.com",
      forwardURL: "https://gw.synthetic.lab/api/egress",
    });
    // The gateway host and mirrors remain as plain domains.
    expect(config.networkPolicy.allow).toContain("gw.synthetic.lab");
    expect(config.networkPolicy.allow).toContain("registry.npmjs.org");
  });

  it("rejects a loopback gateway URL, since a real microVM is off-box", () => {
    expect(() =>
      buildCreateConfig({
        binding: { ...BINDING, gatewayPublicUrl: "http://127.0.0.1:8080" },
      }),
    ).toThrow(/loopback/);
  });

  it("a caller's extra env can never override the binding variables", () => {
    const config = buildCreateConfig({
      binding: BINDING,
      egressMode: "M0",
      env: { SYNTH_SANDBOX_TAG: "spoofed", HTTPS_PROXY: "http://evil" },
    });
    // The egress variables are applied last, so they win over caller env.
    expect(config.env.SYNTH_SANDBOX_TAG).toBe("tag_run42_wrong_method_double");
    expect(config.env.HTTPS_PROXY).toBe("https://gw.synthetic.lab");
  });
});
