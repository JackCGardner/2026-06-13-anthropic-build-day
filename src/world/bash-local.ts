// The local-exec Bash substrate: the keyless local stand-in for the microVM
// filesystem the live path runs commands in. It implements the BashSubstrate
// seam by spawning real shell processes via Node child_process inside a
// per-fixture temp working directory, so a script the harness runs (curl, a
// generated tool client, a shell pipeline) executes for real and returns a real
// exit code, stdout, and stderr.
//
// The egress seam is closed by environment, not by code in the command path.
// Every process is spawned with GATEWAY_BASE_URL plus HTTP_PROXY / HTTPS_PROXY
// pointing at the egress gateway and SYNTH_SANDBOX_TAG carrying the per-sandbox
// binding. A curl inside the working directory therefore reaches the gateway
// (directly via GATEWAY_BASE_URL, or transparently because the standard proxy
// variables route its outbound request through the gateway), which resolves the
// tag to (fixtureId, runId) and dispatches into the scoped kernels. The command
// path stays oblivious to all of this: it just makes HTTP calls and gets
// wire-faithful responses, exactly as it would against the real APIs.
//
// SEAM: this is one implementation of BashSubstrate. The live Vercel Sandbox
// substrate is a SEPARATE later implementation of this same interface that runs
// commands inside an ephemeral Firecracker microVM and wires the identical env
// (GATEWAY_BASE_URL, HTTP(S)_PROXY, SYNTH_SANDBOX_TAG) into the VM. The World
// Runner depends only on BashSubstrate, so swapping local-exec for the sandbox
// changes nothing above this file. TODO(live-substrate): add bash-sandbox.ts.

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import type { BashSubstrate } from "@/engine";

// The egress wiring a spawned command needs to reach the gateway. The harness is
// told the GATEWAY_BASE_URL; the proxy variables make standard HTTP clients
// (curl and friends) route their outbound requests through the same endpoint;
// SYNTH_SANDBOX_TAG is the binding the gateway resolves to (fixtureId, runId).
export interface GatewayBinding {
  // The base URL the gateway listens on, e.g. http://127.0.0.1:<ephemeralPort>.
  gatewayBaseUrl: string;
  // The per-sandbox binding tag the gateway maps back to (fixtureId, runId).
  sandboxTag: string;
}

// Construction options for one local sandbox. A sandbox is bound to exactly one
// gateway binding for its lifetime, mirroring how a live microVM is provisioned
// for a single run of a single fixture.
export interface LocalBashSubstrateOptions {
  binding: GatewayBinding;
  // Extra environment to expose to spawned commands. The egress variables below
  // always win, so a caller cannot accidentally unbind the sandbox.
  env?: Record<string, string>;
  // Per-command wall-clock ceiling. A command that exceeds it is killed and the
  // substrate reports the kill in stderr with a non-zero exit code.
  timeoutMs?: number;
}

// A seed file to materialize in the working directory before any command runs:
// the local equivalent of provisioning the microVM filesystem.
export interface SeedFile {
  // Path relative to the working directory. Parent directories are created.
  path: string;
  contents: string;
  // Optional POSIX mode, e.g. 0o755 for an executable script.
  mode?: number;
}

// The result of one command: the real process outcome. A failure to spawn (for
// example, no shell on PATH) surfaces as a non-zero exitCode with the reason on
// stderr rather than a thrown error, so the harness sees a uniform shape.
export interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// The default per-command ceiling. Generous enough for a local curl round-trip
// to the in-process gateway, tight enough that a hung command cannot stall a run.
const DEFAULT_TIMEOUT_MS = 30_000;

