# DeepSeek cache hit diagnosis for `pi-deepseek-cache-optimizer`

## Scope and sources

Local files inspected:

* `README.md`
* `extension.ts`
* `package.json`
* `/home/jiang/.pi/agent/settings.json`
* `/home/jiang/.pi/agent/models.json` (API keys redacted/not copied)
* Pi docs: `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
* Pi docs: `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
* Pi source: `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`
* Pi source: `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js`

External docs inspected:

* DeepSeek Context Caching guide: <https://api-docs.deepseek.com/guides/kv_cache>
* DeepSeek Context Caching launch/news page: <https://api-docs.deepseek.com/news/news0802>

## Concrete findings

### DeepSeek cache behavior

DeepSeek's docs say Context Caching is enabled by default and requires no code change. Cache hits are based on overlapping/identical prefixes from token 0, not middle-of-input matches. Current guide says a hit requires that the prefix was already persisted to disk and, because of Sliding Window Attention, each cached prefix is an independent complete unit; later requests only hit if they fully match a persisted cache prefix unit. Prefixes are persisted at request boundaries (end of user input and end of model output), and DeepSeek can also persist a common prefix after detecting it across multiple requests.

DeepSeek exposes cache accounting in `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens`. The launch page additionally says the cache storage unit is 64 tokens, contents below 64 tokens are not cached, hits are best-effort rather than guaranteed, cache construction takes seconds, and unused entries are cleared after hours to days.

Implication: a Pi cache optimizer can improve odds only by making a long prefix byte/token-identical across requests and by allowing enough repeated requests/time for persistence. It cannot guarantee high hit rates.

### Pi cache controls and reporting

Pi's OpenAI-compatible provider implementation:

* Reads `PI_CACHE_RETENTION=long` and resolves cache retention to `long`.
* For OpenAI-compatible payloads, sends:
  * `prompt_cache_key: options.sessionId` when `cacheRetention === "long" && compat.supportsLongCacheRetention` (or OpenAI API URL case),
  * `prompt_cache_retention: "24h"` when `cacheRetention === "long" && compat.supportsLongCacheRetention`.
* Sends session affinity headers only when `compat.sendSessionAffinityHeaders` is true: `session_id`, `x-client-request-id`, and `x-session-affinity`.
* Parses DeepSeek-style `usage.prompt_cache_hit_tokens` into Pi `usage.cacheRead`.

Pi docs (`models.md`) document `supportsLongCacheRetention` for OpenAI-compatible providers as enabling `prompt_cache_retention: "24h"`; docs also note provider-level `compat` applies to all models and model-level `compat` overrides/merges with provider compat. Pi extension docs say `before_provider_request` can inspect/replace the exact provider payload and is useful for debugging provider serialization/cache behavior.

### Local Pi DeepSeek config

Sanitized relevant config from `/home/jiang/.pi/agent/models.json`:

* Provider `deepseek`:
  * `baseUrl`: `https://api.deepseek.com/v1`
  * `api`: `openai-completions`
  * provider `compat`: `{ "thinkingFormat": "deepseek", "supportsLongCacheRetention": true, "sendSessionAffinityHeaders": true }`
  * model: `deepseek-v4-pro`
* Provider `aiapi`:
  * `baseUrl`: `https://aiapi.exe.xyz/v1`
  * `api`: `openai-completions`
  * provider `compat`: no cache/session-affinity flags
  * model `deepseek-v4-pro` has model `compat`: `{ "thinkingFormat": "deepseek", "supportsLongCacheRetention": true }`
  * model `deepseek-v4-pro` does **not** have `sendSessionAffinityHeaders` through provider or model compat.

`/home/jiang/.pi/agent/settings.json` currently has package `npm:pi-deepseek-cache-optimizer`, so the extension should load globally. Its `defaultProvider` is currently `otokapi`, not `deepseek`; if the user manually switches to `deepseek`/`aiapi`, this default is not directly relevant.

## Diagnosis of this project

Verdict: **the project is well-intentioned but incomplete/misleading, and it likely cannot deliver consistently high DeepSeek cache hit rates in Pi as written.** There is also a likely config/doc mismatch for non-`deepseek` provider IDs such as `aiapi`.

### 1. The README overstates `PI_CACHE_RETENTION=long` for DeepSeek

The extension sets `process.env.PI_CACHE_RETENTION = "long"`, which makes Pi send OpenAI-style `prompt_cache_key` and `prompt_cache_retention: "24h"` when `supportsLongCacheRetention` is true. That is useful for providers that implement OpenAI prompt cache controls.

However, DeepSeek's public Context Caching docs say caching is enabled by default and requires no code/interface changes. They document hit/miss accounting, prefix behavior, best-effort persistence, 64-token units, and expiry, but not OpenAI's `prompt_cache_key` or `prompt_cache_retention` as required DeepSeek controls. Therefore this extension's "long cache retention" claim is probably not a strong DeepSeek-specific guarantee. At best, DeepSeek ignores unknown/unsupported controls or a proxy supports them; at worst, it gives a false sense of control.

### 2. `sendSessionAffinityHeaders` works for provider `deepseek`, not for local `aiapi` DeepSeek

The README tells users to add `sendSessionAffinityHeaders` under provider `deepseek.compat`, and the extension only warns when `ctx.model?.provider === "deepseek"`.

Your local `deepseek` provider has `sendSessionAffinityHeaders: true`, so Pi will send session affinity headers there.

Your local `aiapi` provider's DeepSeek model has only `supportsLongCacheRetention: true`; it lacks `sendSessionAffinityHeaders`. If you are actually using `aiapi/deepseek-v4-pro`, no session affinity headers are sent. If the upstream/proxy routes identical-prefix calls across backend shards whose disk caches are not shared, cache hit rate can remain low even when prompt prefixes are stable. The extension will not warn because the provider id is `aiapi`, not `deepseek`.

