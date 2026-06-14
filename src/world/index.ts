// The World Runner: the plain-TypeScript orchestrator that steps fixtures,
// stands up the synthetic world, drives the scripted harness, dispatches egress
// into the deterministic kernels, and is the sole writer of the unified trace.
// The scripted v1/v2 harnesses and the seeding live alongside it; all of them
// touch only the frozen seams, so the live harness drops in unchanged later.

export { runSweep, KERNEL_TOOL_IDS } from "./runner.js";
export type { RunResult } from "./runner.js";
export { seedWorld } from "./seed.js";
export type { KernelToolId } from "./seed.js";
export {
  createScriptedHarness,
  scriptedHarnessV1,
  scriptedHarnessV2,
} from "./scripted-harness.js";
export { createInterpreterHarness } from "./interpreter-harness.js";
export {
  LocalBashSubstrate,
  createLocalBashSubstrate,
} from "./bash-local.js";
export type {
  GatewayBinding,
  LocalBashSubstrateOptions,
  SeedFile,
  BashResult,
} from "./bash-local.js";
export { createBashTool } from "./bash-tool.js";
export type {
  BashTool,
  BashToolInput,
  BashToolResult,
  CreateBashToolOptions,
} from "./bash-tool.js";
export { runSweepInProcess } from "./run-sweep-inprocess.js";
export type {
  SweepResult,
  SweepVersionResult,
  SweepFixtureResult,
} from "./run-sweep-inprocess.js";
export { createEgressGateway, resolveToolId, SANDBOX_TAG_HEADER, SANDBOX_TAG_ENV } from "./gateway.js";
export type {
  EgressGateway,
  CreateEgressGatewayOptions,
  GatewayTraceWriter,
  WorldResolver,
} from "./gateway.js";
export {
  handleEgress,
  decodeBody,
  stripObservabilityHeaders,
  JSON_HEADERS,
} from "./egress-core.js";
export type {
  HandleEgressInput,
  NormalizedRequest,
  WireResponse,
  SandboxBinding,
  EgressTraceWriter,
} from "./egress-core.js";
export {
  egressBindingStore,
  createEgressBindingStore,
} from "./egress-binding-store.js";
export type { EgressBindingStore } from "./egress-binding-store.js";
export {
  verifySandboxProxyRequest,
  SandboxProxyUnavailableError,
} from "./sandbox-proxy.js";
export type {
  SandboxProxyIdentity,
  SandboxProxyForwarded,
  SandboxProxyVerification,
} from "./sandbox-proxy.js";
export {
  VercelBashSubstrate,
  createVercelBashSubstrate,
  readVercelAuthFromEnv,
  buildCreateConfig,
  MissingVercelAuthError,
  VERCEL_OIDC_TOKEN_ENV,
  VERCEL_TOKEN_ENV,
  VERCEL_PROJECT_ID_ENV,
  VERCEL_TEAM_ID_ENV,
} from "./bash-vercel.js";
export type {
  VercelBashSubstrateOptions,
  VercelGatewayBinding,
  VercelSeedFile,
  VercelBashResult,
  VercelAuth,
  EgressMode,
  ToolHostRoute,
  SandboxCreateConfig,
  SandboxNetworkPolicy,
  NetworkPolicyAllowEntry,
} from "./bash-vercel.js";
