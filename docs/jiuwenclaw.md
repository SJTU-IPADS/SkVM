# jiuwenclaw Adapter

SkVM's `jiuwenclaw` adapter wraps [jiuwenclaw](https://github.com/openJiuwen-ai/jiuwenclaw) by launching `python -m jiuwenswarm.app` as a sidecar and driving it over ACP (Agent Client Protocol) JSON-RPC on `127.0.0.1:19001`.

> **Upstream rename note.** The upstream project renamed the Python package from `jiuwenclaw` to `jiuwenswarm` (v0.2.0, May 2026). The GitHub repo URL is unchanged. SkVM keeps the adapter name as `jiuwenclaw` so existing CLI flags (`--harness=jiuwenclaw`) and `~/.skvm/proposals/jit-optimize/jiuwenclaw/…` paths remain stable.

## Prerequisites

- Python **3.11+** (jiuwenswarm's `pyproject.toml` pins `>=3.11,<3.14`).
- A jiuwenswarm source checkout — the adapter runs it from source, not from a pip install.
- `OPENROUTER_API_KEY` (or whichever provider env var matches your `--model=`'s `providers.routes` entry) in your environment. The adapter writes a deterministic `.env` at sidecar boot time that pins the resolved API base / key / model name on the AgentServer side.
- A jiuwenswarm build that supports `params.workspace_dir` on `session/prompt` and emits `chat.usage_metadata` stream events. Sanity-check with:
  ```bash
  python -m jiuwenswarm.channels.acp.app_acp acp --help | grep workspace-dir
  ```

## Install jiuwenswarm

Clone jiuwenswarm anywhere on disk and create a Python 3.11+ virtual environment. The examples below use `$JIUWENSWARM_DIR` as a stand-in for whichever directory you pick.

```bash
export JIUWENSWARM_DIR=/path/to/jiuwenswarm   # pick any directory
git clone https://github.com/openJiuwen-ai/jiuwenclaw.git "$JIUWENSWARM_DIR"
cd "$JIUWENSWARM_DIR"
uv venv --python 3.12
uv sync
```

Verify the install resolves imports and exposes the workspace flag:

```bash
"$JIUWENSWARM_DIR/.venv/bin/python" -c "import jiuwenswarm.app; import jiuwenswarm.channels.acp.app_acp"
"$JIUWENSWARM_DIR/.venv/bin/python" -m jiuwenswarm.channels.acp.app_acp acp --help | grep workspace-dir
```

## Configure SkVM

Point `skvm.config.json` at your checkout (absolute or `~/`-prefixed paths both work):

```json
{
  "adapters": {
    "jiuwenclaw": "/path/to/jiuwenswarm"
  }
}
```

With `adapters.jiuwenclaw` set, `src/adapters/jiuwenclaw.ts` resolves the ACP stdio bridge as `python3 -m jiuwenswarm.channels.acp.app_acp` and spawns the orchestrator as `python3 -m jiuwenswarm.app`. It does **not** look up `jiuwenswarm-tui` on `PATH`.

The adapter hardcodes `python3` (no venv-aware resolution yet), so **activate the venv before invoking skvm**:

```bash
source "$JIUWENSWARM_DIR/.venv/bin/activate"
which python3   # → $JIUWENSWARM_DIR/.venv/bin/python3

bun run skvm run \
  --task=skvm-data/tasks/file-operations_task_01/task.json \
  --adapter=jiuwenclaw \
  --adapter-config=managed \
  --model=deepseek/deepseek-chat
```

`--adapter-config=managed` is required (or `defaults.adapterConfigMode=managed` in `skvm.config.json`); jiuwenswarm rejects native mode because its `set_user_home()` Python API only scopes config for the in-process side, not for the spawned `app_agentserver` + `app_gateway` children.

## How setup/teardown works

On each adapter `setup()` the SkVM driver acquires a cross-process file lock at `~/.jiuwenswarm/jiuwenclaw.sidecar.lock` — port 19001 and `~/.jiuwenswarm/config/.env` are both user-global singletons, so at most one sidecar may live at a time across all skvm processes on the host.

It then:

1. Backs up any existing `~/.jiuwenswarm/config/.env` to `.env.skvm-backup`.
2. Overwrites `.env` with a deterministic minimal file (`API_BASE`, `API_KEY`, `MODEL_NAME`, `MODEL_PROVIDER`, `BROWSER_RUNTIME_MCP_ENABLED=0`) — this is why **bench results are reproducible across machines** regardless of what local tool credentials (`SERPER_API_KEY`, `VISION_*`, etc.) you have configured.
3. Spawns `python3 -m jiuwenswarm.app` and waits up to 60s for the gateway port to accept connections.

On teardown the backup is restored and the sidecar process is killed. If a previous run crashed hard and left a stale `.env.skvm-backup`, the new run treats that backup as the true original — user credentials are never silently lost.

`setup()` and `teardown()` are reference-counted on the adapter side: the bench / jit-optimize stack calls both at the orchestrator level *and* inside `runTask`, and reentrant invocations no-op while the outermost setup is still active. This is invisible to non-jiuwenclaw adapters whose setup is cheap to repeat; for jiuwenclaw it prevents the inner setup from deadlocking on the host-wide sidecar lock the orchestrator already owns.

## Per-request workspace

Each `run()` passes the SkVM-allocated `task.workDir` as `--workspace-dir` to `app_acp`. The patched AgentServer threads the path into both `inputs["cwd"]` and `inputs["workspace_dir"]`, which the per-request `_update_runtime_config` → `_seed_runtime_cwd` → `init_cwd(cwd=…, workspace=…)` chain installs onto openjiuwen's `CwdState` ContextVar — covering both `get_cwd()` (relative-path resolution) and `get_workspace()` (the `fs_operation` sandbox membership check that gates absolute-path writes). Bench's `file-check` evaluators then read from `task.workDir` after the run.

The driver also prepends a one-line working-directory hint to the prompt (`Your working directory is X. Use relative paths …`).

## Token, cost, and error reporting

Per-LLM-call usage flows through `chat.usage_metadata` events written into `~/.jiuwenswarm/agent/sessions/<id>/history.json`. The adapter sums them into `RunResult.tokens` (`input` / `output`) and accumulates `total_cost` per call into `RunResult.cost`. Cost is only populated when the underlying provider client surfaces it via `_extract_cost_info` (currently OpenAI / OpenRouter routes). DeepSeek and other plain `openai-compatible` routes report tokens correctly but cost as `$0`.

`chat.error` events carry an `error_type` field (the originating Python exception class). `diagnoseJiuwenclaw` prefixes the failure summary with `[ErrorType] …` so the SkVM bench post-mortem groups failures structurally.

## Known limitations

### History.json is keyed by an internal session id

jiuwenswarm's AgentServer remaps the client-supplied session_id to an internal `acp_*` id before writing `history.json`. The adapter snapshots the `~/.jiuwenswarm/agent/sessions/` directory before each run and picks the freshly-created entry as the path to read; this is robust but synthetic. Tracking upstream change to surface the internal id directly on `chat.final`.

### System prompt still references the static workspace

jiuwenswarm's *system prompt* (built by `prompt_builder.py` at sidecar startup) names the home-dir workspace path. The per-request override covers `get_cwd()` and `get_workspace()` — so a model that emits absolute paths matching that prompt will write under the global workspace anyway, where `fs_operation`'s sandbox-membership check now rejects them (the per-request workspace doesn't contain that path). Models that follow the hint and use relative paths land in `task.workDir`. A future upstream PR threading `workspace_dir` into `runtime_prompt_rail`'s system-prompt template would close this gap.

### Subagents inherit the static workspace

`Workspace(root_path=…)` is built once at sidecar startup and passed into code / research subagents. The per-request `CwdState` override only re-seeds the parent agent's task context, so subagent path resolution that goes through `Workspace.root_path` (rather than `get_cwd()` / `get_workspace()`) still resolves under the home-dir workspace. Tasks that don't trigger subagents are unaffected; benchmarks that do should expect mixed file landing.

### Non-streaming `process_message_impl` doesn't carry `error_type`

The streaming aggregator in `interface.py:process_message_stream` and the streaming exception handler in `interface_deep.py` both attach `error_type` on `chat.error`. Non-streaming `process_message_impl` returns an `AgentResponse` without an analogous error classification; SkVM uses streaming exclusively so this has no impact today.

### macOS teardown can leave orphans

`jiuwenswarm.app/main()` only runs its `_terminate_all()` finally block on `KeyboardInterrupt`, not on `SIGTERM` — so killing the orchestrator pid leaves `app_agentserver` and `app_gateway` as orphans. The adapter mitigates with a post-teardown `pkill -f 'jiuwenswarm\.app'` sweep and waits up to 5s for port 19001 to clear.
