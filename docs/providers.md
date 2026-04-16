# Provider Configuration

How to configure LLM providers in SkVM. Covers the built-in providers, custom OpenAI-compatible endpoints, and the headless agent (jit-optimize / jit-boost) provider override.

## Two provider systems

SkVM has two independent provider paths because some LLM calls happen in-process while others are delegated to an opencode subprocess:

| Path | Config location | Used by |
|------|----------------|---------|
| **`providers.routes`** | `skvm.config.json` | eval/judge, compiler, bare-agent adapter, jit-boost candidate parsing |
| **`headlessAgent.providerOverride`** | `skvm.config.json` | jit-optimize optimizer agent, synthetic task generation (via opencode subprocess) |

Both are configured in `skvm.config.json`. When using a custom endpoint, both paths need to be set up.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `OPENROUTER_API_KEY` | Default fallback for all model routing |
| `ANTHROPIC_API_KEY` | Anthropic native API (compiler, Claude models) |
| Any custom name | Referenced via `apiKeyEnv` in route/override config |

## `providers.routes` — in-process LLM calls

Routes match model IDs top-to-bottom using glob patterns (`*` wildcard). The first match wins. If no route matches, SkVM falls back to OpenRouter with `OPENROUTER_API_KEY`.

### Route schema

```json
{
  "match": "<glob>",
  "kind": "openrouter" | "anthropic" | "openai-compatible",
  "apiKeyEnv": "<ENV_VAR_NAME>",
  "baseUrl": "<url>"          // required for openai-compatible, ignored otherwise
}
```

### Three provider kinds

#### `openrouter`

