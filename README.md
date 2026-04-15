<div align="center">

# SkVM

**Compile and run LLM agent skills across heterogeneous models and harnesses**

[Website](https://skillvm.ai) · [GitHub](https://github.com/SJTU-IPADS/SkVM) · [Paper](https://arxiv.org/abs/2604.03088)

[![npm](https://img.shields.io/npm/v/@ipads-skvm/skvm?color=cb3837&logo=npm)](https://www.npmjs.com/package/@ipads-skvm/skvm)
[![license](https://img.shields.io/github/license/SJTU-IPADS/SkVM)](./LICENSE)
[![release](https://img.shields.io/github/v/release/SJTU-IPADS/SkVM)](https://github.com/SJTU-IPADS/SkVM/releases)
[![last commit](https://img.shields.io/github/last-commit/SJTU-IPADS/SkVM)](https://github.com/SJTU-IPADS/SkVM/commits)

</div>

SkVM is a compilation and runtime system that makes LLM agent skills portable across heterogeneous models and harnesses. It has four major parts:

- **Profiling** — measure a model+harness against pre-defined primitive capabilities
- **AOT-Compilation** — compile a skill with multiple passes in AOT compiler
- **JIT-Optimization** — improve runtime speed (JIT-boost) and skill content (JIT-optimize)
- **Benchmark** — evaluate original, compiled, and optimized skills across tasks, conditions, and models

Reference: **SkVM: Revisiting Language VM for Skills across Heterogenous LLMs and Harnesses** — https://arxiv.org/abs/2604.03088

## Install

```bash
# curl one-liner (macOS / Linux, any arch)
curl -fsSL https://skillvm.ai/install.sh | sh

# or via npm (any platform with Node ≥ 18; postinstall fetches the matching binary)
npm i -g @ipads-skvm/skvm

# then set your API key and self-check
export OPENROUTER_API_KEY=sk-or-...
skvm --help
```

The installer drops a standalone binary at `~/.local/share/skvm/bin/skvm` (symlinked into `~/.local/bin/skvm`) and bundles a private isolated `opencode` copy used by `skvm jit-optimize` — it does not touch any global `opencode` install you may have.

**Agent-facing skills** ship inside the install. Copy them into your agent harness's skills directory to teach it how to drive skvm:

```bash
# Claude Code
cp -r ~/.local/share/skvm/skills/skvm-jit ~/.claude/skills/
cp -r ~/.local/share/skvm/skills/skvm-general ~/.claude/skills/
```

- `skvm-jit` — post-task feedback loop for submitting conversation logs to `skvm jit-optimize`
- `skvm-general` — drives `profile` / `aot-compile` / `bench` / `proposals` on behalf of a user

## Quick Start

Set your API key:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

Every example below passes every flag with a default explicitly, so the command you copy is exactly the command that runs — no implicit behavior to look up. Drop a flag to accept its default; change a value to override.

### 1. Profile a model's primitive capabilities

Writes a target capability profile to `~/.skvm/profiles/`.

```bash
skvm profile \
  --model=qwen/qwen3.5-35b-a3b \
  --adapter=openclaw \
  --instances=3 \
  --concurrency=1
```

Defaults shown: `--adapter=bare-agent` (overridden to `openclaw` above), `--instances=3`, `--concurrency=1`.

### 2. Compile a skill against that profile

The compiler rewrites the skill to match the target's capabilities.

```bash
skvm aot-compile \
  --skill=path/to/skill-dir \
  --model=qwen/qwen3.5-35b-a3b \
  --adapter=bare-agent \
  --pass=1,2,3 \
  --concurrency=1 \
  --compiler-model=anthropic/claude-sonnet-4.6
```

Defaults shown: `--adapter=bare-agent`, `--pass=1,2,3`, `--concurrency=1`, `--compiler-model=anthropic/claude-sonnet-4.6`.

### 3. Autotune the skill with synthetic tasks

The optimizer LLM derives tasks from the skill itself, then loops edit → rerun → score.

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=synthetic \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --target-model=qwen/qwen3.5-35b-a3b \
  --target-adapter=bare-agent \
  --synthetic-count=3 \
  --synthetic-test-count=2 \
  --rounds=3 \
  --runs-per-task=2 \
  --task-concurrency=1 \
  --convergence=0.95
```

Defaults shown: `--target-adapter=bare-agent`, `--synthetic-count=3`, `--synthetic-test-count=2`, `--rounds=3`, `--runs-per-task=2`, `--task-concurrency=1`, `--convergence=0.95`.

### 4. Optimize from an existing conversation log

No rerun, just diagnose and edit. Good for post-mortems and for the `skvm-jit` post-task feedback hook.

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=log \
  --logs=path/to/session.jsonl \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --target-model=qwen/qwen3.5-35b-a3b \
  --target-adapter=bare-agent \
  --rounds=1
```

Defaults shown: `--target-adapter=bare-agent`, `--rounds=1` (log mode defaults to 1 round; `--runs-per-task`, `--convergence`, `--baseline` are forbidden for log).

### Review, accept, or reject the proposal

```bash
skvm proposals list --sort=recent
skvm proposals show <id>
skvm proposals accept <id>
```

Defaults shown: `--sort=recent` (other sort keys: `delta`, `skill`, `model`).

## Configuration

SkVM keeps all runtime artifacts — cached profiles, proposal trees, bench and compile logs — under a single cache root:

```
~/.skvm/
├── profiles/   # Cached target capability profiles
├── log/        # Profile, compile, bench, and runtime logs
└── proposals/  # AOT-compile, jit-boost, jit-optimize outputs
```

The cache is user-global and shared across every directory you invoke `skvm` from, so profiles cached in one project are reused everywhere. Override the location via:

- `--skvm-cache=<path>` flag (one-off)
- `SKVM_CACHE` env var (persistent), e.g. `export SKVM_CACHE=/mnt/fast/skvm`

Individual subdirectories can also be pointed elsewhere with `SKVM_PROFILES_DIR`, `SKVM_LOGS_DIR`, and `SKVM_PROPOSALS_DIR`.

## Learn more

- **[docs/usage.md](docs/usage.md)** — full command reference: `profile`, `aot-compile`, `run`, `bench`, `jit-optimize`, `proposals`, and more
- **[docs/architecture.md](docs/architecture.md)** — subsystem map, data flow, and on-disk layout
- **[docs/grade-protocols.md](docs/grade-protocols.md)** — grader protocol reference for custom `grade.py` task graders
- **Paper**: https://arxiv.org/abs/2604.03088

## Citation

If you use SkVM in your research, please cite:

```bibtex
@article{chen2026skvm,
  title={SkVM: Revisiting Language VM for Skills across Heterogenous LLMs and Harnesses},
  author={Chen, Le and Feng, Erhu and Xia, Yubin and Chen, Haibo},
  journal={arXiv preprint arXiv:2604.03088},
  year={2026}
}
```