### 3. System-prompt reordering is brittle and may not create as stable a prefix as promised

Pi's built-in `system-prompt.js` already puts the mostly stable core prompt, tools, guidelines, Pi docs, project context, and skills before date/current working directory. The dynamic date/cwd are already at the end. In Trellis sessions, additional injected task/session context can be dynamic and may not be represented in `systemPromptOptions` fields that this extension can reliably extract.

The extension attempts to rebuild a stable prefix by finding exact string candidates inside `event.systemPrompt` and moving them ahead of the remaining text. This has multiple weaknesses:

* It relies on exact string matching; any formatting differences, duplicated snippets, platform-injected text, or handler ordering can prevent extraction.
* It can duplicate/fragment content if candidates overlap (for example, long `contextFiles` handling pushes both `## path\n\ncontent` and raw `content`).
* It cannot stabilize previous conversation messages, tool results, or assistant/tool-call history; Pi sends those after the system prompt and they grow/change every turn.
* It cannot make different sessions/forks share the same full persisted prefix unit if the serialized message history diverges before a request-boundary persisted prefix.

So it may help with the system prompt prefix, but not necessarily enough to overcome DeepSeek's complete persisted prefix-unit matching requirements.

### 4. DeepSeek's current cache rules make low hits plausible in Pi even with no code bug

Pi coding-agent turns often include:

* changing user prompts,
* changing assistant/tool-call history,
* changing tool result text,
* dynamic Trellis/session context,
* model/provider switches,
* new/forked/compacted sessions.

DeepSeek docs emphasize identical prefix from token 0 and complete persisted prefix-unit matching. In multi-turn Pi sessions, the next request should theoretically share the previous entire conversation prefix up to the prior turn boundary, but cache can still miss if the previous unit has not persisted yet, if provider/proxy routing is not sticky, if a different backend/model/provider is used, if serialized replay differs, or if compaction/forking/new session changes the message sequence.

### 5. There may be an unsupported-config schema mismatch risk

Pi source's `OpenAICompletionsCompatSchema` shown in `model-registry.js` includes `supportsLongCacheRetention` but does not visibly include `sendSessionAffinityHeaders` in the schema block, while provider runtime code reads `compat.sendSessionAffinityHeaders`. Your current `models.json` apparently loads, so this may be tolerated by TypeBox defaults or by a newer schema path, but it is worth validating with `pi --list-models` or `/model` diagnostics if config load errors appear. If Pi silently rejects/ignores unknown fields in some versions, the affinity setting would not apply.

## Likely root causes of low cache hit in your setup

Most likely causes, ranked:

1. **Using `aiapi/deepseek-v4-pro` instead of direct `deepseek/deepseek-v4-pro`:** local `aiapi` DeepSeek config lacks `sendSessionAffinityHeaders`, and proxy routing may prevent reuse of the same DeepSeek disk cache shard.
2. **Provider/proxy does not expose or preserve DeepSeek cache semantics:** AIAPI may not forward DeepSeek's `prompt_cache_hit_tokens`, may not forward cache-affinity controls, may normalize requests differently, or may route across providers/backends.
3. **DeepSeek best-effort/persistence timing:** cache construction takes seconds; immediate repeated requests or parallel requests may miss.
4. **Pi dynamic context/history dominates:** extension only reorders the system prompt, while conversation/tool history and Trellis state still change; DeepSeek now requires complete persisted prefix-unit matches.
5. **The extension's claims are too broad:** DeepSeek public docs do not document `prompt_cache_retention: "24h"` or `prompt_cache_key` as necessary knobs; the project markets them as guaranteed long cache retention.

## Recommended next steps

1. **Run a direct A/B test with the direct `deepseek` provider.** Use `deepseek/deepseek-v4-pro`, keep the same session, wait a few seconds between turns, and inspect `/stats` `cacheRead` or raw `prompt_cache_hit_tokens`. Compare to `aiapi/deepseek-v4-pro`.
2. **Add `sendSessionAffinityHeaders: true` to the `aiapi` DeepSeek model/provider only if AIAPI supports/forwards such headers.** Because the README only configures provider `deepseek`, the extension does not cover this local provider. If AIAPI strips or ignores those headers, provider choice matters more than Pi config.
3. **Use a `before_provider_request` debug extension temporarily.** Log sanitized payload shape (no API keys) for one turn and verify that `prompt_cache_key`, `prompt_cache_retention`, `thinking`, and stable message ordering are actually present. Extension docs explicitly recommend this hook for cache serialization debugging.
4. **Do not rely on this extension alone for high hit rate.** For deterministic tests, put the large reusable content at the very beginning of the first user message or system prompt, repeat exactly, and wait for persistence. Avoid new sessions/forks/compaction/model switching during the test.
5. **Improve project docs/code if maintaining it:**
   * Change README from "maximizes cache hit"/"long cache retention automatically" to "best-effort; DeepSeek caching is automatic and prefix-based".
   * Document provider-specific config for proxies (`aiapi`, `openrouter`, etc.), not only `deepseek`.
   * Warn when active model id/baseUrl contains DeepSeek but provider id is not `deepseek` and cache-affinity compat is absent.
   * Add a `/deepseek-cache-debug` command or `before_provider_request` diagnostics mode that prints sanitized payload cache fields and current provider/model.
   * Consider using Pi's `context` or `before_provider_request` hooks to minimize volatile replay in controlled modes, but be careful: dropping conversation/tool history changes model behavior and is not a general safe optimization.
