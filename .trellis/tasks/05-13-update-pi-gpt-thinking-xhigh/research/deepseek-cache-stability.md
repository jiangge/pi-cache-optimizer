# DeepSeek cache stability research

## Sources

* Official DeepSeek Chinese docs: `https://api-docs.deepseek.com/zh-cn/guides/kv_cache` (上下文硬盘缓存)
* Local Pi provider code:
  * `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js`
  * `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/openai-responses.js`
  * `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js`
* Local extension/package files:
  * `extension.ts`
  * `README.md`
* Local Pi config inspected in sanitized form: `/home/jiang/.pi/agent/models.json`, `/home/jiang/.pi/agent/settings.json`

## Official DeepSeek cache behavior

* Context disk cache is enabled for all users by default; callers do not need to change request code to enable it.
* Every request may build cache. Later requests can hit cache when their input prefix repeats earlier request prefixes.
* Due to Sliding Window Attention, cache is not simply any partial prefix: DeepSeek stores independent complete `缓存前缀单元` (cache-prefix units), and later requests hit only when they completely match a stored unit.
* Cache-prefix units are written at:
  * the end of each request's user input,
  * the end of each model output,
  * detected common prefixes across multiple requests,
  * fixed token intervals inside long inputs/outputs.
* Practical implication: first two variants that share `A` but diverge as `A+B` and `A+C` may not hit on the second request; they can cause `A` to be written as a standalone unit, and a later `A+D` can hit `A`.
* Responses report `usage.prompt_cache_hit_tokens` and `usage.prompt_cache_miss_tokens`.
* Cache is best effort, not guaranteed 100% hit. Cache construction takes seconds. Unused cache is automatically cleaned after roughly hours to days.
* Cache affects only prompt/input prefix reuse; output remains freshly inferred and can vary with temperature.

## Pi provider behavior relevant to DeepSeek/OpenAI-compatible endpoints

* Pi passes a stable session ID from `SessionManager` into provider stream options. For resumed sessions the ID comes from the session file header; new sessions get a new ID.
* `openai-completions` resolves cache retention from explicit options or `PI_CACHE_RETENTION=long`; otherwise it defaults to `short`.
* For `openai-completions`, Pi sends:
  * `prompt_cache_key: <sessionId>` when base URL is OpenAI and retention is not `none`, or when retention is `long` and `compat.supportsLongCacheRetention` is true.
  * `prompt_cache_retention: "24h"` when retention is `long` and `compat.supportsLongCacheRetention` is true.
  * `session_id`, `x-client-request-id`, and `x-session-affinity` headers only when `compat.sendSessionAffinityHeaders` is true.
* For `openai-responses`, Pi sends `prompt_cache_key: <sessionId>` unless retention is `none`, `prompt_cache_retention: "24h"` for long retention, and session headers controlled by `sendSessionIdHeader`.
* DeepSeek-like `openai-completions` requests with `compat.thinkingFormat: "deepseek"` send `thinking: { type: "enabled" | "disabled" }` and `reasoning_effort` when thinking is enabled.
* Usage normalization maps DeepSeek/OpenAI-compatible `prompt_cache_hit_tokens` into Pi `cacheRead`. Some providers may report `prompt_tokens_details.cached_tokens`; Pi handles both.

## Current local Pi config observations (sanitized)

* `/home/jiang/.pi/agent/settings.json` includes the local package path in `packages` and currently has `defaultThinkingLevel: "xhigh"`.
* Official/direct `deepseek/deepseek-v4-pro` is configured with:
  * `api: "openai-completions"`
  * `compat.thinkingFormat: "deepseek"`
  * `compat.supportsLongCacheRetention: true`
  * `compat.sendSessionAffinityHeaders: true`
  * `thinkingLevelMap.high: "max"`, `thinkingLevelMap.xhigh: "max"`
