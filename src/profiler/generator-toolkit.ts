/**
 * Declarative toolkit for the profiler's microbenchmark generators.
 *
 * Owns the scaffolding every generator used to copy-paste:
 *   - randomness helpers (`Rng`: random / randInt / randChoice / shuffle / sample),
 *   - L1/L2/L3 level dispatch (`defineGenerator`),
 *   - the `python3 << 'PYEOF'` eval-script template with checkpoint
 *     marshalling (`pyEval` / `PY_EMIT_CHECKPOINTS` / `requirePyModule`).
 *
 * Behavior contract: the default `Rng` is unseeded `Math.random`, read at
 * call time (never captured), so generated instances are distributed exactly
 * as before this toolkit existed and tests that pin `Math.random`
 * (test/profiler/eval-bug-fixes.test.ts) keep controlling generator output.
 * Seeded/reproducible profiling is a separate follow-up.
 */
import type { EvalCriterion } from "../core/types.ts"
import type { GeneratorLevel, MicrobenchmarkGenerator, MicrobenchmarkInstance } from "./types.ts"

export type { GeneratorLevel } from "./types.ts"

/** Randomness source handed to each level builder. */
export interface Rng {
  /** Uniform float in [0, 1) — the `Math.random` contract. */
  random(): number
  /** Uniform integer in [min, max], both ends inclusive. */
  randInt(min: number, max: number): number
  /** Uniform pick from a non-empty array. */
  randChoice<T>(arr: readonly T[]): T
  /** Copy of `arr` in randomized order (the historical biased-sort shuffle). */
  shuffle<T>(arr: readonly T[]): T[]
  /** `n` distinct elements of `arr` in randomized order. */
  sample<T>(arr: readonly T[], n: number): T[]
}

/**
 * The default randomness source: unseeded `Math.random`, read at call time.
 * Each method reproduces the exact expression the generators historically
 * inlined, so the distribution of generated instances is unchanged.
 */
export const mathRandomRng: Rng = {
  random: () => Math.random(),
  randInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  randChoice: (arr) => arr[Math.floor(Math.random() * arr.length)]!,
  shuffle: (arr) => [...arr].sort(() => Math.random() - 0.5),
  sample: (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n),
}

/**
 * Unbiased Fisher–Yates shuffle driven by `rng.random()`. Distinct from
 * `Rng.shuffle`, which reproduces the historical biased-sort shuffle: the
 * reason.* generators have always used Fisher–Yates (different algorithm,
 * different Math.random draw count), so they keep it via this helper.
 */
export function fisherYatesShuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.random() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/** Builds one microbenchmark instance for one difficulty level. */
export type LevelBuilder = (rng: Rng) => MicrobenchmarkInstance

/** Declarative spec for a microbenchmark generator. */
export interface GeneratorSpec {
  primitiveId: string
  /** Human-readable description of what each level tests (lands in the TCP). */
  descriptions: Record<GeneratorLevel, string>
  /** One builder per difficulty level. */
  levels: Record<GeneratorLevel, LevelBuilder>
}

/**
 * Build a `MicrobenchmarkGenerator` from a declarative spec. The returned
 * object satisfies the existing generator interface unchanged, so callers
 * (runner, registry, tests) cannot tell a migrated generator from a
 * hand-rolled one.
 */
export function defineGenerator(spec: GeneratorSpec): MicrobenchmarkGenerator {
  return {
    primitiveId: spec.primitiveId,
    descriptions: spec.descriptions,
    generate(level: GeneratorLevel): MicrobenchmarkInstance {
      return spec.levels[level](mathRandomRng)
    },
  }
}

/**
 * The Python statement that emits the checkpoint array consumed by the
 * framework evaluator. `pyEval` appends it as the script's final line;
 * eval bodies interpolate it for early exits
 * (`${PY_EMIT_CHECKPOINTS}` + `raise SystemExit(0)`).
 */
