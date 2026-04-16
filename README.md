<div align="center">

# SkVM

**Compile and run LLM agent skills across heterogeneous models and harnesses**

[English](./README.md) | [中文](./README.zh-CN.md)

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

<p align="center">
  <img src="./docs/skvm_arch.png" alt="SkVM architecture" width="66%" />
</p>

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
# OpenClaw
cp -r ~/.local/share/skvm/skills/skvm-jit ~/.openclaw/workspace/skills/
cp -r ~/.local/share/skvm/skills/skvm-general ~/.openclaw/workspace/skills/

# Hermes Agent
cp -r ~/.local/share/skvm/skills/skvm-jit ~/.hermes/skills/
cp -r ~/.local/share/skvm/skills/skvm-general ~/.hermes/skills/
```

- `skvm-jit` — post-task JIT optimization skill for submitting conversation logs to `skvm jit-optimize`
- `skvm-general` — drives `profile` / `aot-compile` / `bench` / `proposals` on behalf of a user

<!-- ### Quick OpenClaw Integration

If you want OpenClaw to bootstrap SkVM for itself, you can give OpenClaw the following instruction block. It tells OpenClaw to install SkVM with the official installer, download `skvm-general` and `skvm-jit` from their concrete SkillVM URLs, and place them into OpenClaw's global skills directory at `~/.openclaw/workspace/skills/`.

```text
Install SkVM for this machine with the official installer:
curl -fsSL https://skillvm.ai/install.sh | sh

Then install the two OpenClaw skills with these commands:
mkdir -p ~/.openclaw/workspace/skills

mkdir -p ~/.openclaw/workspace/skills/skvm-general
curl -fsSL https://skillvm.ai/skills/skvm-general/SKILL.md -o ~/.openclaw/workspace/skills/skvm-general/SKILL.md

mkdir -p ~/.openclaw/workspace/skills/skvm-jit
curl -fsSL https://skillvm.ai/skills/skvm-jit/SKILL.md -o ~/.openclaw/workspace/skills/skvm-jit/SKILL.md
curl -fsSL https://skillvm.ai/skills/skvm-jit/adapter-skill-paths.md -o ~/.openclaw/workspace/skills/skvm-jit/adapter-skill-paths.md

This should create:
~/.openclaw/workspace/skills/skvm-general/SKILL.md
~/.openclaw/workspace/skills/skvm-jit/SKILL.md
~/.openclaw/workspace/skills/skvm-jit/adapter-skill-paths.md
```

**After installation, when executing any task that uses a skill, append this instruction to the task: "If this task uses a skill, use SkVM to optimize that skill during or after execution."**

This is the quickest way to make an OpenClaw environment self-host the SkVM toolchain and the two integration skills without requiring a separate manual setup flow. -->

## Quick Start

Set your API key:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

If you use another provider, see [docs/providers.md](docs/providers.md).

### 1. Profile a model's primitive capabilities

Writes a target capability profile to `~/.skvm/profiles/`.

```bash
skvm profile \
  --model=qwen/qwen3.5-35b-a3b \
  --adapter=bare-agent
```

With the default `--concurrency=1`, this example typically takes about 20 minutes for one full run. If you want it to finish faster, increase `--concurrency` to profile more primitives in parallel.

### 2. Compile a skill against that profile

The compiler rewrites the skill to match the target's capabilities. A cached profile for the same `--model` + `--adapter` pair must exist (run `skvm profile` first, or use `skvm pipeline` which profiles automatically).

```bash
skvm aot-compile \
  --skill=path/to/skill-dir \
  --model=qwen/qwen3.5-35b-a3b \
  --adapter=bare-agent \
  --pass=1 \
  --compiler-model=anthropic/claude-sonnet-4.6
```

Compiled variants are written under `~/.skvm/proposals/aot-compile/<adapter>/<safeModel>/<skillName>/<passTag>/` by default. 

### 3. Autotune the skill with synthetic tasks

The optimizer LLM derives tasks from the skill itself, then loops edit → rerun → score.

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=synthetic \
  --target-adapter=bare-agent \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --rounds=2 \
  --target-model=qwen/qwen3.5-35b-a3b
```

Results are written under `~/.skvm/proposals/jit-optimize/<adapter>/<safeTargetModel>/<skillName>/<timestamp>/` by default. 

### 4. Optimize from an existing conversation log

No rerun, just diagnose and edit. Good for post-mortems and for the `skvm-jit` post-task optimization hook.

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=log \
  --target-adapter=bare-agent \
  --logs=path/to/session.jsonl \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --target-model=qwen/qwen3.5-35b-a3b
```

### Review, accept, or reject the proposal

```bash
skvm proposals list        # CLI listing
skvm proposals show <id>   # CLI detail view
skvm proposals accept <id> # CLI accept
skvm proposals serve       # Web review UI
```

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

## Dataset: skvm-data

The benchmark skills, tasks, and pre-built profiles live in a separate Git submodule ([SJTU-IPADS/SkVM-data](https://github.com/SJTU-IPADS/SkVM-data)). Clone it if you plan to run `skvm bench` and want to use the bundled skills/tasks directly:

```bash
git submodule update --init   # or: git clone --recurse-submodules
```

This populates the `skvm-data/` directory:

```
skvm-data/
├── skills/     # 108 skill directories (each contains a SKILL.md)
├── tasks/      # 216 task directories (each contains a task.json)
└── profiles/   # Pre-built target capability profiles
    ├── bare-agent/
    └── openclaw/
```

`skvm bench` resolves skills and tasks from `skvm-data/` by default. Override the location via:

- `--skvm-data-dir=<path>` flag (one-off)
- `SKVM_DATA_DIR` env var (persistent)

Commands that take an explicit `--skill=<path>` or `--task=<path>` do not need the submodule — they work with any directory on disk.

If you want to use the pre-built profiles from `skvm-data/`, copy `skvm-data/profiles/` into your profile cache directory (default: `~/.skvm/profiles/`, or `SKVM_PROFILES_DIR` if set).

```bash
mkdir -p ~/.skvm/profiles
cp -R skvm-data/profiles/. ~/.skvm/profiles/
```

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
