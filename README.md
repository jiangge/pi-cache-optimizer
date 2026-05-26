# Pi Cache Optimizer

[![npm version](https://img.shields.io/npm/v/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![license](https://img.shields.io/npm/l/pi-cache-optimizer.svg)](./LICENSE)

[中文说明](./README.zh-CN.md)

Pi extension for improving provider-side KV / prompt cache hit rates. It keeps stable prompt content near the front, adds a conservative OpenAI-compatible `prompt_cache_key` fallback, warns about common proxy cache-routing gaps, and shows read-only footer cache stats.

**GitHub About:** Improve Pi prompt/KV cache hit rates with stable prompts, OpenAI-compatible cache keys, proxy compat warnings, and footer cache stats.

> Renamed from `pi-deepseek-cache-optimizer`. Existing footer counters migrate automatically. This package never creates, edits, backs up, or deletes your `~/.pi/agent/models.json`.

## What it does

- Reorders stable system-prompt content before dynamic context.
- Compresses Pi skill listings and strips session-overview churn.
- Requests long cache retention when Pi/provider compat supports it.
- Adds a session-id `prompt_cache_key` fallback for `openai-completions` / `openai-responses` payloads when no effective key exists.
- Warns once for third-party OpenAI-compatible proxies missing cache/session-affinity compat flags.
- Shows session-scoped footer stats for supported model families.

Caching is provider-side and best-effort. Third-party proxies can still hide cache usage, reject unsupported parameters, or route requests across multiple upstreams.

## Install

```bash
pi install npm:pi-cache-optimizer
```

If you previously installed the old package:

```bash
pi remove npm:pi-deepseek-cache-optimizer && pi install npm:pi-cache-optimizer
```

Run `/reload` in Pi after install/update/remove so extension hooks refresh.

## Commands

| Command | Effect |
|---|---|
| `/cache-optimizer` | Interactive menu when UI supports it; otherwise prints help and current state. |
| `/cache-optimizer enable` | Enables runtime optimizations for the current Pi process, resets current-session stats, and starts a fresh “enabled” measurement. |
| `/cache-optimizer disable` | Disables optimization for the current Pi process, resets current-session stats, and keeps collecting footer stats in disabled comparison mode. Run `/reload` or restart Pi to return to startup behavior. |
| `/cache-optimizer doctor` | Shows active model/provider/API/base URL/compat plus low-hit diagnosis. |
| `/cache-optimizer compat` | Shows copyable compat advice for the active model, if applicable. |
| `/cache-optimizer stats` | Shows today's session-scoped counters and recent trend for the active model. |
| `/cache-optimizer reset` | Resets only local stats for the active session + model; upstream provider cache is not modified. |

`enable` / `disable` are current-process switches. For a persistent opt-out, use environment variables below.

## Persistent opt-out

| Env var | Effect |
|---|---|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | Disable prompt mutations only; footer stats and cache-key fallback remain active. |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | Keep Pi's verbose skill XML. |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | Disable the OpenAI-compatible `prompt_cache_key` fallback. |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | Disable the OpenAI-compatible `prompt_cache_key` fallback. |

## OpenAI-compatible proxy setup

For third-party `openai-completions` proxies such as Otokapi / LiteLLM / OneAPI / NewAPI / OpenRouter-like channels, low cache hit rate is often caused by multi-backend routing. The safe default is session affinity:

```json
{
  "providers": {
    "your-provider-id": {
      "api": "openai-completions",
      "baseUrl": "https://example.com/v1",
      "apiKey": "env:YOUR_API_KEY",
      "compat": {
        "sendSessionAffinityHeaders": true
      },
      "models": [
        { "id": "gpt-5.5", "name": "GPT-5.5" }
      ]
    }
  }
}
```

Only add `supportsLongCacheRetention: true` after the endpoint/proxy explicitly supports OpenAI long prompt cache retention. This extension does not directly write `prompt_cache_retention`; it requests `PI_CACHE_RETENTION=long`, and Pi may send `prompt_cache_retention` when compat says long retention is supported. If a proxy returns `400 Unsupported parameter: prompt_cache_retention`, remove/avoid `supportsLongCacheRetention` for that channel, keep `sendSessionAffinityHeaders` if supported, and use `/cache-optimizer compat` / `/cache-optimizer doctor` for diagnosis. When a 400 is observed while long retention compat is enabled, the extension adds a one-time warning and doctor hint. This extension itself only advises; it does not edit `models.json`.

## Footer stats

Stats are read-only local counters stored at `~/.pi/agent/pi-cache-optimizer-stats.json` and scoped by Pi session + provider/model. They contain only dates and numeric counters — no API keys, prompts, payloads, headers, responses, or model output.

Example footer:

```text
OpenAI cache 3/10 (30%) · 0.002M/0.005M tok ⚠️ compat
```

Supported footer labels include: DS, Claude, OpenAI, Gemini, Kimi, Qwen, GLM, MiniMax, Hunyuan, Mistral, Grok, Llama, Nemotron, Cohere, Yi, Doubao, ERNIE, Baichuan, StepFun, Spark, InternLM, Gemma, Phi, Jamba, Solar, Sonar, Nova, Reka, Falcon, DBRX, MPT, StableLM, Aquila, EXAONE, HyperCLOVA, Luminous, Hermes, Granite, Arctic, Pangu, SenseNova, Zhinao, MiniCPM, XVERSE, Orion, OpenChat, Vicuna, Wizard, Zephyr, Dolphin, OpenOrca, Starling, BLOOM, RWKV, and Aya.

Adapter selection uses only model id/name (plus assistant message model/name on message end). Generic OpenAI-shaped APIs are not treated as OpenAI-family unless the model id/name matches a supported family.

## Uninstall

```bash
pi remove npm:pi-cache-optimizer
```

Then run `/reload` or restart Pi. Optional local stats cleanup:

```bash
rm -f ~/.pi/agent/pi-cache-optimizer-stats.json
rm -f ~/.pi/agent/deepseek-cache-optimizer-stats.json
```

## Verify effect

1. Select a model whose provider exposes cache usage.
2. Send several similar turns in the same Pi session.
3. Watch the footer or run `/cache-optimizer stats`.
4. For third-party proxies, also run `/cache-optimizer doctor` and confirm sticky routing / session affinity on the proxy side.

## License

MIT
