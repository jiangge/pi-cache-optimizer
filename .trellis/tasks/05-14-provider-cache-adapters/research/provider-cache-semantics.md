# Provider cache semantics for Pi cache adapters

Date: 2026-05-14

Purpose: inform a provider-specific adapter design for `pi-deepseek-cache-optimizer` without assuming that DeepSeek KV cache behavior applies to other providers.

Sources used:

- DeepSeek KV cache guide: https://api-docs.deepseek.com/guides/kv_cache
- DeepSeek chat completion API reference: https://api-docs.deepseek.com/api/create-chat-completion
- Anthropic prompt caching docs: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- OpenAI prompt caching guide: https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI cookbook Prompt Caching 101: https://developers.openai.com/cookbook/examples/prompt_caching101
- Google Gemini API context caching: https://ai.google.dev/gemini-api/docs/caching
- Vertex AI context cache overview: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview
- LiteLLM prompt caching docs (proxy/aggregator reference): https://docs.litellm.ai/docs/completion/prompt_caching
- Local Pi docs reviewed: `docs/models.md`, `docs/session-format.md` in installed `@earendil-works/pi-coding-agent`

## Project/Pi baseline

Current extension behavior:

- Reorders Pi's generated system prompt so stable content appears before dynamic task/git/session context.
- Sets `PI_CACHE_RETENTION=long` at extension load.
- Warns only for DeepSeek-like model ids/names about missing `supportsLongCacheRetention` and session-affinity compat.
- Footer stats count only assistant responses whose model id/name contains `deepseek` and whose Pi-normalized usage exposes `usage.cacheRead`.
- Persisted local stats store only counters and local date.

Relevant Pi capabilities from local docs:

- Pi normalizes message usage as `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`.
- For OpenAI-compatible models, compat includes:
  - `cacheControlFormat: "anthropic"` for providers exposing Anthropic-style `cache_control` on text/tool blocks.
  - `supportsLongCacheRetention`: when `PI_CACHE_RETENTION=long`, Pi sends `prompt_cache_retention: "24h"` for OpenAI prompt caching, or `cache_control.ttl: "1h"` for Anthropic-style markers.
  - `openRouterRouting` and similar provider-routing options are passed through, but routing/fallback can change provider semantics.
- Pi changelog notes existing normalization for OpenRouter `cached_tokens`, OpenAI `prompt_tokens_details.cache_write_tokens`, Google/Vertex `cachedContentTokenCount`, direct OpenAI `prompt_cache_key`/`prompt_cache_retention`, and Anthropic breakpoints; adapter design should use Pi-normalized fields when available and avoid duplicating Pi transport logic unless extension hooks expose safe request mutation.

## DeepSeek official API prompt/KV cache

### 1. Activation/control semantics

- Cache is server-side and automatic. DeepSeek says every user request triggers construction of a hard-disk cache.
- Subsequent requests can hit when they have overlapping prefixes with previous requests, but the hit rules are prefix-unit based rather than arbitrary substring matching.
- A cache hit requires the corresponding prefix to have already been persisted as an independent cache prefix unit.
- Prefix units are persisted at request boundaries (end of user input and end of model output), by common-prefix detection across multiple requests, and at fixed token intervals for long inputs/outputs.
- DeepSeek chat API exposes `user_id`, documented as usable for KVCache isolation for privacy management.
- DeepSeek API is OpenAI-compatible for chat completions, but cache usage fields are DeepSeek-specific in `usage` rather than OpenAI `prompt_tokens_details.cached_tokens`.

### 2. TTL/retention behavior

- Cache construction takes seconds.
- Once the cache is no longer in use, it is automatically cleared, usually within a few hours to a few days.
- The docs characterize the cache system as best-effort and not a 100% hit guarantee.
- No explicit public per-request TTL parameter was found in DeepSeek docs; Pi may still send generic `prompt_cache_retention` to compatible endpoints if configured, but that should be treated as Pi/provider compat behavior, not an official DeepSeek API guarantee unless validated.

