// The sweep route: the evidence viewer's data endpoint. It runs the keyless
// scripted v1 and v2 sweep in-process (World Runner + deterministic kernels +
// judge, no shell and no model) and returns the SweepResult as JSON: each side's
// RunScore, per-fixture verdicts, the full per-fixture trace, and the pinned
// harness spec. The numbers are computed from the trace, so this endpoint needs
// no API key and is fully deterministic.

import { NextResponse } from "next/server";
import { runSweepInProcess } from "@/world/index.js";

// The sweep stands up the synthetic world and the kernels, which are Node
// modules, so this handler runs on the Node.js runtime.
export const runtime = "nodejs";

// The sweep is deterministic and depends on no request input, so the route is
// statically computable; recompute per request to keep the module-graph simple.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const sweep = await runSweepInProcess();
  return NextResponse.json(sweep);
}
