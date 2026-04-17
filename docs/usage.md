# SkVM Usage

Command reference and workflows for the `skvm` CLI. For a 1-minute onboarding see the [README](../README.md); for subsystem and data-layout details see [architecture.md](architecture.md).

## CLI conventions

```bash
skvm <command> [options]
skvm --help
skvm <command> --help
skvm --verbose <command>           # enable debug logging
```

Flags use `--key=value` format (no space-separated form). `bun run skvm ...` works interchangeably with the installed `skvm` binary — all examples below use `skvm` for brevity.

Top-level commands:

| Command | Purpose |
|---|---|
| `profile` | Profile a model's primitive capabilities |
| `aot-compile` | AOT-compile skill(s) for target model(s) |
| `pipeline` | Profile if needed, then aot-compile |
| `run` | Run one task with an optional skill (execute-only, no scoring) |
| `bench` | Run benchmark conditions across tasks/models |
| `jit-optimize` | Optimize a skill from synthetic, real, or log-based evidence |
| `proposals` | List, inspect, accept, or reject JIT-optimize proposals |
| `clean-jit` | Remove persisted JIT artifacts for a model+adapter |
| `logs` | List recent runs across subsystems |

## Adapters & providers

Five agent harness adapters, all registered in `src/adapters/registry.ts`:

