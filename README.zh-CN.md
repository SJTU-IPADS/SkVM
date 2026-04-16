<div align="center">

# SkVM

**跨异构模型与 Harness 的 LLM Agent Skill 编译和运行系统**

[English](./README.md) | [中文](./README.zh-CN.md)

[官网](https://skillvm.ai) · [GitHub](https://github.com/SJTU-IPADS/SkVM) · [论文](https://arxiv.org/abs/2604.03088)

[![npm](https://img.shields.io/npm/v/@ipads-skvm/skvm?color=cb3837&logo=npm)](https://www.npmjs.com/package/@ipads-skvm/skvm)
[![license](https://img.shields.io/github/license/SJTU-IPADS/SkVM)](./LICENSE)
[![release](https://img.shields.io/github/v/release/SJTU-IPADS/SkVM)](https://github.com/SJTU-IPADS/SkVM/releases)
[![last commit](https://img.shields.io/github/last-commit/SJTU-IPADS/SkVM)](https://github.com/SJTU-IPADS/SkVM/commits)

</div>

SkVM 是一个面向 LLM Agent Skill 的编译与运行时系统，用来让 Skill 能在不同模型和 Harness 之间迁移与复用。它主要包含四个部分：

- **Profiling** — 评测某个模型 + Harness 组合在一组预定义原语能力上的表现
- **AOT 编译** — 通过多阶段 AOT 编译器对 Skill 进行编译
- **JIT 优化** — 同时优化运行效率（JIT-boost）和 Skill 内容质量（JIT-optimize）
- **基准测试** — 在不同任务、条件和模型下评估原始、编译后和优化后的 Skill

<p align="center">
  <img src="./docs/skvm_arch_zh.png" alt="SkVM 架构图" width="66%" />
</p>

参考论文：**SkVM: Revisiting Language VM for Skills across Heterogenous LLMs and Harnesses** — https://arxiv.org/abs/2604.03088

## 安装

```bash
# 一键安装（macOS / Linux，任意架构）
curl -fsSL https://skillvm.ai/install.sh | sh

# 或通过 npm（任意支持 Node >= 18 的平台；postinstall 会自动拉取对应平台的二进制）
npm i -g @ipads-skvm/skvm

# 然后设置 API Key 并验证
export OPENROUTER_API_KEY=sk-or-...
skvm --help
```

安装器会将独立二进制放在 `~/.local/share/skvm/bin/skvm`（并链接到 `~/.local/bin/skvm`），同时附带一份隔离的 `opencode` 副本，供 `skvm jit-optimize` 使用，不会影响你系统里已有的全局 `opencode`。

**面向 Agent 的 Skill** 会随安装包一起提供。把它们复制到对应 Agent Harness 的 skills 目录后，Agent 就能学会如何驱动 skvm：

```bash
# OpenClaw
cp -r ~/.local/share/skvm/skills/skvm-jit ~/.openclaw/workspace/skills/
cp -r ~/.local/share/skvm/skills/skvm-general ~/.openclaw/workspace/skills/

# Hermes Agent
cp -r ~/.local/share/skvm/skills/skvm-jit ~/.hermes/skills/
cp -r ~/.local/share/skvm/skills/skvm-general ~/.hermes/skills/
```

- `skvm-jit` — 任务结束后收集对话日志，并提交给 `skvm jit-optimize`
- `skvm-general` — 帮助用户驱动 `profile` / `aot-compile` / `bench` / `proposals`

<!-- ### 使用 OpenClaw 快速下载 SkVM 并集成

如果你希望让 OpenClaw 自己完成 SkVM 的引导安装，可以把下面这段指令直接交给 OpenClaw。它会让 OpenClaw 使用官方安装脚本安装 SkVM，再从 SkillVM 的具体链接下载 `skvm-general` 和 `skvm-jit`，并把它们放到 OpenClaw 的全局 skills 目录 `~/.openclaw/workspace/skills/` 下。

```text
请先使用官方安装脚本为这台机器安装 SkVM：
curl -fsSL https://skillvm.ai/install.sh | sh

然后用下面这些命令安装两个 OpenClaw skill：
mkdir -p ~/.openclaw/workspace/skills

mkdir -p ~/.openclaw/workspace/skills/skvm-general
curl -fsSL https://skillvm.ai/skills/skvm-general/SKILL.md -o ~/.openclaw/workspace/skills/skvm-general/SKILL.md

mkdir -p ~/.openclaw/workspace/skills/skvm-jit
curl -fsSL https://skillvm.ai/skills/skvm-jit/SKILL.md -o ~/.openclaw/workspace/skills/skvm-jit/SKILL.md
curl -fsSL https://skillvm.ai/skills/skvm-jit/adapter-skill-paths.md -o ~/.openclaw/workspace/skills/skvm-jit/adapter-skill-paths.md

安装完成后，目录中应该有：
~/.openclaw/workspace/skills/skvm-general/SKILL.md
~/.openclaw/workspace/skills/skvm-jit/SKILL.md
~/.openclaw/workspace/skills/skvm-jit/adapter-skill-paths.md
```

**安装完成后，以后在 OpenClaw 下发任何会使用 skill 的任务时，请在任务说明里追加一句：“如果执行任务的时候使用了 skill，那么使用 SkVM 对 skill 进行优化。”**

这是让 OpenClaw 环境一次性具备 SkVM 工具链和这两个集成 skill 的最快方式，不需要额外走一套单独的手工安装流程。 -->

## 快速开始

先配置 API Key：

```bash
export OPENROUTER_API_KEY=sk-or-...
```

如果你使用其他 provider，可以参考 [docs/providers.md](docs/providers.md)。

### 1. 评测模型的原语能力

运行后会在 `~/.skvm/profiles/` 下生成对应的能力 Profile。

```bash
skvm profile \
  --model=qwen/qwen3.5-35b-a3b \
  --adapter=bare-agent
```

在默认 `--concurrency=1` 的情况下，这个示例完整运行一次通常约需 20 分钟。如果你希望更快完成，可以调大 `--concurrency`，让更多原语能力评测并行执行。

### 2. 基于 Profile 编译 Skill

编译器会根据目标模型的能力改写 Skill。你需要先准备好同一组 `--model` + `--adapter` 对应的缓存 Profile（先运行 `skvm profile`，或者直接使用会自动完成 profiling 的 `skvm pipeline`）。

```bash
skvm aot-compile \
  --skill=path/to/skill-dir \
  --model=qwen/qwen3.5-35b-a3b \
  --adapter=bare-agent \
  --pass=1 \
  --compiler-model=anthropic/claude-sonnet-4.6
```

编译产物默认会写入：

`~/.skvm/proposals/aot-compile/<adapter>/<safeModel>/<skillName>/<passTag>/`

### 3. 用合成任务自动调优 Skill

优化器会从 Skill 本身生成任务，然后反复执行“修改 → 重跑 → 评分”的循环。

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=synthetic \
  --target-adapter=bare-agent \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --rounds=2 \
  --target-model=qwen/qwen3.5-35b-a3b
```

生成的 proposal 默认会写入：

`~/.skvm/proposals/jit-optimize/<adapter>/<safeTargetModel>/<skillName>/<timestamp>/`

### 4. 基于已有对话日志进行优化

这种模式不会重跑任务，而是直接基于已有日志做诊断和修改。适合做事后分析，也适合配合 `skvm-jit` 的任务后反馈流程使用。

```bash
skvm jit-optimize \
  --skill=path/to/skill-dir \
  --task-source=log \
  --target-adapter=bare-agent \
  --logs=path/to/session.jsonl \
  --optimizer-model=anthropic/claude-sonnet-4.6 \
  --target-model=qwen/qwen3.5-35b-a3b
```

### 查看、接受或拒绝 Proposal

```bash
skvm proposals list        # CLI：列出 proposal
skvm proposals show <id>   # CLI：查看 proposal 详情
skvm proposals accept <id> # CLI：接受 proposal
skvm proposals serve       # Web：打开本地审阅界面
```

## 配置

SkVM 会把所有运行时产物统一放在同一个缓存根目录下，包括缓存的 Profile、Proposal 树，以及 bench 和 compile 日志：

```
~/.skvm/
├── profiles/   # 缓存的目标能力 Profile
├── log/        # Profile、compile、bench 和运行时日志
└── proposals/  # AOT-compile、jit-boost、jit-optimize 产物
```

这个缓存目录是用户级共享的。无论你在什么目录下运行 `skvm`，都会共用同一份缓存；因此，在一个项目中生成的 Profile，也可以在其他项目中复用。

你可以通过以下方式覆盖缓存位置：

- `--skvm-cache=<path>` 参数（单次生效）
- `SKVM_CACHE` 环境变量（长期生效），例如：`export SKVM_CACHE=/mnt/fast/skvm`

此外，也可以分别通过 `SKVM_PROFILES_DIR`、`SKVM_LOGS_DIR`、`SKVM_PROPOSALS_DIR` 单独指定子目录位置。

## 数据集：skvm-data

基准测试使用的 Skill、Task 和预构建 Profile 存放在一个独立的 Git 子模块中：[SJTU-IPADS/SkVM-data](https://github.com/SJTU-IPADS/SkVM-data)。

如果你计划运行 `skvm bench`，或者想直接使用内置的 Skill / Task，请先拉取这个子模块：

```bash
git submodule update --init   # 或：git clone --recurse-submodules
```

执行后会得到 `skvm-data/` 目录：

```
skvm-data/
├── skills/     # 108 个 Skill 目录（每个目录都包含一个 SKILL.md）
├── tasks/      # 216 个 Task 目录（每个目录都包含一个 task.json）
└── profiles/   # 预构建的目标能力 Profile
    ├── bare-agent/
    └── openclaw/
```

`skvm bench` 默认会从 `skvm-data/` 中解析 Skill 和 Task。你也可以通过下面的方式覆盖它的位置：

- `--skvm-data-dir=<path>` 参数（单次生效）
- `SKVM_DATA_DIR` 环境变量（长期生效）

对于显式传入 `--skill=<path>` 或 `--task=<path>` 的命令，则不依赖这个子模块，可以直接使用磁盘上的任意目录。

如果你想使用 `skvm-data/` 里预构建的 Profile，需要先把它们复制到本地 Profile 缓存目录中（默认是 `~/.skvm/profiles/`，也可以通过 `SKVM_PROFILES_DIR` 指定）：

```bash
mkdir -p ~/.skvm/profiles
cp -R skvm-data/profiles/. ~/.skvm/profiles/
```

## 更多文档

- **[docs/usage.md](docs/usage.md)** — 完整命令参考，包括 `profile`、`aot-compile`、`run`、`bench`、`jit-optimize`、`proposals` 等
- **[docs/architecture.md](docs/architecture.md)** — 子系统结构图、数据流和磁盘布局
- **[docs/grade-protocols.md](docs/grade-protocols.md)** — 自定义 `grade.py` 任务评分器的协议说明
- **论文**：https://arxiv.org/abs/2604.03088

## 引用

如果你在研究中使用了 SkVM，请引用：

```bibtex
@article{chen2026skvm,
  title={SkVM: Revisiting Language VM for Skills across Heterogenous LLMs and Harnesses},
  author={Chen, Le and Feng, Erhu and Xia, Yubin and Chen, Haibo},
  journal={arXiv preprint arXiv:2604.03088},
  year={2026}
}
```
