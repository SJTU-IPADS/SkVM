# Provider Configuration

How to route LLM calls in SkVM. Covers the built-in provider kinds, custom OpenAI-compatible endpoints, and which parts of skvm are skvm's responsibility vs. the user's.

## Quick start: `skvm config`

```bash
skvm config init      # interactive wizard; writes $SKVM_CACHE/skvm.config.json (chmod 0600)
skvm config show      # print the resolved config and where each value came from
skvm config doctor    # verify env vars, adapter checkouts, cache writability
```

The wizard writes to `$SKVM_CACHE/skvm.config.json` (default `~/.skvm/skvm.config.json`) so the file persists across `npm i -g @ipads-skvm/skvm` upgrades and isn't tied to any one checkout. A legacy in-tree path at `<project>/skvm.config.json` is still read for backwards compat.

Skip this section and read on if you'd rather edit the JSON by hand.

## Prefix-required convention

**Every model id you pass to skvm on the CLI is `<provider>/<model-id>`.** The `<provider>` prefix picks a route in `providers.routes`; the `<model-id>` after it is what gets sent to the backend SDK. skvm always strips the first `/`-segment before the native SDK sees the id.

Examples:
- `openrouter/qwen/qwen3-30b` → matches `openrouter/*` → OR SDK receives `qwen/qwen3-30b`
- `openrouter/anthropic/claude-sonnet-4.6` → matches `openrouter/*` → OR SDK receives `anthropic/claude-sonnet-4.6` (OR's native format)
- `anthropic/claude-sonnet-4.6` → matches `anthropic/*` → Anthropic SDK receives `claude-sonnet-4.6`
- `openai/gpt-4o` → matches `openai/*` → OpenAI SDK receives `gpt-4o`
- `ipads/gpt-4o` → matches `ipads/*` (your custom) → your endpoint receives `gpt-4o`

Unprefixed ids error out with "no matching route". The built-in fallback is `openrouter/*` — unprefixed ids don't magically route anywhere.

## `providers.routes`

Maps model-id prefixes to backends. Routes are matched top-to-bottom against the full id you pass; the first glob (`*` wildcard, no regex) match wins.

```json
{
  "providers": {
    "routes": [
      { "match": "anthropic/*",  "kind": "anthropic",         "apiKey": "sk-ant-..." },
      { "match": "openai/*",     "kind": "openai-compatible", "apiKey": "sk-...",          "baseUrl": "https://api.openai.com/v1" },
      { "match": "self/*",       "kind": "openai-compatible", "apiKeyEnv": "VLLM_API_KEY", "baseUrl": "http://localhost:8000/v1" },
      { "match": "openrouter/*", "kind": "openrouter",        "apiKeyEnv": "OPENROUTER_API_KEY" }
    ]
  }
}
```

### Route schema

```jsonc
{
  "match": "<glob>",
  "kind": "openrouter" | "anthropic" | "openai-compatible",
  "apiKey": "<literal-key>",   // OR apiKeyEnv — one is required
  "apiKeyEnv": "<ENV_VAR_NAME>",
  "baseUrl": "<url>"           // required for openai-compatible, ignored for openrouter/anthropic
}
```

**`apiKey` vs `apiKeyEnv`**
- `apiKey`: literal value stored in `skvm.config.json`. The file is gitignored and `skvm config init` writes it with mode `0600`. Simplest path; no shell setup required.
- `apiKeyEnv`: env var name read at runtime. Use this when keys live in direnv / 1Password / a vault / CI. `<repo>/.env` is auto-loaded at startup, so a `NAME=value` line there works without a shell `export`.
- Both set: `apiKey` wins.

### The three provider kinds

All three strip the first `/`-segment from the CLI id before talking to the backend SDK:

| Kind | baseUrl | What the backend SDK receives | Typical use |
|---|---|---|---|
| `openrouter` | hardcoded `openrouter.ai/api/v1` | whatever's after `openrouter/` — OR uses `vendor/model` natively (e.g. `qwen/qwen3-30b`) | one-key multi-provider |
| `anthropic` | hardcoded `api.anthropic.com` | bare model name (`anthropic/claude-sonnet-4.6` → `claude-sonnet-4.6`) | native Anthropic Messages |
| `openai-compatible` | **required** | bare model name (`openai/gpt-4o` → `gpt-4o`) | OpenAI / DeepSeek / vLLM / Ollama / Together / SiliconFlow / any proxy |

## Where `providers.routes` applies

`providers.routes` is the single credential source, but it reaches different subsystems in different ways. Know the distinction before filing a routing bug:

| Subsystem | How it uses `providers.routes` |
|---|---|
| **In-process LLM calls** — compiler passes, bench judges, jit-optimize eval, jit-boost candidate parsing | Full use: `instantiate()` in `providers/registry.ts` resolves the route → picks the right SDK → passes the stripped model id + key + baseUrl |
| **`bare-agent` adapter** | Same as in-process (bare-agent IS skvm calling the SDK directly) |
| **Headless agent** — the opencode subprocess that jit-optimize / jit-boost spawn as the optimizer | Full use: skvm looks up the route, maps the skvm model id into opencode's namespace, and for openai-compatible routes injects `OPENCODE_CONFIG_CONTENT` so opencode knows the custom endpoint — you don't touch `~/.opencode/` |
| **External adapters** — opencode / openclaw / hermes / jiuwenclaw used as bench/profile/run **targets** | Partial: skvm injects standard SDK env vars (`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`ANTHROPIC_API_KEY`/`OPENROUTER_API_KEY`) from the matched route before spawn. **The adapter's own provider/model config is the user's responsibility** (opencode.jsonc, openclaw models.json, jiuwenclaw .env). If you bench `ipads/gpt-4o` with opencode as the adapter, configure `ipads` in opencode first. |

### Why the asymmetry?

- The **headless agent** is a skvm implementation detail: jit-optimize happens to use opencode to drive the optimizer. Users shouldn't be forced to configure their global opencode just because jit-optimize wants to use a custom endpoint. So skvm fully manages it.
- External **adapters** are the systems skvm is benchmarking. Leaving their config to the user is honest — skvm isn't going to paper over gaps in the user's opencode / openclaw setup by rewriting their config files behind their back.

## Environment variables

Only relevant when a route uses `apiKeyEnv`, or when no route exists:

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | Default fallback when no route is configured |
| `ANTHROPIC_API_KEY` | Default `apiKeyEnv` the wizard suggests for Anthropic routes |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Standard SDK vars skvm auto-injects into external adapter subprocesses when the matched route is openai-compatible |
| Any custom name | Whatever you put in `apiKeyEnv` |

You can `export X=...` in your shell, or write `X=...` lines to `<repo>/.env` — the latter is auto-loaded at startup.

## `headlessAgent` — minimal

```jsonc
{
  "headlessAgent": {
    "driver": "opencode",
    "opencodePath": "/custom/path/to/opencode"   // optional
  }
}
```

| Field | Default | Purpose |
|---|---|---|
| `driver` | `"opencode"` | Agent backend (only opencode today) |
| `opencodePath` | — | Explicit binary for the headless tuner (falls through to bundled → global when unset) |

There is **no** `providerOverride` / `modelPrefix` — those were legacy. Credentials and endpoints come from `providers.routes` based on whatever model id you pass to `--optimizer-model=`.

## Recipes

### Use OpenRouter for everything (default)

```bash
export OPENROUTER_API_KEY=sk-or-...
```

No `skvm.config.json` changes needed — the built-in fallback route is `openrouter/*`. Model ids are written as `openrouter/<vendor>/<model>`:

```bash
skvm profile --model=openrouter/qwen/qwen3-30b-a3b --adapter=bare-agent
skvm bench --model=openrouter/anthropic/claude-sonnet-4.6 --adapter=bare-agent
```

### Use a local vLLM server

```json
{
  "providers": {
    "routes": [
      { "match": "self/*",       "kind": "openai-compatible", "apiKeyEnv": "VLLM_API_KEY", "baseUrl": "http://localhost:8000/v1" },
      { "match": "openrouter/*", "kind": "openrouter",        "apiKeyEnv": "OPENROUTER_API_KEY" }
    ]
  }
}
```

```bash
export VLLM_API_KEY=token-xyz    # or any placeholder if auth is disabled
skvm jit-optimize --skill=path/to/skill \
  --optimizer-model=self/qwen3.5-35b-a3b \
  --target-model=self/qwen3.5-35b-a3b \
  --task-source=synthetic
```

The optimizer works without touching opencode's global config — skvm injects `OPENCODE_CONFIG_CONTENT` for the `self/*` route. The target (also `self/*` via opencode adapter) needs `self` configured in `~/.opencode/opencode.jsonc` — otherwise opencode won't know what `self/qwen3.5-35b-a3b` means.

### Mix: Anthropic compiler + custom target

```json
{
  "providers": {
    "routes": [
      { "match": "anthropic/*",  "kind": "anthropic",         "apiKey": "sk-ant-..." },
      { "match": "self/*",       "kind": "openai-compatible", "apiKeyEnv": "VLLM_API_KEY", "baseUrl": "http://localhost:8000/v1" },
      { "match": "openrouter/*", "kind": "openrouter",        "apiKeyEnv": "OPENROUTER_API_KEY" }
    ]
  }
}
```

```bash
# aot-compile: compiler default is openrouter/anthropic/claude-sonnet-4.6 (MODEL_DEFAULTS);
# override to the native route if you want direct Anthropic billing:
skvm aot-compile --skill=path/to/skill --model=self/my-model --compiler-model=anthropic/claude-sonnet-4.6

# jit-optimize: optimizer + target through self-hosted
skvm jit-optimize --optimizer-model=self/my-model --target-model=self/my-model ...
```

## Troubleshooting

### `Route "openrouter/*" requires env var OPENROUTER_API_KEY, which is not set`

You passed an unprefixed CLI id (e.g. `--model=qwen/qwen3-30b`) and the built-in `openrouter/*` fallback doesn't match it — so the real error is "no route matched". Add the `openrouter/` prefix (`--model=openrouter/qwen/qwen3-30b`) or add an explicit route for whatever prefix you're using.

### `Route "..." requires env var X, which is not set`

The matched route uses `apiKeyEnv` but the variable isn't defined. Either export it, write it to `<repo>/.env`, or switch the route to use a literal `apiKey`.

### `Route "..." has neither apiKey nor apiKeyEnv set`

Schema guard — a route needs one of the two. Re-run `skvm config init` or add the field manually.

### My CLI scripts used unprefixed ids like `qwen/qwen3-30b` — now they error out

This is the prefix-required convention. Every CLI id now needs a `<provider>/` prefix. Migrate: `qwen/qwen3-30b` → `openrouter/qwen/qwen3-30b`, `anthropic/claude-sonnet-4.6` stays the same (it's already prefixed by `anthropic`), etc. Disk artifacts like `skvm-data/profiles/` are unchanged — `safeModelName()` strips the routing prefix before slugifying, so `openrouter/anthropic/claude-opus-4.6` and the old `anthropic/claude-opus-4.6` both produce the same `anthropic--claude-opus-4.6/` directory.

### Bench / profile fails: adapter can't resolve model id

Example: `skvm bench --adapter=opencode --model=ipads/gpt-4o` fails with opencode reporting an unknown provider. skvm only injects *credentials* into the adapter subprocess — the adapter needs to know about the provider prefix itself. Add `ipads` to `~/.opencode/opencode.jsonc` (for opencode), to your openclaw `models.json`, or to jiuwenclaw's `.env.template` before running. skvm's `providers.routes` does not rewrite those files.

### jit-optimize works for `ipads/*` but bench doesn't (with the same model id)

Expected asymmetry — see "Where providers.routes applies" above. The headless agent (jit-optimize's optimizer) is skvm-managed; the adapter (bench's target) is user-managed.

### `max_tokens is too large` from the headless agent

skvm's built-in `contextLimit` / `outputLimit` defaults (128K / 16K) are too generous for your endpoint. Edit `src/core/ui-defaults.ts` `HEADLESS_AGENT_DEFAULTS` or lower the limits on your endpoint's side.

### Legacy `headlessAgent.providerOverride` / `modelPrefix` still in your config

These fields used to configure the headless agent separately. They're gone — skvm ignores them but `skvm config show` / `doctor` will print a yellow warning. Re-run `skvm config init` to clean the file up.
