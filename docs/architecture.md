# SkVM Architecture

High-level map of SkVM's subsystems, data flow, and on-disk layout. For usage and command reference see [usage.md](usage.md); for deep design notes see [docs/skvm/](skvm/).

## Data flow

```
Profile Tool ──TCP──> AOT Compiler ──Variant──> Runtime + Agent
     │                    │                         │
 26 primitives         3 passes               JIT-boost + JIT-optimize
 L1 → L2 → L3        1: capability gaps       - code solidification (boost)
                     2: env binding           - skill content improvement (optimize)
                     3: concurrency DAG       - opencode-based optimizer loop
```

Three layers, each independently usable:

1. **Profile** a model+harness against a fixed primitive catalog → persist a **TCP** (Target Capability Profile) describing proficiency at L1/L2/L3 for each primitive.
2. **Compile** a skill against a TCP → rewrite missing/weak primitives, bind dependencies, extract parallelism → emit a variant.
3. **Optimize** at runtime: boost short-circuits repeated LLM tool calls with solidified code; optimize rewrites the skill based on real execution evidence.

## Subsystems

```
src/
├── index.ts            # CLI entry — hand-rolled flag parser
├── core/               # Shared types, config, logging, concurrency, headless-agent helpers
├── providers/          # LLMProvider backends (Anthropic SDK, OpenRouter)
├── adapters/           # Five agent harness adapters (registry.ts is the single source of truth)
├── profiler/           # 26 microbenchmark generators + runner
├── compiler/           # 3-pass AOT compiler
├── runtime/            # RuntimeHooks interface consumed by adapters
├── jit-boost/          # Runtime code solidification
├── jit-optimize/       # Proposal-based skill optimization loop
├── proposals/          # Proposal storage and deployment
├── framework/          # Task runner + evaluation engine (shared between profiler and bench)
└── bench/              # Benchmark orchestrator, conditions, loaders, reports
```

### Core (`src/core/`)

Shared foundation used by every other subsystem:

- `primitives.ts` — the 26-primitive capability catalog
- `types.ts` — TCP, SCR, `AgentAdapter`, run-result types + Zod schemas
- `config.ts` — settings, env overrides, all cache-path constants
- `concurrency.ts` — `Pool`, `runScheduled`, `distributeSlots` (hierarchical scheduler used by `profile` and `bench`)
- `headless-agent.ts` — driver-based one-shot agent invoker used by `jit-boost/candidates.ts` and `jit-optimize/optimizer.ts`. Default driver: `opencode`.
- `cost.ts`, `logger.ts`, `conversation-logger.ts`

### Providers (`src/providers/`)

Pluggable `LLMProvider` with two implementations: `anthropic.ts` (Anthropic SDK, tool_use supported) and `openrouter.ts` (OpenAI-compatible). `structured.ts` exposes `extractStructured()` with a two-layer strategy: tool_use when available, prompt + parse fallback otherwise.

### Adapters (`src/adapters/`)

`AgentAdapter` is the interface for agent harnesses. Each adapter runs an agent with tools against a model, optionally with `RuntimeHooks` (`beforeLLM`, `afterLLM`, `afterTool`, `afterRun`) injected for JIT monitoring and solidification.

Five implementations, registered centrally in **`src/adapters/registry.ts`** — the single source of truth for `AdapterName`, `ALL_ADAPTERS`, and `createAdapter()`:

| Adapter | Source | Notes |
|---|---|---|
| `bare-agent` | `bare-agent.ts` | Minimal built-in loop with 5 tools (`read_file`, `write_file`, `list_directory`, `execute_command`, `web_fetch`). Primary profile/test adapter. |
| `opencode` | `opencode.ts` | Wraps OpenCode CLI, parses NDJSON event stream. |
| `openclaw` | `openclaw.ts` | Wraps OpenClaw CLI, manages temporary agent instances. |
| `hermes` | `hermes.ts` | Wraps the `hermes` CLI, parses session export JSON. Full token/cost usage. |
| `jiuwenclaw` | `jiuwenclaw.ts` | Wraps `jiuwenclaw-cli` over JSON-RPC. Token/cost **not** persisted upstream — bench/profile report `$0`. Invoked via `python3 -m jiuwenclaw.app_cli` from `skvm.config.json → adapters.jiuwenclaw`. |

### Profiler (`src/profiler/`)

26 microbenchmark generators (`generators/`, one per primitive) produce randomized test instances at L1/L2/L3. The runner (`runner.ts`) exercises each level and records proficiency.

Two evaluation patterns:

- **Tool-use primitives** (`gen.code.*`, `tool.*`) — the agent runs tools; the eval checks files in `workDir`.
- **Text-only primitives** (`reason.*`, `follow.*`, `gen.text.*`) — the profiler writes the LLM response to `response.txt`; a script reads it.

