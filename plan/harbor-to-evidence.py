#!/usr/bin/env python3
"""Convert a Harbor job directory into SkVM execution-log evidence.

Produces two files for `skvm jit-optimize --task-source=log`:
  <out>.log         — Simple JSON report ({task, outcome, issues, skill_feedback})
  <out>-failures.json — EvidenceCriterion[] (optional, used via --failures)

Usage:
  python harbor-to-evidence.py <harbor_job_dir> <out_basename>

Harbor job dir layout (we read):
  <job>/<trial>/verifier/reward.txt          -> outcome (0=fail,1=pass)
  <job>/<trial>/verifier/test-stdout.txt     -> issues (pytest failure summary)
  <job>/<trial>/agent/*.pane                 -> skill_feedback (agent terminal trace)
  <repo>/tasks/<task>/instruction.md         -> task prompt
"""
import json
import os
import re
import sys


def find_trial(job_dir):
    """Find the trial subdir (named <task>__<rand>)."""
    for name in os.listdir(job_dir):
        full = os.path.join(job_dir, name)
        if os.path.isdir(full) and "__" in name or os.path.isdir(full):
            # trial dir contains verifier/ or agent/
            if os.path.isdir(os.path.join(full, "verifier")) or os.path.isdir(os.path.join(full, "agent")):
                return full
    return None


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def strip_ansi(s):
    return re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", s)


def extract_issues(test_stdout):
    """Pull concise failure lines from pytest output."""
    lines = test_stdout.splitlines()
    issues = []
    for ln in lines:
        if ln.startswith("FAILED") or ln.startswith("E   ") or "AssertionError" in ln:
            issues.append(strip_ansi(ln).strip()[:200])
    # de-dup, keep order
    seen = set()
    out = []
    for i in issues:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out[:8] if out else ["(no specific failure lines parsed; reward=0)"]


def extract_skill_feedback(pane_text):
    """Summarize what the agent actually did from its terminal trace."""
    pane_text = strip_ansi(pane_text)
    lines = [l.strip() for l in pane_text.splitlines() if l.strip()]
    # Heuristic: capture command lines the agent ran + last ~15 meaningful lines
    cmds = [l for l in lines if l.startswith(("python", "cat ", "echo ", "printf ", "ls", "grep", "sed", "awk", "head", "tail", "vim", "tee", "tesseract"))]
    cmd_summary = "\n".join(f"  $ {c[:150]}" for c in cmds[:20])
    tail = "\n".join(lines[-15:])
    return f"Agent terminal trace (commands run + tail):\n{cmd_summary}\n\nLast 15 lines:\n{tail}"


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    job_dir = sys.argv[1]
    out_base = sys.argv[2]

    trial = find_trial(job_dir)
    if not trial:
        print(f"ERROR: no trial dir in {job_dir}", file=sys.stderr)
        sys.exit(1)

    # reward
    reward_txt = read(os.path.join(trial, "verifier", "reward.txt")).strip()
    reward = int(reward_txt) if reward_txt.isdigit() else 0
    outcome = "pass" if reward == 1 else "fail"

    # issues from pytest stdout
    test_stdout = read(os.path.join(trial, "verifier", "test-stdout.txt"))
    issues = extract_issues(test_stdout) if reward == 0 else []

    # skill feedback from agent pane
    pane = ""
    agent_dir = os.path.join(trial, "agent")
    if os.path.isdir(agent_dir):
        for f in os.listdir(agent_dir):
            if f.endswith(".pane"):
                pane = read(os.path.join(agent_dir, f))
                break
    skill_feedback = extract_skill_feedback(pane) if pane else "(no agent pane found)"

    # task prompt: derive task name from job dir, read instruction.md
    job_name = os.path.basename(job_dir.rstrip("/\\"))
    task_name = job_name.split("__")[0]
    # try a few repo roots
    instruction = ""
    for repo in ("D:/terminal-bench-2-1", "/d/terminal-bench-2-1"):
        p = os.path.join(repo, "tasks", task_name, "instruction.md")
        if os.path.isfile(p):
            instruction = read(p)
            break
    if not instruction:
        instruction = f"(task: {task_name})"

    # Write .log (Simple JSON report)
    report = {
        "task": instruction.strip(),
        "outcome": outcome,
        "issues": issues,
        "skill_feedback": skill_feedback,
    }
    log_path = out_base + ".log"
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"wrote {log_path}  (outcome={outcome}, {len(issues)} issues)")

    # Write -failures.json (EvidenceCriterion[]) when failed
    if reward == 0:
        criteria = [{
            "id": "harbor-reward",
            "name": "harbor verifier reward",
            "method": "custom",
            "weight": 1.0,
            "score": 0.0,
            "passed": False,
            "details": "; ".join(issues)[:500],
        }]
        fail_path = out_base + "-failures.json"
        with open(fail_path, "w", encoding="utf-8") as f:
            json.dump(criteria, f, ensure_ascii=False, indent=2)
        print(f"wrote {fail_path}")


if __name__ == "__main__":
    main()