- `bare-agent` — minimal built-in agent loop. Primary adapter for profiling and testing.
- `opencode` — wraps the [OpenCode](https://github.com/sst/opencode) CLI.
- `openclaw` — wraps the OpenClaw CLI.
- `hermes` — wraps the Hermes CLI. Populates full token/cost usage.
- `jiuwenclaw` — wraps `jiuwenclaw-cli` over JSON-RPC. Token/cost are **not** persisted upstream, so bench/profile aggregators report `$0` for jiuwenclaw runs.

All commands (`profile`, `aot-compile`, `run`, `bench`, `jit-optimize`) accept any of these five via `--adapter=<name>`.

Two LLM provider backends under `src/providers/`:

- **Anthropic Claude API** — used for the compiler backend. Set `ANTHROPIC_API_KEY`.
- **OpenRouter API** — used for agent execution, profiling, and most optimizer/target models. Set `OPENROUTER_API_KEY`.

## `profile`

Profiles a model+harness against the 26-primitive capability set and writes cached TCPs under `~/.skvm/profiles/`.

```bash
# Single model
skvm profile --model=qwen/qwen3-30b-a3b-instruct-2507 --adapter=bare-agent

# Multiple models in parallel
skvm profile --model=<id1>,<id2> --concurrency=4

# Multiple adapters
skvm profile --model=<id> --adapter=bare-agent,opencode

# Batch from bench config
skvm profile --batch --concurrency=6

# List cached profiles
skvm profile --list
```

Notes:
- Profiles are cached per `(model, adapter)`. Re-runs hit the cache by default.
- `--force` re-runs profiling instead of using the cache.
- `--concurrency` distributes slots hierarchically per-adapter then per-model via `distributeSlots()`.

## `aot-compile`

AOT-compiles one or more skills for one or more target model+harness pairs. Variants are written under `~/.skvm/proposals/aot-compile/`.

```bash
# One skill for one model
skvm aot-compile --skill=path/to/SKILL.md --model=<id>

# Multiple models
skvm aot-compile --skill=<path> --model=<id1>,<id2> --concurrency=2

# Run selected passes only
skvm aot-compile --skill=<path> --model=<id> --pass=1,2

# Preview without writing
skvm aot-compile --skill=<path> --model=<id> --dry-run

# Override the compiler backend model
skvm aot-compile --skill=<path> --model=<id> --compiler-model=anthropic/claude-sonnet-4.6
```

Three sequential compiler passes:

- **Pass 1** — SCR extraction, gap analysis, and agentic skill rewriting for missing/weak primitives
- **Pass 2** — dependency manifest extraction and idempotent `env-setup.sh` generation
- **Pass 3** — workflow decomposition, DAG construction, and parallelism hints

## `pipeline`

Profiles the target (if no cached TCP exists) and then compiles.

```bash
skvm pipeline --skill=path/to/SKILL.md --model=<id>
```

## `run`

Executes one task against one model+adapter, with or without a skill. **Execute-only — does not score the result.** Use `bench` for scored runs.

```bash
# Without a skill
skvm run --task=path/to/task.json --model=<id> --adapter=bare-agent

# With a skill
skvm run --task=<path> --skill=<path> --model=<id> --adapter=bare-agent

# Reuse a work directory (no cleanup between runs)
skvm run --task=<path> --skill=<path> --model=<id> --workdir=./tmp/run-workdir
```

## `bench`

Runs benchmark conditions over tasks, skills, and models. Logs and reports land under `~/.skvm/log/bench/{sessionId}/`.

```bash
# Single model
skvm bench --model=<id> --adapter=bare-agent

# Multiple models in parallel
skvm bench --model=<id1>,<id2> --concurrency=4

# Specific conditions and tasks
skvm bench --model=<id> --conditions=no-skill,original,aot,jit-boost --tasks=<task1>,<task2>

# Defer LLM-judge evaluation (write an async-judge manifest)
skvm bench --model=<id> --async-judge

# Run the deferred judge later
skvm bench judge --manifest=<dir> --judge-model=<id> --concurrency=4
```

Condition families:

- `no-skill` — baseline, no skill provided to the model
- `original` — unmodified skill from `skvm-data/skills/`
- `aot-compiled` and `aot-compiled-p{1,2,3}` — full or per-pass AOT output
- `jit-boost` — boost-hooks-enabled runtime
- `jit-optimized` — latest best round from the proposals tree

## `jit-optimize`

Proposal-based skill improvement loop. Three task sources — `synthetic`, `real`, `log` — feed the same round-based optimizer; output goes to `~/.skvm/proposals/jit-optimize/`.

Required for every source:
- `--skill=<path>` (or `--skill-list=<file>`) — skill directory to optimize
- `--task-source=synthetic | real | log` — must be set explicitly
- `--optimizer-model=<id>` — LLM that does the editing
- `--target-model=<id>` — model the skill is tuned for (storage key, and for `synthetic`/`real` also what runs the tasks)
- `--target-adapter=<name>` — optional, defaults to `bare-agent`

### `--task-source=synthetic` (autotune)

The optimizer LLM derives training and held-out tasks directly from the skill, then loops edit → rerun → score.

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=synthetic \
  --task-concurrency=3 \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --target-model=qwen/qwen3-30b-a3b-instruct-2507 \
  --rounds=1
```

Synthetic-specific flags:
- `--synthetic-count=<n>` — training tasks to generate (default `2`)
- `--synthetic-test-count=<n>` — held-out test tasks (default `1`)

### `--task-source=real`

Run against explicit bench tasks. Training and held-out test sets can be specified separately.

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=real \
  --tasks=<train-id-or-path,...> \
  --test-tasks=<test-id-or-path,...> \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --target-model=qwen/qwen3-30b-a3b-instruct-2507 \
  --rounds=3
```

Real-specific flags:
- `--tasks=<id|path,...>` — **required.** Train tasks by bench id or `task.json` path, comma-separated.
- `--test-tasks=<id|path,...>` — optional. Held-out test tasks; if omitted, `--tasks` is used as both train and test (fallback for small task lists).

### `--task-source=log` (post-mortem)

Feed pre-existing conversation logs to the optimizer without rerunning anything. Good for triaging real failures from production, CI, or an `skvm-jit` post-task optimization hook.

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=log \
  --logs=path/to/log1.jsonl,path/to/log2.jsonl \
  --failures=path/to/log1-failure.json,path/to/log2-failure.json \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --target-model=qwen/qwen3-30b-a3b-instruct-2507
```

Log-specific flags:
- `--logs=<path,...>` — **required.** Conversation log files, comma-separated.
- `--failures=<path,...>` — optional. Per-log failure JSON files, same order as `--logs`.

Log source does not rerun tasks, so `--rounds`, `--runs-per-task`, `--convergence`, `--baseline`, `--tasks`, `--test-tasks`, and `--synthetic-count` are all forbidden with it. `--target-model` is still required — it's the storage key identifying which model the logs came from.

### Loop controls (synthetic / real)

- `--rounds=<n>` — max optimization rounds (default `3` for synthetic/real, `1` for log)
- `--runs-per-task=<n>` — runs per task per round (default `1`)
- `--convergence=<0-1>` — early-exit threshold on primary score (default `0.95`). Primary score is the test score when a test set exists, else the train score.
- `--baseline` — also run the no-skill and original conditions for comparison

### Delivery

- `--no-keep-all-rounds` — keep only the best round's folder (default keeps all)
- `--auto-apply` — after best-round selection, overwrite the original `--skill` directory, backing up overwritten files inside the proposal

### Batch mode

```bash
skvm jit-optimize \
  --skill-list=skills.txt \
  --task-source=real \
  --tasks=<id-or-path,...> \
  --optimizer-model=<id> \
  --target-model=<id> \
  --concurrency=4
```

`--skill-list` is a file with one skill path per line; `--concurrency` runs jobs in parallel.

## `proposals`

Proposals are the unified storage for JIT-optimize output. See [architecture.md](architecture.md#proposals-tree) for the on-disk layout.

```bash
skvm proposals list
skvm proposals show <id>
skvm proposals accept <id>
skvm proposals accept <id> --round=<n>      # override the engine's recommended bestRound
skvm proposals reject <id>
```

Accepting a proposal deploys the chosen round into the target skill directory and backs up overwritten files as `.bak.<timestamp>`. The bench `jit-optimized` condition always reads `round-{bestRound}/` of the latest proposal for a given `(harness, targetModel, skillName)`.

## `clean-jit`

Removes persisted JIT state (boost candidates + solidification state) for a specific model+adapter pair.

```bash
skvm clean-jit --model=<id> --adapter=<name> --dry-run
skvm clean-jit --model=<id> --adapter=<name> --yes
```

## `logs`

Lists recent runs across subsystems for quick inspection.

```bash
skvm logs
skvm logs --type=bench --limit=10
skvm logs --type=profile
skvm logs --type=aot-compile
```

## Environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_API_KEY` | Agent execution and profiling via OpenRouter |
| `ANTHROPIC_API_KEY` | Compiler backend via the Anthropic API |
| `SKVM_DATA_DIR` | Override the `skvm-data/` input-dataset root |
| `SKVM_CACHE` | Override the runtime-cache root (default `~/.skvm/`) |
| `SKVM_PROFILES_DIR` | Override the cached-TCP directory |
| `SKVM_LOGS_DIR` | Override the runtime-log directory |
| `SKVM_PROPOSALS_DIR` | Override the proposals-tree root |