Eval scripts use the `python3 << 'PYEOF'` heredoc pattern to avoid shell-quoting issues.

### Compiler (`src/compiler/`)

Three sequential passes, each emitting transforms that are validated by `guard.ts`:

- **Pass 1** (`pass1/`): SCR extraction → gap analysis → agentic rewriting via `compiler-agent.ts`. Only SCR extraction and agent rewriting call the LLM; gap analysis is pure computation.
- **Pass 2** (`pass2/`): dependency manifest extraction (LLM) → presence checks (shell) → idempotent `env-setup.sh` generation.
- **Pass 3** (`pass3/`): workflow decomposition (LLM) → DAG construction (pure) → DLP/ILP/TLP parallelism extraction.

### JIT-boost (`src/jit-boost/`)

Code solidification for runtime speed. Independent of the compiler, profiler, and TCP.

1. **Candidate generation** (`candidates.ts`) — a headless agent analyzes the full skill directory and emits `boost-candidates.json` with `BoostCandidate` entries (`keywords`, `codeSignature`, `functionTemplate`, `params`). Auto-generated on first bench run with `--conditions=jit-boost`.
2. **Runtime hooks** (`solidifier.ts`):
   - **Monitor** (`afterLLM`) — matches LLM tool calls against code signatures, tracks consecutive matches per candidate.
   - **Promote** (`beforeLLM`) — after N consecutive matches (default 3), extracts params from the prompt, executes the template directly, and bypasses the LLM. Falls back on failure; demotes after M fallbacks (default 3).

**Public API**: `createBoostHooks({ skillId })` returns `RuntimeHooks` (`beforeLLM` + `afterLLM`) installable in any adapter via `setHooks()`.

**Storage**: `~/.skvm/proposals/jit-boost/{skillId}/` — model/harness agnostic.

### JIT-optimize (`src/jit-optimize/`)

Round-based skill-content improvement. Standalone post-execution analysis with no dependency on compiler, profiler, TCP, or SCR.

The design has three orthogonal axes:

- **Task source** — where evidence comes from:
  - `synthetic-task` — optimizer LLM derives tasks from the skill
  - `real-task` — run explicit bench tasks (supports held-out test set via `--test-tasks`)
  - `execution-log` — parse pre-existing conversation logs (no rerun)
- **Loop** — `rounds`, `runsPerTask`, `convergence`, `holdoutTestSet`, `baseline`. Round 0 is always the baseline; rounds 1..N each call the optimizer with the previous round's evidence + accumulated history, then rerun the tasks against the new skill to measure improvement.
- **Delivery** — single format: **proposal**. `keepAllRounds` controls pruning, `autoApply` controls whether the original `skillDir` is overwritten.

**Evidence** is a unified schema fed to the optimizer regardless of task source. See [docs/skvm/](skvm/) for the full schema and round protocol.

**Optimizer** runs as a **headless agent** (`core/headless-agent.ts`, default driver `opencode`):

1. Engine copies the skill folder to a temp workspace, serializes evidence + history into `.optimize/` as both JSON and markdown.
2. Agent is spawned with cwd set to the workspace and uses its native tools (read/edit/write/glob/grep/bash) to edit any file — SKILL.md or bundle scripts.
3. Agent writes `.optimize/submission.json` with `{rootCause, reasoning, confidence, changedFiles, changes?, noChanges?}`.
4. Engine snapshots the workspace (minus `.optimize/`) into `round-N/` under the proposal, computes the actual file diff, and validates against the agent's declared `changedFiles`.

`rootCause` is **required**: the optimizer must articulate the *underlying problem* it diagnosed, not just the changes it made. History entries preserve rootCause across rounds so later rounds can avoid repeating diagnoses that didn't improve scores.

Adding a new agent driver (e.g. claude-code) is done by extending `core/headless-agent.ts` and plumbing the driver name through `OptimizeConfig.driver` — jit-optimize has no hard dependency on any particular agent tool.

**Public API**: `jitOptimize(config)` → `JitOptimizeResult` (`proposalId`, `bestRound`, per-round stats).

### Runtime (`src/runtime/`)

`runtime/types.ts` defines the `RuntimeHooks` interface (`beforeLLM`, `afterLLM`, `afterTool`, `afterRun`) consumed by the five adapters. JIT-boost is the primary producer today.

### Framework (`src/framework/`)

Evaluation engine shared between the profiler and bench. **Four frozen top-level methods**: `script` (shell exit code), `file-check` (exact/contains/regex/json-schema), `llm-judge` (rubric-scored 0–1), and `custom` (dispatch to a registered evaluator).

