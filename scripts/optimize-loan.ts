// The loan optimize CLI: a thin convenience wrapper that runs the DSPy loan
// optimizer (py/dspy_optimizer/optimize_loan.py) with the project's Python
// environment, forwarding any flags through. The optimizer itself lives in
// Python (COPRO over the underwriting instruction); this wrapper just spares the
// caller from remembering the venv path and module invocation, so the loan loop
// is reachable from npm alongside the refund optimizer.
//
// Usage:
//   npm run optimize:loan -- --dry-run            (keyless: DummyLM + mock bridge)
//   npm run optimize:loan -- --eval-sample 12     (live: needs ANTHROPIC_API_KEY)
//   npm run optimize:loan -- --breadth 6 --depth 3
//
// All flags after `--` are passed straight to optimize_loan.py.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(process.cwd());
const PY_DIR = join(REPO_ROOT, "py");
const VENV_PYTHON = join(PY_DIR, "dspy_optimizer", ".venv", "bin", "python");

// Prefer the committed venv python so the run uses the pinned DSPy; fall back to
// the ambient python3 if the venv is not present, with a clear note.
function resolvePython(): string {
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON;
  process.stderr.write(
    `note: ${VENV_PYTHON} not found; falling back to python3 on PATH. ` +
      `Create the venv (see py/dspy_optimizer/README.md) for the pinned DSPy.\n`,
  );
  return "python3";
}

function main(): void {
  const python = resolvePython();
  const args = ["-m", "dspy_optimizer.optimize_loan", ...process.argv.slice(2)];
  const child = spawn(python, args, {
    cwd: PY_DIR,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  child.on("error", (error: unknown) => {
    process.stderr.write(`failed to launch the loan optimizer: ${String(error)}\n`);
    process.exitCode = 1;
  });
}

main();
