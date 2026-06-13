# Pi Cache Optimizer

[![npm version](https://img.shields.io/npm/v/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![license](https://img.shields.io/npm/l/pi-cache-optimizer.svg)](./LICENSE)

[中文说明](./README.zh-CN.md)

Pi extension for improving provider-side KV / prompt cache hit rates. It keeps stable prompt content near the front, adds a conservative OpenAI-compatible `prompt_cache_key` fallback, warns about common proxy cache-routing gaps, and shows read-only footer cache stats.

> Renamed from `pi-deepseek-cache-optimizer`. Existing footer counters migrate automatically. This package never creates, edits, backs up, or deletes your `~/.pi/agent/models.json`.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Commands](#commands)
- [Persistent opt-out](#persistent-opt-out)
- [OpenAI-compatible proxy setup](#openai-compatible-proxy-setup)
- [Footer stats](#footer-stats)
- [Uninstall](#uninstall)
- [Verify effect](#verify-effect)
- [License](#license)

## What it does

- Reorders stable system-prompt content before dynamic context.
- Compresses Pi skill listings and strips session-overview churn.
- Requests long cache retention when Pi/provider compat supports it.
- Adds a session-id `prompt_cache_key` fallback for `openai-completions` / `openai-responses` payloads when no effective key exists.
- Warns once for third-party OpenAI-compatible proxies missing cache/session-affinity compat flags.
- Detects Anthropic adaptive thinking models (opus-4.6+, sonnet-4.6+, fable-5+) missing `forceAdaptiveThinking: true` compat.
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
| `/cache-optimizer fix` | Auto-repairs safe compat issues for the active model (adaptive thinking, DeepSeek reasoning, OpenAI proxy session affinity). Shows preview + risk warning, requires confirmation. **Only modifies `models.json` after explicit user approval.** |

`enable` / `disable` are current-process switches. For a persistent opt-out, use environment variables below.

## Persistent opt-out

| Env var | Effect |
|---|---|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | Disable prompt mutations only; footer stats and cache-key fallback remain active. |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | Keep Pi's verbose skill XML. |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | Disable the OpenAI-compatible `prompt_cache_key` fallback. Preferred explicit opt-out. |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | Disable the same fallback via the legacy inverse switch. Values `0`, `false`, `no`, or `off` disable it. |

## OpenAI-compatible proxy setup

Third-party `openai-completions` proxies (LiteLLM / OneAPI / NewAPI / OpenRouter-like channels) often route one session across multiple upstream backends. That splits provider-side prompt caches. Start with session affinity:

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

Notes:

- `sendSessionAffinityHeaders: true` is the safe default when your proxy supports sticky routing.
- `supportsLongCacheRetention: true` is optional. Add it only when the endpoint explicitly supports OpenAI long prompt cache retention.
- If you see `400 Unsupported parameter: prompt_cache_retention`, remove/avoid `supportsLongCacheRetention` for that channel. Keep `sendSessionAffinityHeaders` if supported.
- Use `/cache-optimizer compat` or `/cache-optimizer doctor` to see model-specific advice.
- For DeepSeek models, the Pi Mono guidance expects `compat.requiresReasoningContentOnAssistantMessages: true` and `compat.thinkingFormat: "deepseek"` alongside cache/session-affinity flags when the endpoint supports them.
- This extension's `doctor` and `compat` commands only advise; they do not modify `models.json`.

## Anthropic adaptive thinking models

Claude models from opus-4.6 / sonnet-4.6 / fable-5 onwards require `forceAdaptiveThinking: true` in compat. Without it, Pi sends the legacy thinking format and Anthropic rejects the request.

Pi's built-in catalog already sets this flag for official models. Custom channels in `models.json` that override these models must include the flag:

```json
{
  "providers": {
    "your-claude-channel": {
      "api": "anthropic-messages",
      "baseUrl": "https://...",
      "apiKey": "env:YOUR_KEY",
      "compat": {
        "forceAdaptiveThinking": true
      },
      "models": [
        { "id": "claude-opus-4-8", "name": "Claude Opus 4.8" }
      ]
    }
  }
}
```

Or use model-level override:

```json
{
  "providers": {
    "your-claude-channel": {
      "modelOverrides": {
        "claude-opus-4-8": {
          "compat": {
            "forceAdaptiveThinking": true
          }
        }
      }
    }
  }
}
```

`/cache-optimizer doctor` and `/cache-optimizer compat` detect missing flags and show copyable JSON.

## Auto-repair with `/cache-optimizer fix`

**v2.6.0+** adds a `fix` subcommand that can auto-repair safe compat issues:

- Anthropic adaptive thinking (`forceAdaptiveThinking: true`)
- DeepSeek Pi Mono reasoning compat (`thinkingFormat: "deepseek"`, `requiresReasoningContentOnAssistantMessages: true`)
- OpenAI-compatible proxy session affinity (`sendSessionAffinityHeaders: true` for `openai-completions`, `sendSessionIdHeader: true` for `openai-responses`)

**Scope:** only the currently active model. Other channels require switching models and running `fix` again.

**Safety:**

1. Shows full preview of changes (file path, edit location, JSON to write, risks)
2. Warns: ① changes affect all sessions using that channel, ② automatic backup created at `models.json.backup-cache-optimizer-<timestamp>`, ③ Pi reload required
3. Uses comment-preserving surgical editor — existing comments, indentation, key order preserved
4. Requires explicit user confirmation (interactive prompt or `ui.select`)
5. Writes atomically (temp + rename); self-validates after write
6. Falls back to manual guidance if JSONC scanner cannot confidently locate the target

**Non-interactive mode:** refuses to write; shows manual edit guidance instead.

**Run:** `/cache-optimizer fix` when the active model has detected compat issues. The command shows "nothing to fix" when compat is already complete.

### Channels without a `models.json` provider entry

Some Pi channels may be available even when there is no provider block in `~/.pi/agent/models.json` yet. Keep existing authentication as-is and do not copy credentials, tokens, or API keys. Add only cache/routing compatibility overrides in `models.json`.

Provider-level minimal override:

```json
{
  "providers": {
    "your-provider-id": {
      "compat": {
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

If only one model should change, use `modelOverrides`:

```json
{
  "providers": {
    "your-provider-id": {
      "modelOverrides": {
        "gpt-5.5": {
          "compat": {
            "sendSessionAffinityHeaders": true
          }
        }
      }
    }
  }
}
```

## Footer stats

Stats are read-only local counters stored at `~/.pi/agent/pi-cache-optimizer-stats.json` and scoped by Pi session + provider/model. They contain only dates and numeric counters — no API keys, prompts, payloads, headers, responses, or model output.

Example footer:

```text
OpenAI cache 3/10 · 0.002M/0.005M tok (40%) ⚠️ compat
```

Format: `<label> <hit requests>/<total requests> · <cached input tokens>/<total input tokens> tok (<token hit rate>)`. Some adapters may also append `· write <tokens> tok`, and runtime diagnostics may append `⚠️ compat` or `⚠️ integrity`.

Supported footer labels include: DS, Claude, OpenAI, Gemini, Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, Mistral, Grok, Llama, Nemotron, Cohere, Yi, Doubao, ERNIE, Baichuan, StepFun, Spark, InternLM, Gemma, Phi, Jamba, Solar, Sonar, Nova, Reka, Falcon, DBRX, MPT, StableLM, Aquila, EXAONE, HyperCLOVA, Luminous, Hermes, Granite, Arctic, Pangu, SenseNova, Zhinao, MiniCPM, XVERSE, Orion, OpenChat, Vicuna, Wizard, Zephyr, Dolphin, OpenOrca, Starling, BLOOM, RWKV, and Aya.

Adapter selection uses only model id/name (plus assistant message model/name on message end). Generic OpenAI-shaped APIs are not treated as OpenAI-family unless the model id/name matches a supported family.

## Uninstall

```bash
pi remove npm:pi-cache-optimizer
```

Then run `/reload` or restart Pi. Optional local stats cleanup:

| Platform | Delete local stats files |
|---|---|
| Linux / macOS / WSL | `rm -f ~/.pi/agent/pi-cache-optimizer-stats.json ~/.pi/agent/deepseek-cache-optimizer-stats.json` |
| Windows PowerShell | `Remove-Item -Force "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-stats.json", "$env:USERPROFILE\.pi\agent\deepseek-cache-optimizer-stats.json" -ErrorAction SilentlyContinue` |
| Windows Command Prompt | `del /f /q "%USERPROFILE%\.pi\agent\pi-cache-optimizer-stats.json" "%USERPROFILE%\.pi\agent\deepseek-cache-optimizer-stats.json" 2>nul` |

Do not delete `models.json` during cleanup; it contains your Pi model/provider configuration and is not owned by this package.

## Verify effect

1. Select a model whose provider exposes cache usage.
2. Send several similar turns in the same Pi session.
3. Watch the footer or run `/cache-optimizer stats`.
4. For third-party proxies, also run `/cache-optimizer doctor` and confirm sticky routing / session affinity on the proxy side.

## License

MIT
