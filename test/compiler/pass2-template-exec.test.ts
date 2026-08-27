import { describe, test, expect } from "bun:test"
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
// Same import mode as generate-script.ts — the template ships inside the binary
// as text, so these tests exercise exactly what the LLM prompt embeds.
import TEMPLATE from "../../src/compiler/passes/bind-env/env-binding-template.sh" with { type: "text" }

/**
 * The helper block, up to where the generated per-dependency section begins.
 * Everything below `FAIL=0` is placeholder text the compiler fills in.
 */
const HELPERS = TEMPLATE.slice(0, TEMPLATE.indexOf("\nFAIL=0"))

type PythonKind = "pep668" | "no-pip" | "no-venv-module" | "working" | "absent"

/**
 * A fake `python3` on PATH. These are the hosts the venv bootstrap exists for,
 * and none of them can be reproduced by string-matching the template.
 */
function pythonShim(kind: PythonKind, envDir: string): string {
  const common = `#!/bin/bash
case "$1 $2" in
  "-m pip") [ "$3" = "--version" ] && { %PIP_VERSION% } ;;
esac
`
  switch (kind) {
    case "no-pip":
      // pip module absent, venv works and produces a venv WITH pip.
      return `#!/bin/bash
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then echo "No module named pip" >&2; exit 1; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  printf '%s\\n' '#!/bin/bash' 'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then exit 0; fi' > "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
exit 0
`
    case "pep668":
      // pip exists but refuses to install into the system interpreter.
      return `#!/bin/bash
if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "--version" ]; then echo "pip 24.0"; exit 0; fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "install" ]; then
  echo "error: externally-managed-environment" >&2; exit 1
fi
if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "show" ]; then exit 1; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  printf '%s\\n' '#!/bin/bash' 'if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then exit 0; fi' > "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
exit 0
`
    case "no-venv-module":
      // Debian's python3-venv split: pip absent AND venv cannot be created.
      return `#!/bin/bash
if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then echo "No module named pip" >&2; exit 1; fi
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  echo "ensurepip is not available. On Debian/Ubuntu install python3-venv." >&2; exit 1
fi
exit 0
`
    case "working":
      return `#!/bin/bash
exit 0
`
    case "absent":
      return ""
    default:
      return common.replace("%PIP_VERSION%", "exit 0")
  }
}

async function runHelpers(kind: PythonKind, script: string): Promise<{ code: number; out: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "pass2-exec-"))
  const binDir = path.join(dir, "bin")
  await mkdir(binDir, { recursive: true })
  const envDir = path.join(dir, ".skvm-env")
  if (kind !== "absent") {
    const shim = path.join(binDir, "python3")
    await writeFile(shim, pythonShim(kind, envDir))
    await chmod(shim, 0o755)
  }
  const scriptPath = path.join(dir, "run.sh")
  await writeFile(scriptPath, `${HELPERS}\nSKVM_ENV_DIR="${envDir}"\n${script}\n`)
  const proc = Bun.spawn(["bash", scriptPath], {
    cwd: dir,
    // Deliberately NOT /usr/bin: the shims are the only python on this PATH, so
    // no test can reach a real interpreter (and no test can reach the network).
    env: { PATH: `${binDir}:/bin`, HOME: dir, SKVM_ENV_DIR: envDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await rm(dir, { recursive: true, force: true })
  return { code, out: stdout + stderr }
}

describe("pass2 env-binding helpers — executed", () => {
  test("a PEP 668 interpreter falls through to a private venv", async () => {
    const r = await runHelpers("pep668", `pip_install requests && echo INSTALLED && echo "PY=$PY"`)
    expect(r.out).toContain("INSTALLED")
    expect(r.out).toContain(".skvm-env/bin/python")
    expect(r.code).toBe(0)
  })

  test("an interpreter with no pip bootstraps before installing", async () => {
    const r = await runHelpers("no-pip", `pip_install requests && echo INSTALLED`)
    expect(r.out).toContain("bootstrapping private venv")
    expect(r.out).toContain("INSTALLED")
  })

  test("a venv that cannot be created fails loudly, not silently", async () => {
    // Debian's python3-venv split. The message has to survive: the caller wraps
    // dependency checks in >/dev/null 2>&1, and a check is what triggers this.
    const r = await runHelpers("no-venv-module", `pip_install requests || echo FAILED`)
    expect(r.out).toContain("FAILED")
    expect(r.out).toContain("python3-venv")
  })

  test("a half-created venv is rebuilt rather than wedging the run", async () => {
    // `python3 -m venv --without-pip`, an interrupted run, or the repair loop's
    // own cleanup can leave bin/python with no pip. The old probe accepted it
    // and then dead-ended with no retry.
    const script = `
mkdir -p "$SKVM_ENV_DIR/bin"
printf '%s\\n' '#!/bin/bash' 'echo "No module named pip" >&2; exit 1' > "$SKVM_ENV_DIR/bin/python"
chmod +x "$SKVM_ENV_DIR/bin/python"
pip_install requests && echo INSTALLED
`
    const r = await runHelpers("no-pip", script)
    expect(r.out).toContain("rebuilding it")
    expect(r.out).toContain("INSTALLED")
  })

  test("a second run reuses the venv instead of re-resolving system python", async () => {
    // Idempotence is a stated requirement of these scripts.
    const script = `
mkdir -p "$SKVM_ENV_DIR/bin"
printf '%s\\n' '#!/bin/bash' 'exit 0' > "$SKVM_ENV_DIR/bin/python"
chmod +x "$SKVM_ENV_DIR/bin/python"
ensure_python && echo "PY=$PY"
`
    const r = await runHelpers("working", script)
    expect(r.out).toContain(".skvm-env/bin/python")
    expect(r.out).not.toContain("bootstrapping")
  })

  test("a path with spaces survives quoting", async () => {
    const r = await runHelpers("no-pip", `pip_install 'reportlab>=4.0' && echo INSTALLED`)
    expect(r.out).toContain("INSTALLED")
  })

  test("no python at all fails with a clear message", async () => {
    const r = await runHelpers("absent", `pip_install requests || echo FAILED`)
    expect(r.out).toContain("FAILED")
    expect(r.out).toContain("no python interpreter found")
  })
})