* AIAPI `aiapi/deepseek-v4-pro` is configured with:
  * provider compat disabling several OpenAI features (`supportsDeveloperRole`, usage streaming, strict mode, store)
  * model compat `thinkingFormat: "deepseek"` and `supportsLongCacheRetention: true`
  * no `sendSessionAffinityHeaders` in the merged compat, so Pi will send `prompt_cache_key` and `prompt_cache_retention`, but not the session-affinity headers for this proxy.

## Why cache hits can look effective but unstable

* DeepSeek cache units require complete-unit prefix matches, not arbitrary substring/prefix matches.
* The first repeat after a divergent prompt may be a cache-building request rather than a hit; the later repeat can improve once common prefixes are detected and written.
* Pi prompts include stable and dynamic layers. The extension moves stable material first, but dynamic task/session context, git status, selected tools, model-generated history, compaction summaries, or task changes still alter later prefix units.
* New Pi sessions get a different `prompt_cache_key`; resumed sessions keep the original session ID. If an upstream proxy partitions cache by key/session/header, new sessions can look colder.
* Third-party proxies can hide cache usage, ignore `prompt_cache_*`, route requests to different upstream shards, or drop/ignore affinity headers. The AIAPI config currently lacks `sendSessionAffinityHeaders`, so Pi is not asking that proxy for header-level affinity.
* Long retention (`prompt_cache_retention: "24h"`) is a Pi/OpenAI-compatible request hint when compat allows it. DeepSeek official docs still describe cleanup as best-effort over hours to days, so it should be treated as a hint, not an SLA.

## Practical next optimizations

1. **Add session-affinity for AIAPI only if the proxy accepts these headers.** Candidate config: add `"sendSessionAffinityHeaders": true` to the AIAPI DeepSeek model compat or provider compat. Validate with `/deepseek-cache-debug` that the merged compat reports affinity configured. If the proxy rejects unknown headers or behaves worse, revert.
2. **Prefer resumed sessions for cache experiments.** Use the same Pi session when benchmarking so `prompt_cache_key`/headers stay stable. Compare against a deliberately new session to isolate session-key effects.
3. **Benchmark direct DeepSeek vs AIAPI separately.** Direct DeepSeek already has long retention and affinity enabled locally. If direct is stable but AIAPI is unstable, the next bottleneck is likely proxy routing/reporting, not prompt ordering.
4. **Warm common prefixes deliberately.** For workflows with a large stable corpus/system/tool prompt and varying final questions, run two warm-up variants sharing the same large prefix; DeepSeek may write the common prefix as a standalone unit, then later variants should hit more reliably.
5. **Reduce early dynamic prompt churn further.** The current extension already front-loads stable prompt candidates. Additional gains likely require keeping high-entropy per-turn/task data out of the earliest system prompt prefix or moving it after a stable delimiter/prefix, but avoid changing tool definitions or task context semantics.
6. **Extend diagnostics, not secrets.** A useful next feature is recording sanitized per-request cache debug snapshots plus post-response usage (`cacheRead`, `cacheWrite`, raw hit/miss fields if exposed) keyed by provider/model/session hash. This would help separate provider cache instability from prompt-prefix drift without logging keys or prompt text.
7. **Document a repeatable cache benchmark.** Use one stable large input and N short varying suffixes; run warm-up #1, warm-up #2, then measurement #3+; record session continuity, provider, model, retention flag, affinity flag, prompt length, and Pi `/stats` cacheRead.

## Likely code/config changes to consider

* Config-only: add `sendSessionAffinityHeaders: true` for `aiapi/deepseek-v4-pro` if compatible with the proxy.
* Extension diagnostics: add an `after_provider_response` hook to correlate sanitized payload flags with usage/cache stats and response headers where available.
* Extension optimizer: add a diagnostic hash of stable-prefix text segments (never raw content) so benchmark runs can detect when the supposedly stable prefix changed.
* README: update benchmark guidance to reflect DeepSeek's cache-prefix-unit behavior: second divergent request may create cache; third/future matching request is the meaningful hit test.
