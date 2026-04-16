---
name: skvm-jit
description: Submit task feedback to `skvm jit-optimize` so the skill author receives a reviewable proposal. Trigger after finishing a task that was driven by any skill (not just SkVM-compiled ones) when the outcome was a failure, was partial, or the skill's instructions clearly caused confusion or an unnecessary detour. Successful runs do not need feedback. For general skvm usage (profile/aot-compile/bench/proposals), use the sibling `skvm-general` skill instead.
---

# SkVM JIT Optimize Feedback

When you finish a task that was driven by a skill, and the skill's own instructions appear to have caused problems, write a short structured report and submit it to `skvm jit-optimize`. The optimizer reads your report, proposes improvements to the skill's files, and stores them as a **proposal** that the skill author can review with `skvm proposals show <id>`.

This works for **any** skill the host harness can load — it does not need to have been produced by SkVM's compiler. `jit-optimize` only needs the skill folder on disk; it does not require SkVM-specific artifacts.

## When to trigger

Run this skill **only** when both of the following hold:

1. The task you just completed was driven by a skill that the harness loaded from disk (not an ad-hoc user instruction).
2. At least one of the following is true:
   - the task **failed** or ended **partial**, and a clearer skill would plausibly have avoided it
   - you observed a concrete problem in the skill's instructions: ambiguity, a missing step, an incorrect claim, a confusing ordering, or an unnecessary detour the skill forced you into

Do **not** run this skill when:

- the task succeeded and the skill read cleanly — silent passes are fine, the optimizer does not need "nothing to report" submissions
- the failure was purely user-side (typo in the prompt, missing credentials, network failure) and no change to the skill would have helped
- the task did not use a skill at all, or used only a trivial one-shot instruction
- you are running inside `skvm bench` or any other SkVM-orchestrated flow — the bench owns its own feedback loop, do not double-submit

## Step 1: Locate the skill directory

The skill directory contains a `SKILL.md` file. You need the absolute path to pass as `--skill=<dir>` in Step 3.