### 3. Usage/stat fields available

- DeepSeek chat completion API usage includes:
  - `prompt_tokens`: total prompt tokens, equal to `prompt_cache_hit_tokens + prompt_cache_miss_tokens`.
  - `prompt_cache_hit_tokens`: input tokens that hit context cache.
  - `prompt_cache_miss_tokens`: input tokens that missed context cache.
  - `completion_tokens`, `total_tokens`, etc.
- In streaming, `include_usage` can return final usage for the full request.
- Pi currently normalizes DeepSeek/OpenAI-compatible cache fields into `usage.cacheRead` and `usage.input`/`usage.cacheWrite` where available.

### 4. What an adapter could safely do in this Pi extension

- Keep current prompt-reordering strategy: place stable tools/skills/guidelines before dynamic task/git/session context.
- Detect DeepSeek by model id/name containing `deepseek`, and optionally by provider id only if explicitly configured; avoid base URL or thinking-format inference.
- Footer label can remain `DS cache` or become a DeepSeek adapter label.
- Normalize stats from Pi usage as:
  - cache read = `usage.cacheRead` (or raw `prompt_cache_hit_tokens` only if raw usage becomes available through hooks)
  - total prompt input = `usage.input + usage.cacheRead + usage.cacheWrite`; for raw DeepSeek, total is `prompt_tokens` or hit+miss.
- Warn about missing Pi compat flags only for DeepSeek-like OpenAI-compatible models: long retention support and session affinity/session id headers when endpoint supports them.
- Never fake hits; only count provider/Pi-exposed usage.

### 5. Risks/limitations

- Cache hit depends on exact persisted prefix units, not simply repeated prompt text.
- First repeat may still be a miss while the service identifies/persists a common prefix; third and later repeats may be more meaningful for tests.
- Proxies can hide, rewrite, or drop DeepSeek usage fields and routing/session-affinity behavior.
- DeepSeek's official cleanup window is best-effort hours-to-days, not a deterministic TTL.
- If Pi-normalized usage changes, footer denominator semantics must be revalidated.

## Anthropic Claude prompt caching

### 1. Activation/control semantics

- Claude prompt caching is explicit. The API supports:
  - top-level `cache_control: { "type": "ephemeral" }` for automatic caching, where the system applies a moving breakpoint to the last cacheable block;
  - block-level `cache_control` for explicit breakpoints on individual content blocks.
- Caches are prefix-based: the cached content is the full prompt prefix up to and including the breakpoint.
- A request checks whether a prompt prefix up to a cache breakpoint is already cached; on hit it reads from cache, otherwise it processes the full prompt and writes the prefix once the response begins.
- Cache writes occur only at breakpoints. The lookback for previous cache entries is limited to 20 blocks per breakpoint.
- Up to 4 cache breakpoints can be defined. Automatic caching consumes one breakpoint slot.
- Exact matching is required for the cached segment, including text/images and breakpoint locations.

### 2. TTL/retention behavior

- Default cache lifetime is 5 minutes (`ephemeral`). Cache is refreshed at no additional cost when used.
- Anthropic offers a 1-hour TTL by setting `cache_control: { "type": "ephemeral", "ttl": "1h" }` at higher write cost.
- 1-hour cache duration is available on Claude API, Claude Platform on AWS, Vertex AI, and Microsoft Foundry beta; Bedrock does not support the 1-hour duration according to Anthropic docs.
- Mixing 1-hour and 5-minute TTLs has ordering constraints: longer TTL entries must appear before shorter TTL entries.
- Cache entries are isolated by organization and, for Claude API/Claude Platform on AWS/Microsoft Foundry beta as of 2026-02-05, by workspace. Bedrock and Vertex maintain organization-level isolation per docs.
- KV representations and hashes are held in memory only and not stored at rest, with deletion after minimum lifetime promptly but not immediately.

