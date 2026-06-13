// The egress binding store: the gateway-visible map that resolves a sandbox
// identity to the fixture and run its calls belong to, for the deployed
// forwardURL transport. The local Node gateway keeps this map in its own closure
// because it lives in the same process as the World Runner; the Next.js
// forwardURL route runs in a separate serverless invocation, so it resolves
// bindings through this shared module-level store and an injected trace sink
// instead.
//
// In the M1 live path the World Runner populates this store at Sandbox.create
// (stamping sandbox_id -> (fixtureId, runId) before any egress can occur, per
// doc 08 §3.5) and the forwardURL route reads it on each request. Both the tag
// the M0 transport carries and the OIDC sandbox_id the M1 transport extracts key
// into the same store, so an operator can bind by whichever identity the live
// deployment exposes.
//
// The store also holds the world resolver and the trace sink the route needs:
// the World Runner owns the seeded per-fixture worlds and the single trace
// writer, and registers them here so the route never reaches into runner
// internals. Until the World Runner registers them, the route fails loud on
// every call rather than serving a default, which keeps an unconfigured
// deployment visibly inert instead of quietly wrong.

import type { WorldState } from "@/engine";
import type {
  SandboxBinding,
  WorldResolver,
  EgressTraceWriter,
} from "./egress-core.js";

// The registry the forwardURL route resolves against. It is intentionally a
// small mutable singleton: one deployment serves one World Runner, and the
// runner is the only writer. A test or the runner can construct an isolated
// instance via createEgressBindingStore and install it for the route.
export interface EgressBindingStore {
  // Resolve a sandbox identity (M0 tag or M1 OIDC sandbox_id) to its binding.
  resolveBinding(sandboxId: string): SandboxBinding | undefined;
  // Resolve a fixture's seeded per-tool world. Undefined when not live.
  resolveWorld: WorldResolver;
  // The single trace writer the route emits through. Undefined until the World
  // Runner registers one, which the route treats as a loud misconfiguration.
  trace: EgressTraceWriter | undefined;
  // Register or retire a binding. The World Runner calls bind at Sandbox.create
  // and unbind at teardown.
  bind(sandboxId: string, binding: SandboxBinding): void;
  unbind(sandboxId: string): void;
  // Install the world resolver and trace writer the runner owns.
  configure(options: {
    resolveWorld: WorldResolver;
    trace: EgressTraceWriter;
  }): void;
}

// Build an isolated binding store. The default export below is the process
// singleton the deployed route reads; tests construct their own.
export function createEgressBindingStore(): EgressBindingStore {
  const bindings = new Map<string, SandboxBinding>();
  let worlds: WorldResolver = () => undefined;
  let traceSink: EgressTraceWriter | undefined;

  return {
    resolveBinding(sandboxId) {
      return bindings.get(sandboxId);
    },
    resolveWorld(fixtureId): Record<string, WorldState> | undefined {
      return worlds(fixtureId);
    },
    get trace() {
      return traceSink;
    },
    bind(sandboxId, binding) {
      bindings.set(sandboxId, binding);
    },
    unbind(sandboxId) {
      bindings.delete(sandboxId);
    },
    configure(options) {
      worlds = options.resolveWorld;
      traceSink = options.trace;
    },
  };
}

// The process-wide store the deployed forwardURL route resolves against. The
// World Runner deployment configures it once at startup and binds/unbinds per
// fixture. A separate instance is created per Node process, which is the right
// scope for a single-runner deployment; a multi-runner topology would inject a
// shared external store behind the same interface.
export const egressBindingStore: EgressBindingStore = createEgressBindingStore();