Routes through the OpenRouter API. Model IDs are passed through unchanged (OpenRouter's namespace already uses `vendor/model` format).

```json
{ "match": "*", "kind": "openrouter", "apiKeyEnv": "OPENROUTER_API_KEY" }
```

No `baseUrl` needed — hardcoded to the OpenRouter API.

#### `anthropic`

Routes through the Anthropic Messages API. The first `/`-segment of the model ID is stripped before sending (e.g. `anthropic/claude-sonnet-4.6` becomes `claude-sonnet-4.6`).

```json
{ "match": "anthropic/*", "kind": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
```

No `baseUrl` needed — hardcoded to the Anthropic API.

#### `openai-compatible`

Routes through any server implementing the OpenAI `/chat/completions` protocol. The first `/`-segment is stripped (e.g. `custom/gpt-4o` becomes `gpt-4o`). Requires `baseUrl`.

```json
{ "match": "custom/*", "kind": "openai-compatible", "apiKeyEnv": "CUSTOM_API_KEY", "baseUrl": "http://localhost:8000/v1" }
```

Works with: vLLM, Ollama, DeepSeek API, Together, Fireworks, SiliconFlow, Azure OpenAI, or any OpenAI-compatible proxy.

### Full example

```json
{
  "providers": {
    "routes": [
      { "match": "anthropic/*", "kind": "anthropic",         "apiKeyEnv": "ANTHROPIC_API_KEY" },
      { "match": "openai/*",    "kind": "openai-compatible", "apiKeyEnv": "OPENAI_API_KEY",   "baseUrl": "https://api.openai.com/v1" },
      { "match": "self/*",      "kind": "openai-compatible", "apiKeyEnv": "VLLM_API_KEY",     "baseUrl": "http://localhost:8000/v1" },
      { "match": "*",           "kind": "openrouter",        "apiKeyEnv": "OPENROUTER_API_KEY" }
    ]
  }
}
```

Then use model IDs like `anthropic/claude-sonnet-4.6`, `openai/gpt-4o`, `self/qwen3.5-35b-a3b`, or `qwen/qwen3-30b-a3b` (falls through to OpenRouter).

## `headlessAgent` — opencode subprocess provider

The jit-optimize optimizer and synthetic task generator run as opencode subprocesses. These do **not** use `providers.routes` — they have their own routing via `headlessAgent`.

### Default behavior

Without any `headlessAgent` config, model IDs are prefixed with `openrouter/` and sent to opencode, which routes them through OpenRouter. This requires `OPENROUTER_API_KEY` to be set in opencode's config or environment.

```json
{
  "headlessAgent": {
    "driver": "opencode",
    "modelPrefix": "openrouter/"
  }
}
```

### Schema

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `driver` | `"opencode"` | `"opencode"` | Agent backend (only opencode is currently supported) |
| `modelPrefix` | `string` | `"openrouter/"` | Prepended to model IDs before passing to opencode |
| `providerOverride` | object | — | Injects a custom provider into the opencode subprocess |

### `providerOverride` schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Provider name in opencode's namespace. Must match the first segment of `modelPrefix`. |
| `baseUrl` | `string` | yes | OpenAI-compatible endpoint URL |
| `apiKeyEnv` | `string` | no | Environment variable name holding the API key |
| `apiKey` | `string` | no | Direct API key value (takes precedence over `apiKeyEnv`) |
| `contextLimit` | `number` | no | Max context window tokens (default: 128,000) |
| `outputLimit` | `number` | no | Max output/completion tokens (default: 16,384) |

When `providerOverride` is set, SkVM:

1. Builds an opencode config JSON with the provider definition (including `npm: "@ai-sdk/openai-compatible"` and model entry)
2. Merges it with any pre-existing `OPENCODE_CONFIG_CONTENT` from the environment
3. Injects the result as `OPENCODE_CONFIG_CONTENT` into the opencode subprocess

This does **not** modify your global opencode config (`~/.opencode/opencode.jsonc`).

## Recipes

### Use OpenRouter for everything (default)

```bash
export OPENROUTER_API_KEY=sk-or-...
```

No `skvm.config.json` changes needed.

### Use a local vLLM server

```bash
export VLLM_API_KEY=token-xyz    # or any placeholder if auth is disabled
```

```json
{
  "providers": {
    "routes": [
      { "match": "self/*", "kind": "openai-compatible", "apiKeyEnv": "VLLM_API_KEY", "baseUrl": "http://localhost:8000/v1" },
      { "match": "*",      "kind": "openrouter",        "apiKeyEnv": "OPENROUTER_API_KEY" }
    ]
  },
  "headlessAgent": {
    "modelPrefix": "self/",
    "providerOverride": {
      "name": "self",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "VLLM_API_KEY"
    }
  }
}
```

```bash
skvm jit-optimize --skill=path/to/skill \
  --optimizer-model=self/qwen3.5-35b-a3b \
  --target-model=self/qwen3.5-35b-a3b \
  --task-source=synthetic
```

### Use a shared OpenAI-compatible proxy

```bash
export PROXY_KEY=sk-xxx
```

```json
{
  "providers": {
    "routes": [
      { "match": "proxy/*", "kind": "openai-compatible", "apiKeyEnv": "PROXY_KEY", "baseUrl": "http://my-proxy:3006/v1" },
      { "match": "*",       "kind": "openrouter",        "apiKeyEnv": "OPENROUTER_API_KEY" }
    ]
  },
  "headlessAgent": {
    "modelPrefix": "proxy/",
    "providerOverride": {
      "name": "proxy",
      "baseUrl": "http://my-proxy:3006/v1",
      "apiKeyEnv": "PROXY_KEY"
    }
  }
}
```

```bash
# Optimizer through proxy, target through proxy
skvm jit-optimize --optimizer-model=proxy/gpt-4o --target-model=proxy/gpt-4o ...

# Optimizer through proxy, target through OpenRouter
skvm jit-optimize --optimizer-model=proxy/gpt-4o --target-model=qwen/qwen3-30b-a3b ...
```

### Mix providers: Anthropic compiler + custom target

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export VLLM_API_KEY=token-xyz
```

```json
{
  "providers": {
    "routes": [
      { "match": "anthropic/*", "kind": "anthropic",         "apiKeyEnv": "ANTHROPIC_API_KEY" },
      { "match": "self/*",      "kind": "openai-compatible", "apiKeyEnv": "VLLM_API_KEY", "baseUrl": "http://localhost:8000/v1" },
      { "match": "*",           "kind": "openrouter",        "apiKeyEnv": "OPENROUTER_API_KEY" }
    ]
  },
  "headlessAgent": {
    "modelPrefix": "self/",
    "providerOverride": {
      "name": "self",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "VLLM_API_KEY"
    }
  }
}
```

```bash
# AOT-compile uses Anthropic as compiler, self-hosted as target
skvm aot-compile --skill=path/to/skill --model=self/my-model

# jit-optimize: optimizer through self-hosted, target through self-hosted
skvm jit-optimize --optimizer-model=self/my-model --target-model=self/my-model ...
```

### Override output token limit

If your endpoint supports more than 16,384 output tokens:

```json
{
  "headlessAgent": {
    "modelPrefix": "self/",
    "providerOverride": {
      "name": "self",
      "baseUrl": "http://localhost:8000/v1",
      "apiKeyEnv": "VLLM_API_KEY",
      "outputLimit": 32768,
      "contextLimit": 131072
    }
  }
}
```

## Troubleshooting

### `Route "..." requires env var X, which is not set`

The matched route's `apiKeyEnv` points to an unset environment variable. Export it:

```bash
export X=your-key-here
```

### `max_tokens is too large`

Your endpoint's max output token limit is lower than the default (16,384). Set `outputLimit` in `providerOverride` to match your server's limit.

### opencode subprocess errors with `ModelNotFoundError`

The model ID isn't registered in opencode's models.dev database and no `providerOverride` is configured. Add a `providerOverride` to `headlessAgent` — this automatically registers the model in the opencode subprocess.

### `providerOverride` works but `providers.routes` calls fail (or vice versa)

These are two independent systems. Check that **both** are configured for your custom endpoint. The banner at startup shows the resolved route for each model:

```
Optimizer  custom/gpt-4o via openai-compatible (http://localhost:8000/v1)
Target     custom/gpt-4o via openai-compatible (http://localhost:8000/v1) / bare-agent (built-in)
```

If the route shows `via openrouter` when you expected your custom endpoint, your `providers.routes` glob doesn't match the model ID.
