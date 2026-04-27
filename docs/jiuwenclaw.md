# jiuwenclaw Adapter

SkVM's `jiuwenclaw` adapter wraps [jiuwenclaw](https://github.com/openJiuwen-ai/jiuwenclaw) by launching `python -m jiuwenclaw.app` as a sidecar and driving it over ACP (Agent Client Protocol) JSON-RPC on `127.0.0.1:19001`.

## Prerequisites

- Python **3.11+** (jiuwenclaw's `pyproject.toml` pins `>=3.11,<3.14`).
- A jiuwenclaw source checkout — the adapter runs it from source, not from a pip install.
- `OPENROUTER_API_KEY` (or whichever provider env var matches your `--model=`'s `providers.routes` entry) in your environment. The adapter writes a deterministic `.env` at sidecar boot time that pins the resolved API base / key / model name on the AgentServer side.
- A jiuwenclaw build that supports `params.workspace_dir` on `session/prompt` and emits `chat.usage_metadata` stream events. Sanity-check with:
  ```bash
  python -m jiuwenclaw.app_cli acp --help | grep workspace-dir
  ```

## Install jiuwenclaw

Clone jiuwenclaw anywhere on disk and create a Python 3.11+ virtual environment. The examples below use `$JIUWENCLAW_DIR` as a stand-in for whichever directory you pick.

```bash
export JIUWENCLAW_DIR=/path/to/jiuwenclaw   # pick any directory
git clone https://github.com/openJiuwen-ai/jiuwenclaw.git "$JIUWENCLAW_DIR"
cd "$JIUWENCLAW_DIR"
uv venv --python 3.12
uv sync
```

Verify the install resolves imports and exposes the workspace flag:

```bash
"$JIUWENCLAW_DIR/.venv/bin/python" -c "import jiuwenclaw.app_cli; import jiuwenclaw.app"
"$JIUWENCLAW_DIR/.venv/bin/python" -m jiuwenclaw.app_cli acp --help | grep workspace-dir
```

## Configure SkVM

Point `skvm.config.json` at your checkout (absolute or `~/`-prefixed paths both work):

```json
{
  "adapters": {
    "jiuwenclaw": "/path/to/jiuwenclaw"
  }
}
```

With `adapters.jiuwenclaw` set, `src/adapters/jiuwenclaw.ts` resolves the CLI as `python3 -m jiuwenclaw.app_cli` (and spawns the sidecar the same way). It does **not** look up `jiuwenclaw-cli` on `PATH`.

The adapter hardcodes `python3` (no venv-aware resolution yet), so **activate the venv before invoking skvm**:

```bash
source "$JIUWENCLAW_DIR/.venv/bin/activate"
which python3   # → $JIUWENCLAW_DIR/.venv/bin/python3

bun run skvm run \
  --task=skvm-data/tasks/file-operations_task_01/task.json \
  --adapter=jiuwenclaw \
  --adapter-config=managed \
  --model=deepseek/deepseek-chat
```

`--adapter-config=managed` is required (or `defaults.adapterConfigMode=managed` in `skvm.config.json`); jiuwenclaw rejects native mode because its `set_user_home()` Python API only scopes config for the in-process side, not for the spawned `app_agentserver` + `app_gateway` children.

## How setup/teardown works

On each adapter `setup()` the SkVM driver acquires a cross-process file lock at `~/.jiuwenclaw/jiuwenclaw.sidecar.lock` — port 19001 and `~/.jiuwenclaw/config/.env` are both user-global singletons, so at most one sidecar may live at a time across all skvm processes on the host.

It then:

1. Backs up any existing `~/.jiuwenclaw/config/.env` to `.env.skvm-backup`.
2. Overwrites `.env` with a deterministic minimal file (`API_BASE`, `API_KEY`, `MODEL_NAME`, `MODEL_PROVIDER`, `BROWSER_RUNTIME_MCP_ENABLED=0`) — this is why **bench results are reproducible across machines** regardless of what local tool credentials (`SERPER_API_KEY`, `VISION_*`, etc.) you have configured.
3. Spawns `python3 -m jiuwenclaw.app` and waits up to 60s for the gateway port to accept connections.

On teardown the backup is restored and the sidecar process is killed. If a previous run crashed hard and left a stale `.env.skvm-backup`, the new run treats that backup as the true original — user credentials are never silently lost.

`setup()` and `teardown()` are reference-counted on the adapter side: the bench / jit-optimize stack calls both at the orchestrator level *and* inside `runTask`, and reentrant invocations no-op while the outermost setup is still active. This is invisible to non-jiuwenclaw adapters whose setup is cheap to repeat; for jiuwenclaw it prevents the inner setup from deadlocking on the host-wide sidecar lock the orchestrator already owns.

## Per-request workspace

Each `run()` passes the SkVM-allocated `task.workDir` as `--workspace-dir` to `app_cli`, and the patched AgentServer scopes `sys_operation.work_dir` to that directory for the duration of the prompt. Filesystem and shell tools inside the agent then resolve relative paths against `task.workDir`, which is what bench's `file-check` evaluators read after the run.

The driver also prepends a one-line working-directory hint to the prompt (`Your working directory is X. Use relative paths …`). The hint is advisory — see [Agent may bypass the workspace override](#agent-may-bypass-the-workspace-override).

## Token, cost, and error reporting

Per-LLM-call usage flows through `chat.usage_metadata` events written into `~/.jiuwenclaw/agent/sessions/<id>/history.json`. The adapter sums them into `RunResult.tokens` (`input` / `output`) and accumulates `total_cost` per call into `RunResult.cost`. Cost is only populated when the underlying provider client surfaces it via `_extract_cost_info` (currently OpenAI / OpenRouter routes). DeepSeek and other plain `openai-compatible` routes report tokens correctly but cost as `$0`.

`chat.error` events carry an `error_type` field (the originating Python exception class). `diagnoseJiuwenclaw` prefixes the failure summary with `[ErrorType] …` so the SkVM bench post-mortem groups failures structurally.

## Known limitations

### History.json is keyed by an internal session id

jiuwenclaw's AgentServer remaps the client-supplied session_id to an internal `acp_*` id before writing `history.json`. The adapter snapshots the `~/.jiuwenclaw/agent/sessions/` directory before each run and picks the freshly-created entry as the path to read; this is robust but synthetic. Tracking upstream change to surface the internal id directly on `chat.final`.

### Agent may bypass the workspace override

`sys_operation.work_dir` is scoped per request, but jiuwenclaw's *system prompt* (built by `prompt_builder.py` at sidecar startup) still references the static home-dir workspace. A model that follows the system prompt over the per-request hint may emit absolute paths under `~/.jiuwenclaw/agent/jiuwenclaw_workspace/` instead of relative paths — and absolute paths bypass `work_dir`. In practice this is non-deterministic: file landing in `task.workDir` works for most runs but is not guaranteed for every model + prompt combination. A future jiuwenclaw PR injecting `workspace_dir` into `runtime_prompt_rail`'s system-prompt template would close this gap.

### Subagents inherit the static workspace

`Workspace(root_path=…)` is built once at sidecar startup and passed into code / research subagents. The per-request override only mutates `sys_operation.work_dir`, so any subagent path resolution that goes through `Workspace.root_path` still resolves under the home-dir workspace. Tasks that don't trigger subagents are unaffected; benchmarks that do should expect mixed file landing.

### Non-streaming `process_message_impl` doesn't carry `error_type`

The streaming aggregator in `interface.py:process_message_stream` and the streaming exception handler in `interface_deep.py` both attach `error_type` on `chat.error`. Non-streaming `process_message_impl` returns an `AgentResponse` without an analogous error classification; SkVM uses streaming exclusively so this has no impact today.

### macOS teardown can leave orphans

`jiuwenclaw.app/main()` only runs its `_terminate_all()` finally block on `KeyboardInterrupt`, not on `SIGTERM` — so killing the orchestrator pid leaves `app_agentserver` and `app_gateway` as orphans. The adapter mitigates with a post-teardown `pkill -f 'jiuwenclaw\.app'` sweep and waits up to 5s for port 19001 to clear.
