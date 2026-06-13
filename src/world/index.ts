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
export { createEgressGateway, resolveToolId, SANDBOX_TAG_HEADER, SANDBOX_TAG_ENV } from "./gateway.js";
export type {
  EgressGateway,
  CreateEgressGatewayOptions,
  GatewayTraceWriter,
  WorldResolver,
} from "./gateway.js";