### 3. Usage/stat fields available

- Response `usage` fields include:
  - `cache_read_input_tokens`: tokens read from cache.
  - `cache_creation_input_tokens`: tokens written to cache.
  - `input_tokens`: tokens after the last cache breakpoint that were neither read nor written.
  - Optional detailed `cache_creation` breakdown such as `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`.
- Total input tokens = `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`.
- If both cache read and creation tokens are zero, caching may not have occurred, often because the prompt is below the minimum cacheable length.
- Pi normalizes these as `usage.cacheRead` and `usage.cacheWrite` in custom-provider examples and session format.

### 4. What an adapter could safely do in this Pi extension

- Treat Anthropic as a separate adapter, not as DeepSeek/OpenAI-compatible.
- Use Pi's existing Anthropic cache-control machinery if available rather than manually rewriting request bodies from this extension. Pi already supports Anthropic-style `cache_control` and long retention compat.
- Footer label should be provider-specific, e.g. `Claude cache`, and should include both read ratio and optionally write tokens because Claude charges cache writes differently.
- Normalize from Pi usage:
  - cache read = `usage.cacheRead` (`cache_read_input_tokens`)
  - cache write = `usage.cacheWrite` (`cache_creation_input_tokens`)
  - total input = `usage.input + usage.cacheRead + usage.cacheWrite`
- If the extension later gains request mutation, cache breakpoints must be placed on stable prefix blocks, not dynamic user/task blocks. For Pi, likely safe breakpoints are stable system prompt/tool definitions; dynamic task context should remain after the breakpoint.
- Warn only when model/provider is known Claude/Anthropic and compat lacks `cacheControlFormat: "anthropic"` or long-retention support when user expects long retention.

### 5. Risks/limitations

- Adding `cache_control` blindly can increase cost via cache writes without reads, especially when the breakpoint includes changing dynamic content.
- Minimum cacheable prompt length varies by model/platform (examples in current docs include 1,024, 2,048, and 4,096 token thresholds depending on model). Shorter prompts silently do not cache.
- Four-breakpoint limit and 20-block lookback require careful block placement.
- Tool definition order, images, tool choice, thinking block behavior, and dynamic content can invalidate caches.
- Cross-platform Anthropic (Bedrock, Vertex, proxies) may have different supported TTLs and usage-field names.

## OpenAI official prompt caching / cached input

### 1. Activation/control semantics

- Prompt caching is automatic for supported OpenAI models when prompts are 1,024 tokens or longer.
- Cache hits require exact prefix matches. OpenAI recommends static instructions/examples/tools/images at the beginning and dynamic/user-specific content at the end.
- Routing uses a hash of the initial prompt prefix, typically the first 256 tokens though model-dependent.
- `prompt_cache_key` can be supplied as a routing hint and is combined with the prefix hash to improve hit rates for common-prefix workloads.
- If traffic for the same prefix and `prompt_cache_key` combination exceeds roughly 15 requests/minute, overflow to additional machines can reduce cache effectiveness.
- After the first 1,024 tokens, Azure OpenAI docs state cache hits occur in 128-token increments; this is consistent with widely cited OpenAI prompt-caching behavior, though the current OpenAI guide excerpt reviewed emphasized the 1,024-token eligibility and `cached_tokens` reporting.

### 2. TTL/retention behavior

- In-memory prompt cache retention: cached prefixes generally remain active for 5-10 minutes of inactivity, up to a maximum of one hour; held in volatile GPU memory.
- Extended prompt cache retention: when supported, `prompt_cache_retention: "24h"` can keep cached prefixes active longer, up to a maximum of 24 hours, by offloading KV tensors to GPU-local storage when memory is full.
- If no retention policy is specified, model defaults vary. Pi docs/changelog indicate Pi can send `prompt_cache_retention: "24h"` when `PI_CACHE_RETENTION=long` and compat supports it.
- Manual cache clearing is not available; unused prompts are automatically evicted.
- Caches are not shared between organizations. OpenAI docs say in-memory caching does not save data to disk; extended retention may store KV tensors in GPU-local storage for at most 24h.

