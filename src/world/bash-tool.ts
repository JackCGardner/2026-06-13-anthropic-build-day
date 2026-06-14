// The harness-facing `bash` tool: the single callable a harness invokes to run a
// shell command inside its sandbox. It wraps a BashSubstrate and emits the trace
// hops the viewer and Judge read for a shell turn: a `tool_invocation` begin/end
// pair (the harness calling its bash tool, the shape the live Agent SDK stream
// carries) wrapping a `shell` begin/end pair (the real command, its cwd, and the
// real exit code, stdout, and stderr the substrate returned).
//
// The egress hops (egress -> tool_dispatch -> state_mutation) are not written
// here. They are written by the egress gateway when the command's outbound HTTP
// reaches it, parented under the same run, so a single shell turn produces the
// full causal chain shell -> egress -> tool_dispatch -> state_mutation without
// this wrapper knowing anything about the network. That keeps the same callable
// usable unchanged by the live Agent SDK harness, which also only runs commands
// and lets the gateway observe their egress.

import type {
  BashSubstrate,
  TraceEvent,
  WorldRunnerHandle,
} from "@/engine";

// The input one bash invocation carries: a program and its argv, matching the
// BashSubstrate.runCommand seam. A harness that has already composed a full
// command string passes it as `cmd` with an empty `args`.
export interface BashToolInput {
  cmd: string;
  args: string[];
}

// The result one bash invocation returns: the real process outcome plus the
// trace events the call emitted, so a caller can assert on the hops directly.
export interface BashToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  events: TraceEvent[];
}

// The bash tool: a function over the world handle and the substrate. The handle
// supplies the single trace writer (so seq stays a total order) and the run
// framing; the substrate runs the command for real. The returned callable is the
// in-process tool shape the World Runner exposes to a harness today and hands to
// the live Agent SDK harness later, unchanged.
export type BashTool = (input: BashToolInput) => Promise<BashToolResult>;

// Long command output is truncated in the trace so a runaway command cannot
// bloat the JSONL line; the full bytes still flow back to the harness in the
// returned result. The cap is generous enough for a curl round-trip body.
const MAX_TRACE_OUTPUT = 8192;

export interface CreateBashToolOptions {
  world: WorldRunnerHandle;
  substrate: BashSubstrate;
  // The working directory the substrate runs commands in, surfaced on the shell
  // hop for the viewer. Optional because the seam itself does not expose it.
  workingDirectory?: string;
}

// Build the bash tool callable. Each invocation:
//   1. emits tool_invocation begin (the harness calling its bash tool),
//   2. emits shell begin (the command and cwd about to run),
//   3. runs the command for real through the substrate,
//   4. emits shell end (the real exit code, stdout, stderr),
//   5. emits tool_invocation end (the tool result the harness observes).
// The gateway interleaves the egress chain between shell begin and shell end as
// the command's outbound HTTP arrives, all under the same run and parented
// correctly, because the runner's emit assigns one monotonic seq.
export function createBashTool(options: CreateBashToolOptions): BashTool {
  const { world, substrate, workingDirectory } = options;

  return async function bash(input: BashToolInput): Promise<BashToolResult> {
    const collected: TraceEvent[] = [];
    const emit = (
      event: Omit<TraceEvent, "v" | "run_id" | "seq" | "ts">,
    ): TraceEvent => {
      const full = world.emit(event);
      collected.push(full);
      return full;
    };

    const commandLine = composeCommandLine(input.cmd, input.args);

    // An empty command is a caller error, not a shell to run: record the faulty
    // invocation faithfully on the trace and return a non-zero result rather than
    // spawning a no-op shell that would leave an empty command in the trace.
    if (commandLine.trim().length === 0) {
      const spanId = `sh_${world.fixtureId}_empty`;
      const invocationBegin = emit({
        fixture_id: world.fixtureId,
        harness_version: world.harnessVersion,
        parent_seq: null,
        actor: "harness",
        kind: "tool_invocation",
        span: { id: spanId, phase: "begin" },
        payload: { tool_name: "bash", input: { command: commandLine } },
      });
      const message = "bash tool called with an empty command";
      emit({
        fixture_id: world.fixtureId,
        harness_version: world.harnessVersion,
        parent_seq: invocationBegin.seq,
        actor: "harness",
        kind: "tool_invocation",
        span: { id: spanId, phase: "end" },
        payload: { tool_result: message, is_error: true },
      });
      return { exitCode: 2, stdout: "", stderr: message, events: collected };
    }

    const spanId = `sh_${world.fixtureId}_${commandLine.length}`;

    const invocationBegin = emit({
      fixture_id: world.fixtureId,
      harness_version: world.harnessVersion,
      parent_seq: null,
      actor: "harness",
      kind: "tool_invocation",
      span: { id: spanId, phase: "begin" },
      payload: { tool_name: "bash", input: { command: commandLine } },
    });

    emit({
      fixture_id: world.fixtureId,
      harness_version: world.harnessVersion,
      parent_seq: invocationBegin.seq,
      actor: "bash",
      kind: "shell",
      span: { id: spanId, phase: "begin" },
      payload: {
        command: commandLine,
        ...(workingDirectory !== undefined ? { cwd: workingDirectory } : {}),
      },
    });

    const result = await substrate.runCommand({
      cmd: input.cmd,
      args: input.args,
    });

    const stdoutTrace = truncate(result.stdout);
    const stderrTrace = truncate(result.stderr);

    emit({
      fixture_id: world.fixtureId,
      harness_version: world.harnessVersion,
      parent_seq: invocationBegin.seq,
      actor: "bash",
      kind: "shell",
      span: { id: spanId, phase: "end" },
      payload: {
        exit_code: result.exitCode,
        stdout: stdoutTrace.text,
        stderr: stderrTrace.text,
        truncated: stdoutTrace.truncated || stderrTrace.truncated,
      },
    });

    emit({
      fixture_id: world.fixtureId,
      harness_version: world.harnessVersion,
      parent_seq: invocationBegin.seq,
      actor: "harness",
      kind: "tool_invocation",
      span: { id: spanId, phase: "end" },
      payload: {
        tool_result: result.stdout.length > 0 ? result.stdout : result.stderr,
        is_error: result.exitCode !== 0,
      },
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      events: collected,
    };
  };
}

// Compose a program and its argv into the single command line surfaced on the
// shell hop. A bare program with no args is passed through verbatim so a curl
// string the harness already built reads the same in the trace as it ran.
function composeCommandLine(cmd: string, args: string[]): string {
  return args.length === 0 ? cmd : [cmd, ...args].join(" ");
}

// Truncate long output for the trace, reporting whether it was cut.
function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TRACE_OUTPUT) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_TRACE_OUTPUT), truncated: true };
}