export const PY_EMIT_CHECKPOINTS = `print(json.dumps({"checkpoints": cp}))`

/** Spec for a checkpoint-scored Python eval script. */
export interface PyEvalSpec {
  /** Python modules to import in addition to `json` (e.g. ["re", "os"]). */
  imports?: string[]
  /**
   * Raw Python emitted before the standard scaffold — e.g. a
   * `requirePyModule` guard that must run before anything else.
   */
  preamble?: string
  /**
   * Shell command run before the `python3 << 'PYEOF'` heredoc — e.g.
   * `"bash solution.sh >/dev/null 2>&1"` to run the candidate solution
   * before the checkpoint script inspects its output files (the
   * gen.code.shell pattern). The toolkit owns the `"; "` join.
   */
  shellPrefix?: string
  /**
   * Python statements that append `{"name", "score", "reason"}` dicts to the
   * pre-initialized `cp` list. May use `${PY_EMIT_CHECKPOINTS}` followed by
   * `raise SystemExit(0)` to exit early after a fatal checkpoint.
   */
  body: string
}

/**
 * Build a `script` eval criterion wrapping `body` in the standard
 * checkpoint-marshalling scaffold:
 *
 *   python3 << 'PYEOF'
 *   <preamble?>
 *   import json[, ...imports]
 *   cp = []
 *   <body>
 *   print(json.dumps({"checkpoints": cp}))
 *   PYEOF
 */
export function pyEval(spec: PyEvalSpec): EvalCriterion {
  const modules = ["json", ...(spec.imports ?? [])]
  const lines = [
    ...(spec.preamble ? [spec.preamble] : []),
    `import ${modules.join(", ")}`,
    "cp = []",
    spec.body.replace(/^\n+/, "").trimEnd(),
    PY_EMIT_CHECKPOINTS,
  ]
  return {
    method: "script",
    command: `${spec.shellPrefix ? `${spec.shellPrefix}; ` : ""}python3 << 'PYEOF'\n${lines.join("\n")}\nPYEOF`,
    expectedExitCode: 0,
  }
}

/**
 * Standard "check the solution file exists → run it → early-exit on failure"
 * eval prelude shared by the gen.code.* generators. Interpolate at the top
 * of a `pyEval` body (the body must import `os` and `subprocess`). Emits the
 * `script_created` and `execution_success` checkpoints downstream tooling
 * keys on, so the names live here and nowhere else.
 */
export function pyRunSolution(solutionFile: string, runCmd: string[]): string {
  const cmdList = `[${runCmd.map((c) => `'${c}'`).join(", ")}]`
  return `
# Check script was created
if os.path.exists('${solutionFile}'):
    cp.append({"name": "script_created", "score": 1.0, "reason": None})
else:
    cp.append({"name": "script_created", "score": 0.0, "reason": "${solutionFile} not found"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)

# Execute the script
proc = subprocess.run(${cmdList}, capture_output=True, text=True)
if proc.returncode == 0:
    cp.append({"name": "execution_success", "score": 1.0, "reason": None})
else:
    cp.append({"name": "execution_success", "score": 0.0, "reason": f"exit code {proc.returncode}: {proc.stderr[:200]}"})
    ${PY_EMIT_CHECKPOINTS}
    raise SystemExit(0)`
}

/**
 * Python preamble that aborts the eval with an `infraError` (rather than a
 * score-0 failure) when a required third-party library is not installed. A
 * missing dependency is an environment fault, not a model capability gap, so
 * the profiler skips the instance instead of penalising the model for it.
 *
 * `context` names the caller in the skip message (e.g. "gen.code.python L3").
 */
export function requirePyModule(module: string, context: string): string {
  return `import json, importlib.util
if importlib.util.find_spec(${JSON.stringify(module)}) is None:
    print(json.dumps({"infraError": "${context} requires the ${module} library, which is not installed in the eval environment"}))
    raise SystemExit(0)`
}
