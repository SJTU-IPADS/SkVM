// Single source of truth for user-visible defaults: CLI flags, task/bench
// file schema fields, and skvm.config.json fields. Internal implementation
// defaults (provider maxTokens, retry timing, compiler pass budgets,
// file-lock TTL, JIT selection thresholds, etc.) do NOT belong here — they
// stay next to the code that owns them.

/** Task file schema defaults (user-authored task.json / bench task files). */
export const TASK_FILE_DEFAULTS = {
  timeoutMs: 120_000,
  maxSteps: 30,
  category: "general",
  gradingType: "automated",
  hostReady: true,
} as const

/** EvalCriterion defaults surfaced to user-authored eval blocks. */
export const EVAL_DEFAULTS = {
  /** script eval: expected process exit code when criterion matches */
  scriptExpectedExitCode: 0,
  /** llm-judge eval: maximum score assigned */
  llmJudgeMaxScore: 1.0,
} as const

/** bench.json top-level defaults used by BenchConfigFileSchema. */
export const BENCH_CONFIG_DEFAULTS = {
  excludedTasks: [] as readonly string[],
  defaultConditions: ["no-skill", "original", "aot-compiled", "jit-optimized"] as readonly string[],
  defaultJitRuns: 3,
  defaultTimeoutMult: 1.0,
  defaultMaxSteps: 30,
  models: [] as readonly string[],
} as const

/** `skvm.config.json` headlessAgent section. */
export const HEADLESS_AGENT_DEFAULTS = {
  driver: "opencode",
  modelPrefix: "openrouter/",
  /** Conservative context window default for custom OpenAI-compatible endpoints. */
  contextLimit: 128_000,
  /** Conservative output token default for custom OpenAI-compatible endpoints. */
  outputLimit: 16_384,
} as const

/**
 * CLI flag defaults. Fields are named by command/use-case so that two
 * coincidentally equal values never get collapsed into one (e.g.
 * benchRunsPerTask vs jitOptimizeRunsPerTask are intentionally different).
 */
export const CLI_DEFAULTS = {
  adapter: "bare-agent",
  // Concurrency
  concurrency: 1,
  benchJudgeConcurrency: 4,
  // Bench knobs
  jitRuns: 3,
  timeoutMult: 1.0,
  maxSteps: 30,
  benchRunsPerTask: 1,
  // jit-optimize knobs (intentionally different from bench)
  jitOptimizeRunsPerTask: 2,
  jitOptimizeTaskConcurrency: 1,
  syntheticTrainCount: 3,
  syntheticTestCount: 2,
  // AOT-compile / pipeline
  compilerPasses: [1] as readonly number[],
  // Profile
  profileInstances: 3,
  // List
  listLimit: 20,
  listSort: "recent",
  // Report server
  reportPort: 7878,
  reportHost: "127.0.0.1",
  // bench skill mode
  skillMode: "inject",
} as const

/**
 * Default model ids. Project convention: always use dot form
 * (`claude-sonnet-4.6`) — never dash form (`claude-sonnet-4-6`) —
 * across CLI defaults, provider fallbacks, pricing keys, and comments.
 */
export const MODEL_DEFAULTS = {
  judge: "anthropic/claude-sonnet-4.6",
  compiler: "anthropic/claude-sonnet-4.6",
} as const
