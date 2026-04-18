# jiuwenclaw Adapter

SkVM's `jiuwenclaw` adapter wraps [jiuwenclaw](https://github.com/openJiuwen-ai/jiuwenclaw) by launching `python -m jiuwenclaw.app` as a sidecar and driving it over ACP (Agent Client Protocol) JSON-RPC on `127.0.0.1:19001`.

> **Required upstream patch** — jiuwenclaw as of commit `2ca9ce3` has a bug on the ACP envelope path that drops all streaming events and hangs the session. Apply the patch in [Required patch](#required-patch) before running.

## Prerequisites

- Python **3.11+** (jiuwenclaw's `pyproject.toml` pins `>=3.11,<3.14`).
- A jiuwenclaw source checkout — the adapter runs it from source, not from a pip install.
- `OPENROUTER_API_KEY` in your environment. The adapter writes a deterministic `.env` at setup time that routes jiuwenclaw's LLM calls through OpenRouter with this key.

## Install jiuwenclaw

Clone jiuwenclaw anywhere on disk and create a Python 3.11+ virtual environment. The examples below use `$JIUWENCLAW_DIR` as a stand-in for whichever directory you pick.

```bash
export JIUWENCLAW_DIR=/path/to/jiuwenclaw   # pick any directory
git clone https://github.com/openJiuwen-ai/jiuwenclaw.git "$JIUWENCLAW_DIR"
cd "$JIUWENCLAW_DIR"
uv venv --python 3.12
uv sync
```

Verify the install resolves imports:

```bash
"$JIUWENCLAW_DIR/.venv/bin/python" -c "import jiuwenclaw.app_cli; import jiuwenclaw.app"
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
  --model=openrouter/z-ai/glm-5.1 \
  --verbose
```

## How setup/teardown works

On each run the adapter acquires a cross-process file lock at `~/.jiuwenclaw/jiuwenclaw.sidecar.lock` — port 19001 and `~/.jiuwenclaw/config/.env` are both user-global singletons, so at most one sidecar may live at a time across all skvm processes on the host.

It then:

1. Backs up any existing `~/.jiuwenclaw/config/.env` to `.env.skvm-backup`.
2. Overwrites `.env` with a deterministic minimal file (`API_BASE`, `API_KEY`, `MODEL_NAME`, `MODEL_PROVIDER`, `BROWSER_RUNTIME_MCP_ENABLED=0`) — this is why **bench results are reproducible across machines** regardless of what local tool credentials (`SERPER_API_KEY`, `VISION_*`, etc.) you have configured.
3. Spawns `python3 -m jiuwenclaw.app` and waits up to 60s for the gateway port to accept connections.

On teardown the backup is restored and the sidecar process is killed. If a previous run crashed hard and left a stale `.env.skvm-backup`, the new run treats that backup as the true original — user credentials are never silently lost.

## Known limitations

### Token/cost not reported

jiuwenclaw's AgentServer does not surface per-request token/cost totals to ACP clients, so bench and profile aggregators will report `$0` and `tokens: in=0 out=0` for every jiuwenclaw run. This is by design in the adapter — don't use jiuwenclaw for cost/throughput benchmarks.

### Files are written to jiuwenclaw's workspace, not SkVM's workDir

Every filesystem tool call from jiuwenclaw's agent resolves paths against its own workspace (`~/.jiuwenclaw/agent/jiuwenclaw_workspace/`), not the `workDir` skvm allocates per task. Any eval that reads the task's `workDir` (e.g. `file-check`) will find nothing and fail.

Until this is fixed (either in jiuwenclaw by honoring a session-level cwd, or in the adapter by plumbing `workDir` through and rewriting paths), jiuwenclaw runs are best used for **execution smoke tests** with `skvm run`, not for `skvm bench` with automated grading.

## Required patch

**Upstream**: `jiuwenclaw/channel/acp_channel.py`, commit [`2ca9ce3`](https://github.com/openJiuwen-ai/jiuwenclaw/commit/2ca9ce3e0eaa60d46b4026bf25000b172c5bff8e).

**Symptom without the patch**: the sidecar boots, the ACP session is created, the LLM is invoked, but SkVM's request hangs indefinitely waiting for a final frame. Verbose logs show streaming chunks being generated on the server side but never arriving at the client.

**Root cause**: the JSON-RPC `session.create`/`prompt` path in `AcpChannel` populates `_active_prompt_request_by_session[session_id] = msg.id`, which is what `_message_from_gateway_event` consults to route gateway event chunks back to an originating request. The **envelope path** (`_handle_raw_line` when the peer is using E2AEnvelope instead of raw JSON-RPC — this includes `jiuwenclaw.app_cli` itself, which SkVM drives) only populates `_request_ctx[msg.id]` and skips the session→request mapping, so streaming events are silently dropped and the final frame is never emitted.

**Fix**: mirror the same registration on the envelope path. Insert the block below in `_handle_raw_line`, immediately after the `_request_ctx[msg.id] = _AcpRequestContext(...)` assignment and before `await self._dispatch_message(msg)`:

```python
# jiuwenclaw/channel/acp_channel.py — _handle_raw_line, ~line 178
self._request_ctx[msg.id] = _AcpRequestContext(
    jsonrpc_id=env.jsonrpc_id,
    method=env.method,
    response_mode="e2a",
    session_id=msg.session_id,
)
# Mirror the JSON-RPC session/prompt path: register the session→request
# mapping so gateway event chunks (_message_from_gateway_event) can
# resolve their request_id and emit responses. Without this, streaming
# events on the envelope path are silently dropped and the channel
# hangs waiting for a final frame that never arrives.
if msg.session_id:
    self._active_prompt_request_by_session[msg.session_id] = msg.id

await self._dispatch_message(msg)
```

Until this lands upstream, apply it in your local checkout:

```bash
cd "$JIUWENCLAW_DIR"
git fetch origin
git cherry-pick 2ca9ce3   # if it's on a branch you haven't merged
# or pull from whichever branch carries the fix
```
