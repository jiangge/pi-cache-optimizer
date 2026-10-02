# Pi Cache Optimizer

[![CI](https://github.com/jiangge/pi-cache-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/jiangge/pi-cache-optimizer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![npm downloads](https://img.shields.io/npm/dm/pi-cache-optimizer.svg)](https://www.npmjs.com/package/pi-cache-optimizer)
[![license](https://img.shields.io/npm/l/pi-cache-optimizer.svg)](./LICENSE)

[中文说明](./README.zh-CN.md)

Pi extension for improving provider-side KV / prompt cache hit rates. It keeps stable prompt content near the front, adds a conservative OpenAI-compatible `prompt_cache_key` fallback, warns about common proxy cache-routing gaps, and shows read-only footer cache stats.

> Renamed from `pi-deepseek-cache-optimizer`. Existing footer counters migrate automatically. The extension does **not** touch Pi's `models.json` during normal hook operation (default: `~/.pi/agent/models.json`; custom agent dirs use `PI_CODING_AGENT_DIR`). Only `/cache-optimizer fix` and `/cache-optimizer rollback` may edit it, both after an explicit interactive preview + confirmation with an automatic timestamped backup.

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [Commands](#commands)
- [Persistent opt-out](#persistent-opt-out)
- [Per-model `prompt_cache_key` opt-out](#per-model-prompt_cache_key-opt-out)
- [Opt-in deterministic tool ordering](#opt-in-deterministic-tool-ordering)
- [Footer cache stats mode](#footer-cache-stats-mode)
- [OpenAI-compatible proxy setup](#openai-compatible-proxy-setup)
- [Adaptive thinking models](#adaptive-thinking-models)
- [Auto-repair with `/cache-optimizer fix`](#auto-repair-with-cache-optimizer-fix)
- [DeepSeek protocol safety and rollback](#deepseek-protocol-safety-and-rollback)
- [Footer stats](#footer-stats)
- [Native virtual models (Pi 0.99+)](#native-virtual-models-pi-099)
- [For router / virtual-channel extension authors](#for-router--virtual-channel-extension-authors)
- [Uninstall](#uninstall)
- [Verify effect](#verify-effect)
- [License](#license)

## What it does

- Compresses Pi's skill list into a grouped Markdown list that keeps every skill name and description (only the XML envelope and repeated paths are removed), and strips session-overview churn. Both are in-place edits that never move content between Pi's prompt sections, and they also apply to OpenAI Responses/Codex models. (Earlier versions also lifted "stable" content to the front of the prompt; Pi >= 0.86 already orders its sections from stable to variable, and measured prefix stability was identical, so that step was removed.)
- Requests long cache retention when Pi/provider compat supports it.
- Adds a conservative session-id `prompt_cache_key` fallback for `openai-completions` proxy payloads when no effective key exists. Pi 1.0+ owns this field for Responses/Codex transports.
- Warns once for third-party OpenAI-compatible proxies missing cache/session-affinity compat flags.
- Detects adaptive-thinking compat for Claude (opus-4.6+ including Opus 5, sonnet-4.6+ including Sonnet 5, fable-5+) and Kimi Coding K3 / `kimi-for-coding` custom channels.
- Stores cache statistics in per-extension-instance atomic shards, so parent sessions, child Pi agents, and parallel Pi processes cannot overwrite one another.
- Shows current conversation-session provider/model footer stats by default; `total` aggregates all valid local shards for the exact provider/model.
- Supports optional router-extension integration through versioned global protocols (`Symbol.for("pi.routing.registry.v1")` and `Symbol.for("pi.cache.hints.v1")`) without importing router packages.
- Includes disabled-by-default deterministic ordering for verified built-in tool payloads.
- Supports Pi 0.99+ native virtual models (`pi.registerVirtualModel()`): request hooks, footer stats, and diagnostics act on the physical model each request is routed to.

Caching is provider-side and best-effort. Third-party proxies and router extensions can still hide cache usage, reject unsupported parameters, or route requests across multiple upstreams.

## Install

```bash
pi install npm:pi-cache-optimizer
```

If you previously installed the old package:

```bash
pi remove npm:pi-deepseek-cache-optimizer && pi install npm:pi-cache-optimizer
```

Run `/reload` in Pi after install/update/remove so extension hooks refresh.

On Pi 0.79.7 and newer, `pi update` updates Pi itself only. To update installed Pi packages such as this extension, run `pi update --extensions` (packages only) or `pi update --all` (Pi + packages).

This extension requires Pi 0.82+ and is validated against Pi 1.0.0. It uses the official Pi package types directly for type-checking, along with extension hooks, `getAgentDir()`, and prompt options shared by those versions; it does not depend on Pi 0.83+ APIs such as `ctx.scopedModels` or the bundled TypeBox 1.3 aliases. Native virtual model support and codemode nested-call coalescing activate only on Pi 0.99+ hosts that produce them; older hosts keep the previous behavior. The local development baseline uses Node.js 22.19.0 or newer, matching Pi 1.0.0's engine requirement.

## Commands

| Command | Effect |
|---|---|
| `/cache-optimizer` | Interactive menu when UI supports it; otherwise prints help and current state. |
| `/cache-optimizer enable` | Enables runtime optimizations for the current Pi process, resets local footer stats, and starts a fresh “enabled” measurement. |
| `/cache-optimizer disable` | Disables optimization for the current Pi process, resets local footer stats, and keeps collecting footer stats in disabled comparison mode. Run `/reload` or restart Pi to return to startup behavior. |
| `/cache-optimizer doctor` | Shows active model/provider/API/base URL/compat plus low-hit diagnosis. |
| `/cache-optimizer compat` | Shows copyable compat advice for the active model, if applicable. |
| `/cache-optimizer stats` | Shows detailed counters for every cache-adapter-matched model used by the current conversation session today. |
| `/cache-optimizer stats all` | Shows detailed per-model totals across all valid local sessions/shards today, including request and token counts. |
| `/cache-optimizer stats contributors` | Shows current/other contributing sessions for the active exact provider/model without exposing session ids. |
| `/cache-optimizer reset` | Resets local footer stats for the active provider/model; upstream provider cache is not modified. |
| `/cache-optimizer config footer-mode total\|session\|process` | Persist the footer stats mode. Persistent command configuration overrides the environment variable. |
| `/cache-optimizer fix` | Auto-repairs safe compat issues for the active model. Shows preview + risk warning, requires confirmation. It writes `models.json` only for native compat fixes, or the extension config for an evidenced `prompt_cache_key` issue. |
| `/cache-optimizer fix prompt-cache-key` | Explicitly configures the active OpenAI-compatible provider/model to omit `prompt_cache_key` and `promptCacheKey` from the final request body. Requires confirmation. |
| `/cache-optimizer rollback` | Reviews the latest matching confirmed fix and, after UI confirmation, restores either the extension config or `models.json` fix safely. |

`/cache-optimizer` uses Pi's native Tab completion. Type `/cache-optimizer <Tab>` for the supported subcommands, `/cache-optimizer stats <Tab>` for `all` or `contributors`, `/cache-optimizer fix <Tab>` for `prompt-cache-key`, `/cache-optimizer c<Tab>` for `config`, `/cache-optimizer config <Tab>` for `footer-mode`, and `/cache-optimizer config footer-mode <Tab>` for `total`, `session`, or `process`. Suggestions are prefix-filtered and invalid prefixes are left to Pi's normal fallback behavior.

The interactive `/cache-optimizer` menu includes `Footer mode`, where you can choose `total`, `session`, or `process`. `enable` / `disable` are current-process switches. For a persistent opt-out, use environment variables below.

## Persistent opt-out

| Env var | Effect |
|---|---|
| `PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1` | Disable prompt mutations only; footer stats and cache-key fallback remain active. |
| `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` | Explicitly allow native virtual prompt rewriting only when the routing registry exposes a non-Responses, non-Codex candidate chain. Unknown or incomplete routes remain unchanged. |
| `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` | Keep Pi's verbose skill XML. |
| `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` | Disable the OpenAI-compatible `prompt_cache_key` fallback. Preferred explicit opt-out. |
| `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` | Disable the same fallback via the legacy inverse switch. Values `0`, `false`, `no`, or `off` disable it. |

Persistent feature settings are managed under the Pi agent directory by the native command interface. They take precedence over their corresponding environment variables:

```text
/cache-optimizer config prompt-rewrite on|off
/cache-optimizer config virtual-rewrite on|off
/cache-optimizer config skill-compression on|off
/cache-optimizer config openai-cache-key on|off
/cache-optimizer config tool-order on|off
/cache-optimizer config footer-mode total|session|process
/cache-optimizer config reset
```

`config reset` removes persistent feature overrides while preserving the existing footer mode and model-specific prompt-cache-key settings. These commands do not modify shell startup files or `PI_CACHE_RETENTION`; `enable` and `disable` remain current-process runtime switches.

## Opt-in deterministic tool ordering

`PI_CACHE_OPTIMIZER_TOOL_ORDER=1` enables deterministic ordering for verified tool definitions in Pi's built-in OpenAI Completions, Anthropic, Google, and Bedrock payload shapes. Truthy values are `1`, `true`, `yes`, or `on` (case-insensitive). The feature is off by default, process-local, and suppressed by `/cache-optimizer disable`.

Tools are sorted by exact name with their original index as the stable tie-breaker. The normalizer shallow-clones only the verified object/array path that changes. Tool objects and unrelated request fields retain their identity, including Google/Vertex `AbortSignal`; tool schemas, choices, routing fields, and caller input are preserved.

For safety, payloads with any top-level tool `cache_control` marker or Anthropic `defer_loading` grouping are unchanged. Unknown/custom APIs, malformed tools, missing names, and unsupported shapes are also unchanged. The pure helper recognizes OpenAI Responses fixtures, but the request hook preserves the existing Responses/Codex bypass and does not reorder those requests.

Rollback is immediate: unset the variable (or set a non-truthy value) and run `/reload`. To verify the transformation with local fixtures without contacting a provider, run:

```bash
bun .trellis/tasks/09-03-context-epoch-tool-ordering/verify.ts
```

The fixture verifier reports numeric tool-order changes and confirms cache-marked payloads remain unchanged. Because it does not contact a provider, provider cache usage is explicitly unavailable and no synthetic cache hit is claimed.

## Footer cache stats mode

Current versions store stats under `pi-cache-optimizer-stats.d/shards/` in Pi's agent directory. Each loaded extension instance owns one UUID-named shard and writes it through temp-file + atomic rename. This prevents parent/child/parallel Pi processes from overwriting one another. Upgrading from the old v6 single-file format deletes the old local stats files and starts footer counters from zero; upstream provider caches are not affected.

The footer defaults to `session`, which reflects the current Pi conversation rather than another parallel Pi terminal using the same provider/model. Use either the command or environment variable to select the scope:

| Value | Effect |
|---|---|
| `session` (default) | Aggregate today's shards carrying the current hashed Pi conversation session id and exact provider/model. A reload creates a new instance shard but remains in the same session scope. |
| `total` | Aggregate today's valid local shards for the exact provider/model across sessions, including child Pi agents that load this extension and share the same agent directory. |
| `process` | Show only counters collected by the current extension instance. It starts at `0/0` after Pi restart or extension reload. |

Persistent command configuration takes precedence over the environment variable:

```text
/cache-optimizer config footer-mode total
/cache-optimizer config footer-mode session
/cache-optimizer config footer-mode process
```

The explicit setting is stored in `pi-cache-optimizer-config.json` under Pi's agent directory. If no command override exists, `PI_CACHE_OPTIMIZER_FOOTER_MODE=total|session|process` is used; values are case-insensitive, and missing or invalid values fall back to `session`. To return an existing installation to environment-controlled behavior, manually delete `pi-cache-optimizer-config.json` and run `/reload`.

## Per-model `prompt_cache_key` opt-out

Some OpenAI-compatible Completions endpoints reject `prompt_cache_key` with HTTP 400 even though the same field is valid for other providers. Pi 1.0.0 owns the key for Responses/Codex transports; this extension's key opt-out and fallback apply only to `openai-completions`. Pi 1.0.0 has no native `supportsPromptCacheKey` compat field; do **not** add that unknown field to `models.json`. `supportsLongCacheRetention` is not an equivalent switch and should not be used for this purpose.

When the extension observes an explicit field-level `prompt_cache_key` unsupported error for the exact provider/model, ordinary `/cache-optimizer fix` offers a confirmed model-scoped repair. Value-validation failures and conditional restrictions such as “not allowed when temperature is set” do not qualify. If concurrent responses from different models cannot be correlated because Pi provides no request ID, header-only evidence is ignored unless the finalized assistant message supplies exact provider/model identity. If you already know that the endpoint rejects the field, use the explicit command:

```text
/cache-optimizer fix prompt-cache-key
```

The preview explains that the setting is stored in the extension-owned `pi-cache-optimizer-config.json`. After confirmation, the final `before_provider_request` stage removes both `prompt_cache_key` and `promptCacheKey`, including a key that Pi core supplied earlier. This can reduce provider prompt-cache hits for that exact model, while other models retain the existing fallback behavior. The file is updated atomically without overwriting a concurrently created config, a privacy-safe backup/receipt is created, and `/reload` or a Pi restart is required. `/cache-optimizer rollback` restores the previous extension configuration without resetting `footerMode`; it binds the previewed receipt by file identity and hash, refuses a replaced receipt, and compensates the config if receipt marking fails.

## OpenAI-compatible proxy setup

Third-party `openai-completions` proxies (LiteLLM / OneAPI / NewAPI / OpenRouter-like channels) often route one session across multiple upstream backends. That splits provider-side prompt caches.

Pi 0.84.1 also fixes built-in Fireworks compatibility for models that reject `prompt_cache_retention`; the extension avoids provider-name special cases and resolves exact provider/model compat from `models.json` plus the runtime model. Pi 0.81+ also has a built-in `llama.cpp` provider using an OpenAI-shaped transport. The extension keeps its session-id key fallback for third-party `openai-completions` channels, while Pi 1.0+ owns the key for Responses/Codex transports. The built-in provider's explicit compat fingerprint is excluded from generic proxy routing/session-affinity advice, but a custom or overridden provider that merely reuses the id `llama.cpp` is treated like any other OpenAI-compatible channel. `prompt_cache_retention` remains subject to the normal safety rule: keep it only for official OpenAI or an explicit effective `supportsLongCacheRetention: true` opt-in in `models.json`; otherwise strip it before sending. The extension-owned `pi-cache-optimizer-config.json` stores per-model key opt-outs only for `openai-completions`.

For real proxies, start with session affinity:

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
- Do not add `supportsPromptCacheKey` to `models.json`: Pi 1.0.0 does not define that compat field. Use `/cache-optimizer fix prompt-cache-key` to store an exact provider/model omit rule in the extension-owned config; it removes both key spellings, including a key supplied by Pi.
- If you see `400 Unsupported parameter: prompt_cache_retention`, remove/avoid `supportsLongCacheRetention` for that channel. Keep `sendSessionAffinityHeaders` if supported. The extension detects the explicit error from response headers or the finalized assistant error message and strips the parameter from subsequent requests in the current process.
- Use `/cache-optimizer compat` or `/cache-optimizer doctor` to see model-specific advice.
- DeepSeek model names select the `DS cache` adapter only; they do not prove a reasoning wire protocol. Generic cache/routing advice remains active for absent or non-DeepSeek formats. DeepSeek replay advice is shown only when effective `compat.thinkingFormat: "deepseek"` is explicitly configured; it never treats `thinkingFormat` as a missing fix key.
- Do not add `thinkingFormat: "deepseek"` merely because a model id contains `deepseek`; `openai`, `qwen`, `openrouter`, `together`, or no explicit format are all valid catalog cases.
- This extension's `doctor` and `compat` commands only advise; they do not modify `models.json`.

## Anthropic cache TTL compatibility

Anthropic processes cache breakpoints in `tools → system → messages` order and rejects a `ttl: "1h"` breakpoint that appears after a 5-minute breakpoint. An ephemeral `cache_control` without `ttl` uses the default 5-minute retention.

For every `anthropic-messages` channel, the extension checks the final serialized payload and immediately downgrades a visibly invalid short-to-long transition. Legal long-only and `1h → 5m` payloads remain unchanged, including third-party endpoints that genuinely support 1-hour retention.

Some proxies rewrite or insert hidden 5-minute breakpoints after Pi's request hook. If a provider returns Anthropic's explicit TTL-ordering error, the extension records a process-local provider/model fallback so the next subsequent request uses the default 5-minute TTL. This error is a non-retryable HTTP 400 in Pi 0.82.1, so the extension does not claim that Pi's automatic retry will rerun the failed turn; if another layer retries it, that retry also uses the fallback. `/cache-optimizer doctor` reports the fallback and `/cache-optimizer fix` can persist a model-scoped `supportsLongCacheRetention: false` with the normal confirmation/backup flow. Other 400 errors and prompt-too-long failures do not activate this fallback. The runtime observation lasts until the current process exits and survives extension reloads within that process.

## Adaptive thinking models

Claude models from opus-4.6 / sonnet-4.6 (including Opus 5 and Sonnet 5) / fable-5 onwards require `forceAdaptiveThinking: true` in compat. Kimi Coding K3 (`k3`) and `kimi-for-coding` also use adaptive thinking and need `allowEmptySignature: true` so replayed empty-signature thinking blocks remain valid. Without the required compat, Pi may send a legacy thinking payload or replay thinking incorrectly. Pi 0.83+ native Opus 5 catalogs are covered by the same adaptive-thinking detection; custom `anthropic-messages` channels still need the compat flag when Pi does not provide it.

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
        { "id": "claude-sonnet-5", "name": "Claude Sonnet 5" }
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
        "claude-sonnet-5": {
          "compat": {
            "forceAdaptiveThinking": true
          }
        }
      }
    }
  }
}
```

For Kimi Coding K3 custom channels, use model-level compat when the provider contains mixed models:

```json
{
  "providers": {
    "your-kimi-coding-channel": {
      "modelOverrides": {
        "k3": {
          "compat": {
            "forceAdaptiveThinking": true,
            "allowEmptySignature": true
          }
        }
      }
    }
  }
}
```

Pi 0.80.9+ already includes Kimi K3 in built-in Kimi Coding, Moonshot AI / China, OpenRouter, and Vercel AI Gateway catalogs. The Moonshot/OpenRouter variants use their OpenAI-compatible transport and continue through the normal Kimi footer/proxy path; the adaptive compat above applies only to `anthropic-messages` Kimi Coding channels.

`/cache-optimizer doctor` and `/cache-optimizer compat` detect missing flags and show copyable JSON.

## Auto-repair with `/cache-optimizer fix`

**v2.6.0+** adds a `fix` subcommand that can auto-repair safe compat issues:

- Adaptive thinking (`forceAdaptiveThinking: true`; Kimi Coding K3 / `kimi-for-coding` also `allowEmptySignature: true`)
- DeepSeek Pi Mono replay compat (`requiresReasoningContentOnAssistantMessages: true` only when `thinkingFormat: "deepseek"` is already explicit; `/fix` never invents that format)
- OpenAI-compatible proxy session affinity (`sendSessionAffinityHeaders: true` for `openai-completions`). Pi 0.80.7+ controls `openai-responses` header shape with `sessionAffinityFormat` and auto-detects its default; this extension no longer writes the removed `sendSessionIdHeader` field.

**Scope:** the fix starts from the currently active model. An affinity-only repair can write provider-level compat once for all applicable models on that provider, including models absent from `models[]` when the provider entry already exists and no higher-priority setting shadows it. Explicit per-model `false` remains an opt-out. Other or ambiguous repairs stay model-scoped.

**Safety:**

1. Shows full preview of changes (file path, edit location, JSON to write, risks)
2. Warns: ① changes affect all sessions using that channel, ② automatic backup created at `models.json.backup-cache-optimizer-<timestamp>`, ③ Pi reload required
3. Uses comment-preserving surgical editor — existing comments, indentation, and existing key order are preserved
4. Requires explicit user confirmation (interactive prompt or `ui.select`)
5. Writes and restores atomically (temp + rename); self-validates after write
6. Preserves the existing `models.json` access mode exactly — it does not tighten or loosen permissions (for example, `0600` stays `0600`, `0644` stays `0644`)
7. Writes a privacy-safe, versioned receipt atomically only after a successful write; the receipt contains transaction/model identity, placement, scalar compat before/after values, file hashes, backup filename, timestamps/status, and no credentials or request data
8. Uses unique, non-overwriting backup names and falls back to manual guidance if the JSONC scanner cannot confidently locate the target

Existing `modelOverrides[modelId]` entries have Pi's highest precedence, so `fix` repairs them directly. For built-in or API-login models without a custom `models[]` entry, an affinity-only fix prefers provider-level compat when the existing provider is safely locatable and no higher-priority explicit/runtime value shadows it; otherwise `fix` creates a compat-only `modelOverrides` entry instead of inventing a custom model definition. Runtime-observed provider failures are always written to that highest-precedence model override so extension-provided runtime compat cannot shadow the repair. Self-validation checks the full provider → custom model → runtime model → modelOverride result and rejects an ineffective lower-layer edit.

**Non-interactive mode:** refuses to write; shows manual edit guidance instead.

**Run:** `/cache-optimizer fix` when the active model has detected compat issues. Affinity-only missing-compat notifications are shown once per provider per extension instance and point to this confirmed command; model-specific warnings remain separate. The command shows "nothing to fix" when compat is already complete.

## `/cache-optimizer rollback`

Rollback is available through completion, direct execution, and the interactive menu. It always requires UI confirmation; without an interactive UI it gives manual-review guidance and does not write. The command selects the latest unapplied receipt for the active provider/model (or any active model on that provider for a provider-level receipt), validates the recorded backup and current file hashes, creates a new access-mode-preserving rollback backup, and uses temp-file + atomic rename. Fix and rollback transactions are serialized across extension instances; rollback also binds the receipt transaction id/hash from preview through commit and refuses if another transaction replaces it.

If `models.json` is unchanged since the fix, rollback can restore the exact pre-fix JSONC. If the file changed, it never blindly replaces it: it may restore only receipt-owned scalar compat keys whose recorded post-fix values are still present, preserving later user changes. If a receipt-owned key changed, the target was removed/moved, or the fix created a new target entry, it refuses and points to the recorded backup for manual review. Successful rollback marks the receipt and requires `/reload` or a restart.

### Channels without a `models.json` provider entry

Some Pi channels may be available even when there is no provider block in Pi's agent `models.json` yet (default: `~/.pi/agent/models.json`; with `PI_CODING_AGENT_DIR`, use `$PI_CODING_AGENT_DIR/models.json`). Keep existing authentication as-is and do not copy credentials, tokens, or API keys. Add only cache/routing compatibility overrides in `models.json`.

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

Pi Cache Optimizer resolves effective compat using Pi's precedence (`provider.compat` → matching `models[].compat` → runtime model compat → `modelOverrides[modelId].compat`). This also covers extension providers that replace their model list and accidentally omit lower-level compat from the runtime model object. For non-official `openai-completions` channels, when effective `sendSessionAffinityHeaders` is `true` but Pi's runtime model lost it, the extension restores Pi-compatible affinity headers at request time without overwriting existing headers. An explicit `false` remains a respected opt-out.

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

## DeepSeek protocol safety and rollback

Pi's model-family name and its reasoning wire protocol are separate. A DeepSeek-named model using an OpenAI-compatible endpoint may send standard top-level `reasoning_effort`, DeepSeek-style `thinking`, or another provider-specific format. `supportsReasoningEffort: true` alone is not proof either way. `/cache-optimizer fix` therefore never invents `thinkingFormat: "deepseek"`; configure an explicit `thinkingFormat` only when the endpoint documentation or an explicit provider signal supports it.

The novice-safe workflow is staged:

1. Run `/cache-optimizer fix` for protocol-neutral cache/routing repairs such as session affinity. It shows the exact placement and requires confirmation.
2. Make a normal request. If an OpenAI-compatible DeepSeek-like model explicitly rejects the `thinking` parameter in favor of `reasoning_effort`, the extension keeps only a model-scoped, process-local category. It does not persist or display the complete provider error, send a hidden probe, or edit configuration from a response hook.
3. Run `/cache-optimizer fix` again to review an evidence-based model-level protocol repair. It is written through the highest-precedence `modelOverrides[modelId].compat` layer and validated against runtime compat, so an extension-provided model cannot silently shadow it. A provider-level change is never broadened from a model name alone. Explicit `openai`, `qwen`, `openrouter`, and `together` formats remain respected.
4. If the latest confirmed fix caused the problem, run `/cache-optimizer rollback`. Rollback always requires UI confirmation.

Every successful interactive fix writes one atomic, versioned receipt at `pi-cache-optimizer-fix-receipt.json`. It contains only a transaction id, provider/model identity, placement, changed scalar compat keys with before/after values, file hashes, backup filename, and timestamps/status. It never stores API keys, credentials, prompts, payloads, headers, response bodies, or raw errors.

Rollback creates a new access-mode-preserving backup and uses atomic replacement. If `models.json` is unchanged since the fix and the receipt backup matches the pre-fix hash, it can restore the exact pre-fix file. If the file changed, it only reverts receipt-owned scalar keys that still have their recorded post-fix values and preserves unrelated user changes; otherwise it refuses safely and points to the recorded backup for manual review. The receipt is marked rolled back after validation, and `/reload` or a restart is required.

## Footer stats

Stats are read-only local counters stored as UUID-owned shards under `pi-cache-optimizer-stats.d/shards/` in Pi's agent directory (custom agent dirs use `PI_CODING_AGENT_DIR`). Shards contain only dates, opaque session hashes, exact provider/model counters, reset epochs, and process lifecycle metadata — no API keys, prompts, payloads, headers, responses, or model output. The footer defaults to the current conversation session; `total` aggregates all valid current-day shards for the exact provider/model, and `process` shows only the current extension instance. Footer mode configuration is stored separately in `pi-cache-optimizer-config.json`. Upgrading from the old v6 shared stats files deletes those local counters instead of migrating them.

Pi 0.79+ also includes a built-in footer `CH` marker for the latest prompt cache hit rate. This extension complements that marker with persisted provider/model counters plus proxy compat diagnostics.

Example footer:

```text
· OpenAI cache 3/10·0.002M/0.005M 40.0% ⚠️ compat
```

The leading `· ` is owned by this extension and separates its status from statuses published by other extensions in the same footer. It is present for normal, disabled, router-restored, and warning-suffixed statuses. The compact footer format is `<label> <hit requests>/<total requests>·<cached input tokens>/<total input tokens> <token hit rate>`; token hit rate keeps one decimal place and the footer omits the redundant `tok` suffix. `/cache-optimizer stats` lists detailed current-session models; `/cache-optimizer stats all` lists all local models and includes compact summaries such as `4/5·0.66M/0.84M 78.7%`. Some adapters may also append `·write <tokens>`, and runtime diagnostics may append `⚠️ compat` or `⚠️ integrity`.

Supported footer labels include: DS, Claude, OpenAI, Gemini, Kimi, Qwen, GLM, MiniMax, Mimo, Hunyuan, Mistral, Grok, Llama, Nemotron, Cohere, Yi, Doubao, ERNIE, Baichuan, StepFun, Spark, InternLM, Gemma, Phi, Jamba, Solar, Sonar, Nova, Reka, Falcon, DBRX, MPT, StableLM, Aquila, EXAONE, HyperCLOVA, Luminous, Hermes, Granite, Arctic, Pangu, SenseNova, Zhinao, MiniCPM, XVERSE, Orion, OpenChat, Vicuna, Wizard, Zephyr, Dolphin, OpenOrca, Starling, BLOOM, RWKV, and Aya.

Adapter selection uses only model id/name (plus assistant message model/name on message end). Generic OpenAI-shaped APIs are not treated as OpenAI-family unless the model id/name matches a supported family.

## Native virtual models (Pi 0.99+)

Pi 0.99 lets extensions register virtual models with `pi.registerVirtualModel()`. While one is selected, `ctx.model` stays the virtual model (`api: "pi-virtual"`) and Pi routes every request to a physical model. This extension follows the physical model automatically; router authors do not need the protocol below.

- Request hooks read the dispatched model id from the provider payload and match it against physical models with configured credentials. The `prompt_cache_key` fallback, `prompt_cache_retention` safety, Anthropic TTL repair, and per-model `prompt_cache_key` omit rules then apply to that physical model. If several credentialed providers share the id and would be treated differently, the extension does not guess; identity-dependent request changes are skipped.
- Footer stats and `/cache-optimizer doctor`, `compat`, `stats`, `reset`, and `fix` use the physical model that answered last on the current session branch, matching Pi's own routed-model display and context limits. Doctor and compat name both the virtual selection and that physical model.
- Before Pi routes the first request, the footer stays empty and diagnostics ask you to send a prompt first.
- Prompt rewriting is skipped for virtual selections by default: Pi picks the physical model after the system prompt is built, and the rewritten prompt is not sent to a route whose backend is unknown. `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` is an explicit opt-in only when the routing registry exposes a complete candidate chain and every candidate is a known non-Responses, non-Codex transport; unknown or incomplete routes remain unchanged.
- The session-affinity header bridge is skipped as well, because Pi builds request headers before the payload exists. Pi still sends the physical model's own configured affinity headers.

## For router / virtual-channel extension authors

If your Pi extension provides a virtual routing provider (for example [`pi-router`](https://github.com/jiangge/pi-router)'s `router/auto`, `router/smart`, or a profile/channel that forwards to a real upstream), this extension can show cache stats for the real upstream provider/model instead of the virtual shell. Integration is optional, versioned, and does **not** require importing this package.

For [`pi-router`](https://github.com/jiangge/pi-router), use a current release that implements `pi.routing.registry.v1`. Direct `router/*` selections continue to use the normal prompt optimizer. When a native Pi 0.99+ virtual model is routed through a registry-aware router, the optional `PI_CACHE_OPTIMIZER_VIRTUAL_REWRITE=1` path inspects the router's candidate chain before rewriting; candidates using OpenAI Responses/Codex APIs, incomplete metadata, and unavailable route information fail closed.

### Minimum integration: final assistant message metadata

For seamless final cache-stat attribution, relay the real upstream identity on completed assistant messages:

```ts
{
  role: "assistant",
  provider: "anthropic",              // real upstream provider
  responseModel: "claude-opus-4-8",   // or model: "..."
  api: "anthropic-messages",          // upstream Pi API id when known
  usage: {
    input: 1200,       // Pi-normalized uncached input tokens, if available
    cacheRead: 8000,   // tokens read from provider prompt cache
    cacheWrite: 500,   // tokens newly written to provider prompt cache
  },
}
```

`message_end` treats these assistant-message fields as authoritative. If `provider` + `model`/`responseModel` + cache usage are present, stats update the upstream bucket even when the active model is still `router/auto`. If upstream usage does not expose cache fields, leave them absent/zero; this extension will not fake cache hits.

### Optional: live route registry for pre-response UX

Final message metadata is enough for post-response stats. For pre-response flows — footer display before the first response, `/cache-optimizer doctor`, `/cache-optimizer compat`, `/cache-optimizer reset`, and the `openai-completions` `prompt_cache_key` fallback — register a live route adapter under `Symbol.for("pi.routing.registry.v1")`.

Protocol shape:

```ts
type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: { sessionIdHash?: string; requestId?: string },
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};
```

Registration pattern:

```ts
const ROUTING = Symbol.for("pi.routing.registry.v1");
const registry = (globalThis as Record<symbol, unknown>)[ROUTING] as
  | { version: 1; registerRouter(adapter: PiRouterAdapterV1): () => void }
  | undefined;

registry?.registerRouter({
  virtualProvider: "router",
  resolveActiveRoute(virtualModelId, hint) {
    return {
      virtualProvider: "router",
      virtualModelId,
      provider: "deepseek",
      modelId: "deepseek-v4",
      api: "openai-completions",
      sessionIdHash: hint?.sessionIdHash,
      timestamp: Date.now(),
    };
  },
});
```

Do not overwrite an existing registry. If your extension loads before this optimizer, retry registration on `session_start` or create the same V1 registry shape only if no registry exists.

### Optional: query-scoped cache hints

Routers that forward to an inner Pi request path can read query-scoped hints from `Symbol.for("pi.cache.hints.v1")`:

```ts
const CACHE_HINTS = Symbol.for("pi.cache.hints.v1");
const hints = (globalThis as Record<symbol, any>)[CACHE_HINTS]?.getHints?.({
  sessionIdHash,
  virtualProvider: "router",
  virtualModelId: "auto",
  upstreamProvider: "deepseek",
  upstreamModelId: "deepseek-v4",
  api: "openai-completions",
});
```

When the query matches the current session/route, `hints` may contain `systemPrompt`, `promptCacheKey`, and `cacheRetention: "long"`. Treat these as advisory and sensitive: do not log them, do not expose prompt text, and do not overwrite an existing request-level `prompt_cache_key` / `promptCacheKey`.

### Security and correctness rules

- Do not import `pi-cache-optimizer`; use `Symbol.for(...)` discovery only.
- Do not expose API keys, prompts, payloads, headers, response bodies, or model output in route snapshots or logs.
- Use assistant-message metadata for final attribution; live registry data is advisory and may be stale by response time.
- Preserve truthful usage. Missing cache usage should show as 0/under-reported, not as synthetic hits.

## Uninstall

```bash
pi remove npm:pi-cache-optimizer
```

Then run `/reload` or restart Pi. Optional local state cleanup (if you use `PI_CODING_AGENT_DIR`, delete the same files from that directory instead):

| Platform | Delete local state files |
|---|---|
| Linux / macOS / WSL | `rm -rf ~/.pi/agent/pi-cache-optimizer-stats.d ~/.pi/agent/pi-cache-optimizer-stats.json ~/.pi/agent/deepseek-cache-optimizer-stats.json ~/.pi/agent/pi-cache-optimizer-config.json` |
| Windows PowerShell | `Remove-Item -Recurse -Force "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-stats.d", "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-stats.json", "$env:USERPROFILE\.pi\agent\deepseek-cache-optimizer-stats.json", "$env:USERPROFILE\.pi\agent\pi-cache-optimizer-config.json" -ErrorAction SilentlyContinue` |
| Windows Command Prompt | `rmdir /s /q "%USERPROFILE%\.pi\agent\pi-cache-optimizer-stats.d" & del /f /q "%USERPROFILE%\.pi\agent\pi-cache-optimizer-stats.json" "%USERPROFILE%\.pi\agent\deepseek-cache-optimizer-stats.json" "%USERPROFILE%\.pi\agent\pi-cache-optimizer-config.json" 2>nul` |

Do not delete `models.json` during cleanup; it contains your Pi model/provider configuration and is not owned by this package.

## Verify effect

1. Select a model whose provider exposes cache usage.
2. Send several similar turns in the same Pi session.
3. Watch the footer or run `/cache-optimizer stats`.
4. For third-party proxies, also run `/cache-optimizer doctor` and confirm sticky routing / session affinity on the proxy side.

### Provider usage comparison

For a real, offline comparison with a provider such as `xiaojimao/gpt-6-sol`, first capture two separate windows in the same model and session. Do not treat an existing aggregate shard as a baseline: it does not record which optimizer features were enabled.

Capture the current optimized/default window:

```bash
node --import jiti/register benchmarks/snapshot-provider-usage.ts \\
  optimized xiaojimao gpt-6-sol YYYY-MM-DD > optimized.jsonl
```

For a baseline window, start a fresh Pi session with prompt mutations disabled, then send the same kind of repeated turns:

```bash
PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1 \\
PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1 \\
PI_CACHE_OPTIMIZER_TOOL_ORDER=0 \\
pi
```

After the baseline window, take a dated snapshot using the same model and agent directory:

```bash
node --import jiti/register benchmarks/snapshot-provider-usage.ts \\
  baseline xiaojimao gpt-6-sol YYYY-MM-DD > baseline.jsonl
cat baseline.jsonl optimized.jsonl > provider-usage.jsonl
npm run benchmark:provider -- provider-usage.jsonl
```

This compares real provider-reported `cacheRead`, `cacheWrite`, request hit rate, and input-token ratios. It is still observational: snapshots are aggregate counters, so they cannot prove feature-level causality. For feature isolation, repeat the window with only one of prompt rewrite, skill compression, or tool ordering enabled. The scripts never send provider requests and never claim cache hits when usage fields are absent.

## License

MIT