### 3. Usage/stat fields available

- Chat Completions usage exposes `usage.prompt_tokens_details.cached_tokens`.
- Newer OpenAI Response/Chat objects also expose a `cached_tokens` field under prompt/input token details; Pi normalizes cached tokens where supported.
- Requests under 1,024 tokens still show `cached_tokens`, but it is zero.
- Total prompt tokens remain in `prompt_tokens`/input token fields; cached tokens are a subset, not additional tokens.

### 4. What an adapter could safely do in this Pi extension

- Separate OpenAI official adapter from generic OpenAI-compatible providers.
- Detect official OpenAI via provider id/API type/model family and/or explicit user config, not just `api: openai-*`, because many providers mimic OpenAI schemas without matching cache semantics.
- Continue prompt stable-prefix reordering; this directly aligns with OpenAI recommendations.
- Prefer Pi-normalized `usage.cacheRead` for footer stats. If raw fields ever become accessible, map `prompt_tokens_details.cached_tokens` to cache read and total prompt/input tokens to total.
- Treat `prompt_cache_key`/`prompt_cache_retention` as Pi/provider transport concerns. The extension can warn or document required compat rather than injecting fields unless Pi exposes a safe hook.
- Footer label could be `OpenAI cache` or `OA cache`; only show when cached-token usage is present or model is known supported.

### 5. Risks/limitations

- Cache is automatic and best-effort; no explicit breakpoint control.
- `cached_tokens` is zero for short prompts and for any prefix miss; this does not mean adapter failure.
- `prompt_cache_key` is a routing hint, not a privacy boundary or cache namespace with guaranteed affinity.
- Extended retention availability is model-dependent.
- OpenAI-compatible endpoints may ignore `prompt_cache_retention`, reject it, or expose different usage fields.

## Google Gemini / Vertex AI context caching and implicit caching

### 1. Activation/control semantics

- Gemini has two distinct caching modes:
  - Implicit caching: enabled by default for Gemini 2.5 and newer models (Gemini API docs) and all Google Cloud projects on supported Vertex models. It automatically passes on cost savings if a request hits cache; no request change is needed.
  - Explicit context caching: developer creates a `cachedContents` resource with model, contents, optional system instruction, display name, and TTL/expire time; subsequent `generateContent` references it via `cachedContent`/`cached_content`.
- Gemini API implicit cache minimum input token limits currently documented:
  - Gemini 3 Flash Preview: 1,024
  - Gemini 3 Pro Preview: 4,096
  - Gemini 2.5 Flash: 1,024
  - Gemini 2.5 Pro: 4,096
- Vertex context cache overview currently documents minimum token count for implicit and explicit caching:
  - Gemini 3 and 3.1 models: 4,096 tokens
  - Gemini 2.0 and 2.5 models: 2,048 tokens
- To improve implicit hits, put large common content at the beginning and send similar-prefix requests close together.

### 2. TTL/retention behavior

- Gemini API explicit caches default to 1 hour TTL if not set.
- TTL or `expire_time` can be updated; other cache content cannot be changed.
- Gemini API docs say storage duration has no minimum or maximum bounds on TTL, but explicit cache cost depends on cached token size and TTL duration.
- Vertex docs say explicit context caches default to 60 minutes, can update expiration time past default, minimum time before expiration is 1 minute, and there is no maximum cache duration.
- Explicit caches can be listed, metadata fetched, updated, and deleted; cached content itself cannot be retrieved/viewed, only metadata.

### 3. Usage/stat fields available