Any new evaluation strategy registers under `custom` with a new `evaluatorId` and carries per-task data on the criterion's `payload` field — this keeps `switch(criterion.method)` in `evaluator.ts` exhaustively type-checked. Concrete custom evaluators live in `src/bench/evaluators/` and self-register via the barrel import in `index.ts`.

Authoring `grade.py` for python-grade: see [grade-protocols.md](skvm/grade-protocols.md).

### Bench (`src/bench/`)

Orchestrator for skill × model × condition matrices. Importers for PinchBench and SkillsBench formats, condition evaluation, and a skill registry. Logs and reports land under `~/.skvm/log/bench/{sessionId}/`. LLM-judge evaluations can be deferred post-run with `--async-judge`.

### Proposals (`src/proposals/`)

Unified storage tree for JIT-optimize output. Shared between the `skvm proposals` CLI and the bench `jit-optimized` condition. See [Proposals tree](#proposals-tree) below.

## Data layout

Two roots, kept strictly separate:

### `skvm-data/` — input dataset

Git submodule containing `skills/` and `tasks/`. Clone with `--recurse-submodules` or `git submodule update --init`. Override with `SKVM_DATA_DIR` or `--skvm-data-dir=<path>`.

```
skvm-data/
├── skills/             # Skill definitions
└── tasks/              # Benchmark tasks
```

Only required when running the bench harness; commands taking an explicit `--skill` / `--task` path do not need it.

### `~/.skvm/` — runtime cache

User-global cache for all runtime artifacts, shared across every directory skvm is invoked from. Override with `SKVM_CACHE` or `--skvm-cache=<path>`.

```
~/.skvm/
├── profiles/           # Cached TCPs and profiling sidecars    (SKVM_PROFILES_DIR)
├── log/                # Profile, compile, bench, runtime logs (SKVM_LOGS_DIR)
└── proposals/          # Proposal-tree outputs                 (SKVM_PROPOSALS_DIR)
    ├── aot-compile/    # Compiled skill variants
    ├── jit-boost/      # Boost candidates and solidification state
    └── jit-optimize/   # JIT-optimize rounds (see below)
```

The legacy flat `data/` submodule has been retired. All AOT and JIT outputs live under `~/.skvm/proposals/`.

### Proposals tree

```
~/.skvm/proposals/jit-optimize/{harness}/{safeTargetModel}/{skillName}/{timestamp}/
  original/              # copy of the starting skill folder
  round-0/               # baseline (same as original — kept for uniform round enumeration)
  round-1/ … round-N/    # full optimized skill folder per round
  history.json           # HistoryEntry[] + bestRound + bestRoundReason
  analysis.md            # human-readable summary
  meta.json              # { status, acceptedRound, bestRound, optimizerModel, … }
  round-N-agent-logs/    # conversation logs from agent runs
  round-N-optimizer-logs/# optimizer NDJSON
```

Each round directory is a full, usable skill folder (`SKILL.md` + bundle files).

The path segment holds the **target** model — what the optimized skill is tuned to run on. The **optimizer** model (the LLM that did the editing) is recorded in `meta.json.optimizerModel` but is intentionally not in the path: bench `jit-optimized` lookups, the file lock, and CLI filters are all naturally target-keyed. `--target-model` is therefore required for every `skvm jit-optimize` invocation, including `--task-source=log` (where it's the storage key, not used for execution).

`ProposalMeta.status` is proposal-level (`pending | accepted | rejected`). `acceptedRound` records which specific round was deployed. `bestRound` is the engine's recommendation; override via `skvm proposals accept <id> --round=N`.

The bench `jit-optimized` condition reads `round-{bestRound}/` of the latest proposal for a given `(harness, targetModel, skillName)` via `getLatestBestRoundDir`.

**Proposals root resolution**: `--proposals-dir=<path>` > `SKVM_PROPOSALS_DIR` env > default (`<cacheRoot>/proposals`, where `cacheRoot` is `SKVM_CACHE` or `~/.skvm`).

## Conventions

- TypeScript + Bun, no build step. Bun auto-loads `.env` for `bun run`.
- Prefer `Bun.file()` / `Bun.write()` over `node:fs`.
- Zod schemas for all JSON artifacts — `types.ts` defines types and schemas together.
- All imports use the `.ts` extension (required by `verbatimModuleSyntax`).
- Plans and deep design docs go under `docs/skvm/`.
- CLI model ids carry a `<provider>/` prefix that picks a route in `providers.routes`; skvm strips the first `/`-segment before the backend SDK sees the id. Examples: `openrouter/qwen/qwen3-30b-a3b-instruct-2507`, `openrouter/anthropic/claude-sonnet-4.6`, `anthropic/claude-sonnet-4.6`, `openai/gpt-4o`, `self/qwen3-7b`. Unprefixed ids error out — see [providers.md](providers.md).
