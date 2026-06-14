// The LLM edit proposer: the live counterpart to the deterministic reference
// proposer, behind the same EditProposer seam. It asks a real Opus model to
// propose candidate spec edits across the full surface (system prompt, procedure,
// policy gates, tool rules) from the judge's failure tags and the trace of what
// the harness did and did not check. It is NOT needed for the keyless loop: the
// deterministic proposer drives every test and the default CLI run.
//
// Like the live harness, this checks for a model credential at construction time
// and throws without it rather than touching the network, so the module builds
// and typechecks keyless. The keep-if-better selection rule in optimize() is the
// same regardless of which proposer produced the candidates, so swapping in the
// model changes only the breadth of proposals, never how they are judged.

import { hasModelCredential, MissingApiKeyError } from "@/harness/index.js";
import {
  loadStructuredSpec,
  type StructuredHarnessSpec,
} from "@/harness/structured-spec.js";
import type { RunScore, TraceEvent } from "@/engine";
import type { CandidateEdit, EditProposer } from "./proposer.js";

// The model the live proposer runs against. Pinned so a generation is
// reproducible run to run; the loop's selection is what guarantees quality.
const PROPOSER_MODEL = "claude-opus-4-20250514";

export interface LlmProposerOptions {
  // Override the model id; defaults to the pinned proposer model.
  model?: string;
  // The transport that turns a prompt into candidate specs. Injected so the
  // network call is itself a seam: production wires the Agent SDK here, and a
  // test can drive the proposer without a model. When omitted, a credential is
  // required and the default SDK transport is used.
  complete?: (prompt: string) => Promise<unknown>;
}

// Build the live LLM proposer. With no injected transport and no credential it
// throws MissingApiKeyError immediately, mirroring the live harness, so a keyless
// environment never silently degrades to a no-op proposer.
export function createLlmProposer(options: LlmProposerOptions = {}): EditProposer {
  const hasTransport = options.complete !== undefined;
  if (!hasTransport && !hasModelCredential()) {
    // The LLM edit proposer needs an Anthropic credential; a keyless run uses
    // the deterministic proposer instead. Throw rather than no-op silently.
    throw new MissingApiKeyError();
  }

  const model = options.model ?? PROPOSER_MODEL;
  const complete = options.complete ?? defaultComplete(model);

  return {
    id: `llm-proposer:${model}`,
    async propose(spec, runScore, traces) {
      const prompt = buildPrompt(spec, runScore, traces);
      const raw = await complete(prompt);
      return parseCandidates(spec, raw);
    },
  };
}

// The prompt handed to the model. It states the editable surface and the goal
// (close the observed failure modes without blocking legitimate refunds) and
// hands over the failure tags and a compact trace summary. It deliberately does
// NOT state the correct gate set; the model proposes and the keep-if-better rule
// selects.
function buildPrompt(
  spec: StructuredHarnessSpec,
  runScore: RunScore,
  traces: TraceEvent[][],
): string {
  const tags = [
    ...new Set(runScore.fixture_verdicts.flatMap((v) => v.failure_tags)),
  ];
  const lookups = summarizeLookups(traces);
  return [
    "You are improving a refund-support harness spec. Propose candidate edits as JSON.",
    "The editable surface is: system_prompt (string), procedure (string[]),",
    "policy_gates (array of {id, requires_lookup, check, on_fail}), tool_rules.",
    `Current spec: ${JSON.stringify(spec)}`,
    `Current train Trust Score: ${runScore.trust_score.toFixed(1)} of 100.`,
    `Observed failure tags: ${tags.join(", ") || "none"}.`,
    `Lookups the harness performed across the trace: ${lookups}.`,
    "Goal: close the failure modes without refusing legitimate refunds.",
    'Respond with a JSON array of {"label": string, "spec": <full structured spec>}.',
  ].join("\n");
}

function summarizeLookups(traces: TraceEvent[][]): string {
  const hosts = new Set<string>();
  for (const events of traces) {
    for (const e of events) {
      if (e.kind === "egress" && e.span.phase === "begin") {
        const url = (e.payload as { url?: unknown }).url;
        if (typeof url === "string") {
          const host = url.split("://")[0];
          if (host) hosts.add(host);
        }
      }
    }
  }
  return [...hosts].join(", ") || "none";
}

// Parse the model's JSON into validated candidate edits. Anything that fails the
// frozen schema is dropped rather than crashing the loop, so a malformed item in
// an otherwise good batch does not lose the round.
function parseCandidates(
  parent: StructuredHarnessSpec,
  raw: unknown,
): CandidateEdit[] {
  // Model output is text; accept either a parsed array or a JSON string of one.
  const decoded = typeof raw === "string" ? safeJsonParse(raw) : raw;
  const items = Array.isArray(decoded) ? decoded : [];
  const out: CandidateEdit[] = [];
  for (const [i, item] of items.entries()) {
    if (item === null || typeof item !== "object") continue;
    const rec = item as { label?: unknown; spec?: unknown };
    try {
      const spec = loadStructuredSpec(rec.spec);
      out.push({
        spec,
        label: typeof rec.label === "string" ? rec.label : `llm candidate ${i}`,
        // The model's intent is unknown to the loop; treat every proposal as a
        // hypothesis to be judged, never as a trusted answer.
        expected_helpful: true,
      });
    } catch {
      // Drop invalid proposals; the parent stays unchanged if none survive.
    }
  }
  void parent;
  return out;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The default transport. Wired lazily so importing this module never requires
// the Agent SDK at module load in a keyless build. It is only constructed when a
// credential is present and no transport was injected.
function defaultComplete(model: string): (prompt: string) => Promise<unknown> {
  return async () => {
    // The default Agent SDK transport is not wired in this build: callers inject
    // options.complete, or run keyless with the deterministic proposer.
    throw new Error(
      `no Agent SDK transport wired for model ${model}; inject options.complete`,
    );
  };
}