- Gemini API: cache-hit token count is visible in response `usage_metadata`; cache service operations also return cached token count in `usage_metadata`.
- Vertex AI: for both implicit and explicit caching, response metadata field `cachedContentTokenCount` indicates the number of tokens in cached content / cached prompt context.
- The Google GenAI SDK type definitions include `cachedContentTokenCount` on usage metadata.
- Pi changelog notes Google/Vertex cost normalization subtracts cached prompt tokens when providers report `cachedContentTokenCount`.

### 4. What an adapter could safely do in this Pi extension

- Phase 1 should only use implicit Gemini/Vertex stats if Pi already normalizes `cachedContentTokenCount` to `usage.cacheRead`; do not create or manage explicit caches from the extension without a more complex state model and user approval.
- Stable-prefix prompt reordering helps implicit caching and is safe.
- Footer label could be `Gemini cache` and should appear only when Gemini/Vertex usage exposes cached tokens or adapter detection is explicit.
- Explicit cache support, if ever added, should be opt-in and content-addressed, with strict rules not to store prompt/message bodies in this extension's state. It would need lifecycle management for cache resource names, TTL, deletion, and stale content.
- For OpenAI-compatible Gemini proxies (e.g. LiteLLM), only trust Pi-normalized usage or documented proxy fields; do not assume native Gemini metadata is passed through.

### 5. Risks/limitations

- Explicit context caching is not a simple request annotation; it creates provider-side resources and may incur storage costs.
- Explicit cache IDs/resource names are stateful; storing them may reveal metadata and needs lifecycle/privacy policy.
- Gemini and Vertex docs differ on some model thresholds because they refer to different surfaces/models; adapter should be model/surface-specific.
- Cached tokens still count toward standard token limits and rate limits.
- Updating underlying Cloud Storage objects before cache expiry can make cached contents unusable.

## OpenAI-compatible proxies and aggregators

### 1. Activation/control semantics

- Proxies can expose OpenAI-compatible request/response shapes while routing to OpenAI, Anthropic, Gemini/Vertex, DeepSeek, Bedrock, OpenRouter-selected providers, or local models.
- LiteLLM docs demonstrate provider-dependent behavior behind a common interface:
  - OpenAI: automatic caching, optional `prompt_cache_key` and `prompt_cache_retention`.
  - Anthropic: explicit `cache_control` markers.
  - Bedrock Anthropic: LiteLLM translates OpenAI-format `cache_control` to Bedrock `cachePoint`.
  - Gemini/Vertex: LiteLLM translates Anthropic-style `cache_control` to Google's `cachedContents` API.
  - DeepSeek: works like OpenAI-style automatic caching from LiteLLM's perspective.
- LiteLLM also notes prompt caching is silently skipped below provider minimums and should be verified through usage fields.
- OpenRouter-style provider routing/fallback can change the actual upstream provider between requests unless constrained, invalidating cache assumptions.

### 2. TTL/retention behavior

- TTL depends entirely on upstream provider and proxy translation:
  - OpenAI: in-memory 5-10 minutes inactivity/up to 1h, optional extended up to 24h where supported.
  - Anthropic: 5m or 1h cache_control TTL.
  - Gemini: explicit cache resource TTL, default 1h/60m depending surface.
  - DeepSeek: best-effort hours-to-days cleanup after not in use.
- A proxy may ignore, drop, reject, or reinterpret retention fields.

### 3. Usage/stat fields available

- LiteLLM says supported providers follow OpenAI prompt caching usage format:
  - `usage.prompt_tokens_details.cached_tokens`
  - Anthropic-only `cache_creation_input_tokens` may also be present.
- Native providers may use:
  - DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
  - Anthropic: `cache_read_input_tokens` / `cache_creation_input_tokens`
  - OpenAI: `prompt_tokens_details.cached_tokens`
  - Google/Vertex: `cachedContentTokenCount`
- Pi may normalize these to `usage.cacheRead`/`cacheWrite`, but an adapter should treat zero/missing fields as unknown unless the provider/model is known to expose cache usage.

### 4. What an adapter could safely do in this Pi extension