// The local-exec substrate. One instance owns one temp working directory for the
// lifetime of one fixture run; dispose() removes it. Commands are spawned with
// the egress env so their outbound HTTP reaches the gateway under the binding.
export class LocalBashSubstrate implements BashSubstrate {
  private workdir: string | null = null;
  private disposed = false;
  private readonly binding: GatewayBinding;
  private readonly extraEnv: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(options: LocalBashSubstrateOptions) {
    this.binding = options.binding;
    this.extraEnv = options.env ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // Create the isolated working directory. Idempotent: a second call returns the
  // already-created path. Call before runCommand or writeSeedFile.
  async create(): Promise<string> {
    if (this.disposed) {
      throw new Error("LocalBashSubstrate: cannot create after dispose");
    }
    if (this.workdir === null) {
      this.workdir = await mkdtemp(join(tmpdir(), "synth-sandbox-"));
    }
    return this.workdir;
  }

  // The working directory path, once created. The local stand-in for the
  // microVM filesystem root the command path sees.
  get workingDirectory(): string {
    if (this.workdir === null) {
      throw new Error("LocalBashSubstrate: create() must run before use");
    }
    return this.workdir;
  }

  // Materialize one seed file inside the working directory, creating parent
  // directories as needed. Paths that escape the working directory are rejected
  // so seeding stays scoped to this sandbox.
  async writeSeedFile(file: SeedFile): Promise<void> {
    const root = await this.create();
    const target = resolve(root, file.path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(
        `LocalBashSubstrate: seed path escapes working directory: ${file.path}`,
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, { mode: file.mode });
  }

  // Materialize several seed files in order.
  async writeSeedFiles(files: SeedFile[]): Promise<void> {
    for (const file of files) {
      await this.writeSeedFile(file);
    }
  }

  // Run one command for real inside the working directory. The command is run
  // through a login shell so a generated script behaves as it would in the VM:
  // `bash -lc <cmd>`, falling back to `sh -c <cmd>` on systems without bash. The
  // seam passes a program plus argv; they are composed into a single shell
  // command line so quoting and pipelines a generated client emits are honored.
  async runCommand(input: {
    cmd: string;
    args: string[];
  }): Promise<BashResult> {
    if (this.disposed) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: "LocalBashSubstrate: substrate disposed",
      };
    }
    const cwd = await this.create();
    const commandLine = composeCommandLine(input.cmd, input.args);
    const env = this.spawnEnv();

    const bash = await spawnShell("bash", ["-lc", commandLine], cwd, env, this.timeoutMs);
    if (bash.spawned) {
      return bash.result;
    }
    // No bash on PATH: fall back to the POSIX shell, the same command line.
    const sh = await spawnShell("sh", ["-c", commandLine], cwd, env, this.timeoutMs);
    if (sh.spawned) {
      return sh.result;
    }
    return {
      exitCode: 127,
      stdout: "",
      stderr: "LocalBashSubstrate: no bash or sh on PATH",
    };
  }

  // Remove the working directory. Idempotent and safe to call without create().
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.workdir !== null) {
      await rm(this.workdir, { recursive: true, force: true });
      this.workdir = null;
    }
  }

  // The environment every spawned command inherits. The egress variables are
  // applied last so the binding cannot be clobbered by the caller's extra env or
  // by the parent process environment.
  private spawnEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...this.extraEnv,
      GATEWAY_BASE_URL: this.binding.gatewayBaseUrl,
      HTTP_PROXY: this.binding.gatewayBaseUrl,
      HTTPS_PROXY: this.binding.gatewayBaseUrl,
      http_proxy: this.binding.gatewayBaseUrl,
      https_proxy: this.binding.gatewayBaseUrl,
      SYNTH_SANDBOX_TAG: this.binding.sandboxTag,
    };
  }
}

// Compose a program and its argv into a single shell command line. A bare
// program with no args is passed through verbatim so a full command string the
// harness already built (e.g. a curl invocation) survives unquoted; otherwise
// each argument is single-quoted so spaces and metacharacters are literal.
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

// Spawn one shell and collect its real outcome. Returns spawned:false (without
// throwing) when the shell binary is missing, so the caller can fall back.
function spawnShell(
  shell: string,
  shellArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ spawned: true; result: BashResult } | { spawned: false }> {
  return new Promise((resolveOutcome) => {
    const child = spawn(shell, shellArgs, { cwd, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // ENOENT means this shell is not installed; signal a fallback rather than
      // reporting it as a command failure.
      if (err.code === "ENOENT") {
        resolveOutcome({ spawned: false });
        return;
      }
      resolveOutcome({
        spawned: true,
        result: { exitCode: 127, stdout, stderr: stderr + String(err.message) },
      });
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const note = timedOut
        ? `LocalBashSubstrate: command exceeded ${timeoutMs}ms and was killed`
        : "";
      resolveOutcome({
        spawned: true,
        result: {
          // A signalled exit (including the timeout kill) reports the
          // conventional 128 + signal-number code so the harness sees a real,
          // non-zero failure.
          exitCode: code ?? (signal ? 128 + signalNumber(signal) : 1),
          stdout,
          stderr: note ? (stderr ? `${stderr}\n${note}` : note) : stderr,
        },
      });
    });
  });
}

// Map a POSIX signal name to its number for the 128 + N exit convention. Falls
// back to SIGKILL's number for the timeout path and any unmapped signal.
function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return numbers[signal] ?? 9;
}

// Construct and create a local sandbox in one call, for callers that want a
// ready-to-use working directory without managing the create() step.
export async function createLocalBashSubstrate(
  options: LocalBashSubstrateOptions,
): Promise<LocalBashSubstrate> {
  const substrate = new LocalBashSubstrate(options);
  await substrate.create();
  return substrate;
}