Each agent harness installs skills in well-known locations. Read `adapter-skill-paths.md` (sibling file in this skill's directory) and look up the section matching the harness you are currently running inside — it lists the search order for Claude Code, opencode, openclaw, hermes, jiuwenclaw, and bare-agent. Probe the listed paths in order and pick the first one that contains a `SKILL.md` for the skill name you are looking for.

If none of the listed paths contains the skill, or the reference file marks your harness as "confirm with user", ask the user for the path — do not guess.

## Step 2: Write a report

Pick **one** of the two formats below. Save it anywhere (e.g. a temp file); you'll pass its path as `--logs=<path>` in Step 3.

### Format A — Simple report (preferred for one-off observations)

Save as `report.json`:

```json
{
  "task": "<what the user asked, one or two sentences>",
  "outcome": "pass" | "fail" | "partial",
  "issues": [
    "short description of each problem you hit",
    "another problem"
  ],
  "skill_feedback": "concrete suggestion for how the SKILL.md could be clearer or more correct"
}
```

Keep `issues` focused on things the **skill's instructions** could prevent or clarify. Do not include issues that were purely user-side (typos in the prompt, missing credentials, network failures).

When `outcome` is `fail` or `partial`, the optimizer treats the issues and skill_feedback as failure reasons attached to a synthetic "agent-reported" criterion. When `outcome` is `pass`, the report still enters the optimizer but with no failures, letting it notice what worked well.

### Format B — Conversation log (preferred when the full turn-by-turn trace is informative)

Save as `conv-log.jsonl`, one JSON object per line:

```jsonl
{"type":"request","ts":"<iso8601>","text":"<user prompt>"}
{"type":"response","ts":"<iso8601>","text":"<your reply or summary of the step>"}
{"type":"tool","ts":"<iso8601>","text":"<tool call summary>","toolCalls":[...]}
```

Only include entries that matter for diagnosing the skill's quality. Redact secrets.

## Step 3: Submit to jit-optimize

```bash
skvm jit-optimize \
  --skill=<skill-directory> \
  --task-source=log \
  --logs=<path-to-report.json-or-conv-log.jsonl> \
  --target-model=<id-the-task-ran-on> \
  --optimizer-model=z-ai/glm-5.1
```

Required parameters:

- `--skill` — path to the skill directory (the one containing `SKILL.md`)
- `--task-source=log` — tells jit-optimize to analyze a conversation log without rerunning anything. **This is the only task source valid from a feedback submission** — `real` and `synthetic` sources rerun tasks against a live model, which a post-hoc report cannot do.
- `--logs` — path to the report file you wrote in Step 2
- `--target-model=<id>` — **required for every `skvm jit-optimize` invocation, including `--task-source=log`**. In log mode the target model is not used for execution — it is the *storage key* that decides which folder under `proposals/<harness>/<target-model>/<skill>/` the proposal lands in, so proposals stay grouped by the model the skill is tuned for. Use the OpenRouter-format id of the model that just ran the task — **that is you**, the agent reading this skill. Read your own model id out of your system prompt / harness environment (Claude Code exposes it as the "exact model ID", e.g. map `claude-opus-4-6` → `anthropic/claude-opus-4-6`; opencode/openclaw/hermes similarly). If you genuinely cannot determine your own model id, ask the user once and stop — do not substitute a placeholder.
- `--optimizer-model=<id>` — the LLM that drives the optimizer agent. Use any OpenRouter-compatible model; `z-ai/glm-5.1` is a good cheap default.

Optional:

- `--target-adapter=<name>` — purely informational in log mode (default: `bare-agent`). Set it if the log came from a non-default adapter (e.g., openClaw, Hermes, jiuwenclaw) so the proposal is filed under the right harness folder.
- `--failures=<path,...>` — structured failure-reasons JSON, one path per corresponding entry in `--logs`. Pass only when you already have a cleaner per-criterion breakdown than the report file itself; the count must match `--logs`. Skip it for single-report cases.

**What NOT to pass in log mode** (the CLI will error if you do):

- `--tasks`, `--test-tasks` — these belong to `--task-source=real`
- `--synthetic-count`, `--synthetic-test-count` — these belong to `--task-source=synthetic`
- `--runs-per-task`, `--convergence`, `--baseline` — the log mode does not rerun the task, so there is no loop to configure

The command runs synchronously (seconds to a minute). Stdout ends with a block like:

```
Proposal: <harness>/<safeTargetModel>/<skill>/<timestamp>
Proposal dir: <absolute-path>
Best round: <N> — <reason>
Rounds: <count>
```

**Capture the id from the line starting with `Proposal: ` only** — everything after `Proposal: ` up to the newline is the id. Do not parse `Proposal dir:`, `Best round:`, or `Rounds:`. Note the middle segment is `safeTargetModel` (derived from `--target-model`), not the optimizer model.

If you want fire-and-forget, wrap the invocation in `(skvm jit-optimize ... &)` in your shell. There is no built-in `--async` flag.

## Step 4: Tell the user

Print one line with the proposal id you captured:

> Submitted feedback to skvm jit-optimize for `<skill>`. Review with `skvm proposals show <id>`; accept with `skvm proposals accept <id>`.

Do **not** attempt to accept or deploy the proposal yourself — only the skill author should decide whether to deploy it. If the user explicitly asks you to deploy, run `skvm proposals accept <id>` and report the deployed file list.

## Rules

- Never include sensitive data (API keys, private file contents) in the report.
- Never edit the skill directory directly. Proposals are stored under `$SKVM_PROPOSALS_DIR` (default `~/.skvm/proposals/`); only `skvm proposals accept` writes back into the skill.
- If `skvm` is not on PATH, report it to the user and stop — do not install anything. If `skvm jit-optimize` fails with "opencode not found", tell the user to re-run the skvm installer (`curl -fsSL https://skillvm.ai/install.sh | sh` or `npm i -g @ipads-skvm/skvm`) rather than installing opencode yourself. skvm bundles its own private opencode copy and manages it through the installer.
- One report per task. Don't batch multiple unrelated tasks into a single report.
- `OPENROUTER_API_KEY` must be set in the environment for the optimizer to run. If it is missing, `skvm jit-optimize` will fail; tell the user and stop.

## Reference: what happens on the skvm side

The optimizer agent spawned by `skvm jit-optimize` reads your report, inspects the skill folder, diagnoses a root cause, and edits files in a temp workspace (SKILL.md and/or bundle files). The edited folder is snapshotted as `round-1/` inside the proposal. `round-0/` is a copy of the original skill. The user can later diff the two with `skvm proposals show <id>` or reject the proposal if the root cause looks wrong. Proposals are keyed by `(harness, target-model, skill-name)`, which is why `--target-model` is required even in log mode.