- Use capability-based adapter selection rather than only `api: openai-completions`.
- A generic OpenAI-compatible adapter should be opt-in or conservative:
  - count stats only if Pi-normalized `usage.cacheRead`/`cacheWrite` is nonzero or known fields are present;
  - show neutral labels like `Cache` only for explicitly configured provider families;
  - never send Anthropic `cache_control` to a provider unless compat says `cacheControlFormat: "anthropic"`.
- For OpenRouter/proxy models, docs should recommend constraining upstream provider/order and enabling `require_parameters`/similar controls where needed to avoid fallback to providers with different cache support.
- Keep DeepSeek detection by model id/name for current package; do not infer DeepSeek behavior through proxies unless model family is explicit.

### 5. Risks/limitations

- Same model name can be served by multiple upstreams with different cache semantics.
- Usage fields can be omitted, normalized incorrectly, or represent different concepts (read vs write vs total cached content).
- Some proxy docs use OpenAI-compatible `cached_tokens` even when upstream billing/cache write semantics are Anthropic/Gemini-specific.
- Provider routing/fallback can break prefix affinity and usage comparability.
- Cache-control parameters may leak into unsupported endpoints and cause 400 errors if Pi compat is too broad.

## Recommended MVP phases

### Phase 0: Adapter architecture with no behavior expansion

- Introduce an internal `CacheProviderAdapter` concept with responsibilities:
  - detection / applicability
  - compat warning policy
  - cache-control/request-control assumptions (documented only unless Pi hook supports mutation)
  - usage normalization from Pi usage/raw known fields
  - footer label and denominator semantics
  - docs links and limitations
- Implement adapters but enable only current DeepSeek behavior by default.
- Preserve existing state file semantics or migrate carefully; no prompt/header/API-key storage.

### Phase 1: DeepSeek adapter hardening

- Move current DeepSeek detection, warnings, usage math, and footer label behind the adapter interface.
- Add fallback raw-field mapping only if event messages expose raw provider usage safely; otherwise keep Pi-normalized usage only.
- Docs: clarify `user_id` KVCache isolation, best-effort hours-to-days cleanup, and prefix-unit hit rules.

### Phase 2: Read-only stats adapters for providers Pi already normalizes

- Add footer stats for OpenAI official, Anthropic, and Gemini/Vertex only when:
  - provider/model detection is explicit and conservative; and
  - Pi-normalized `usage.cacheRead`/`cacheWrite` is available or raw fields are known.
- Do not inject new request controls in this phase.
- Use provider labels (`DS`, `Claude`, `OpenAI`, `Gemini`) and keep per-provider counters separate to avoid mixing semantics.
- For Anthropic, display cache writes separately or include them in denominator to avoid hiding write cost.

### Phase 3: Compat guidance and safe warnings

- Add provider-specific warnings/documentation:
  - Anthropic/Claude: requires `cacheControlFormat: "anthropic"` where using OpenAI-compatible Claude endpoints; long retention maps to `ttl: "1h"` only where supported.
  - OpenAI official: `prompt_cache_key`/`prompt_cache_retention` are Pi/provider-managed; extended retention is model-dependent.
  - Gemini: implicit stats only; explicit caching is out of scope by default.
  - Proxies: require capability flags and stable upstream routing before claiming support.

### Phase 4: Optional request-control adapters (needs separate approval)

- Only after confirming extension hooks can mutate request bodies safely:
  - Anthropic explicit breakpoint placement on stable Pi system/tool prefix.
  - OpenAI official retention/key hints if Pi does not already send them.
  - Gemini explicit cachedContents resource management as opt-in with a privacy/lifecycle design.
- This phase must include tests against unsupported-provider rejection and must not persist prompt/message bodies.

### Out of scope for first MVP

- Creating Gemini explicit cache resources.
- Generic proxy cache-control injection.
- Claiming stats for providers that do not expose reliable cache usage.
- Combining all provider stats into one global hit rate without labels, because read/write/total token semantics differ.
