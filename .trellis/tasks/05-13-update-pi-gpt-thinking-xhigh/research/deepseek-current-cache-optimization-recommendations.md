# DeepSeek current context caching docs and optimization recommendations

## Sources checked

* Official English guide: `https://api-docs.deepseek.com/guides/kv_cache`
* Official Chinese guide: `https://api-docs.deepseek.com/zh-cn/guides/kv_cache`
* Official English launch/news page: `https://api-docs.deepseek.com/news/news0802`
* Official Chinese launch/news page: `https://api-docs.deepseek.com/zh-cn/news/news0802`
* Local project: `README.md`, `extension.ts`, `package.json`
* Existing task research: `deepseek-cache-stability.md`, `deepseek-cache-diagnosis.md`

## Current official DeepSeek cache behavior

* DeepSeek Context Caching / 上下文硬盘缓存 is enabled by default for all API users; no interface/code change is required to activate it.
* Hits are based on repeated prefixes starting at token 0. Repeated content in the middle of a request does not create a hit by itself.
* Current guide emphasizes Sliding Window Attention behavior: a hit requires fully matching a persisted cache-prefix unit, not merely sharing an arbitrary partial prefix.
* Cache-prefix units are persisted at user-input end, model-output end, detected common prefixes across multiple requests, and fixed token intervals for long inputs/outputs.
* The first divergent repeat may build a standalone common-prefix unit rather than hit; the third/future matching request is often the meaningful measurement.
* Usage reports `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`.
* Launch/news page notes 64-token cache storage units; content below 64 tokens is not cached.
* Cache is best-effort, not a 100% guarantee. Construction takes seconds; unused entries are usually cleared within hours to days.
* Output is still freshly generated and can vary with temperature; the cache only avoids recomputing matching prompt prefixes.

## Fit with current extension

The current extension already covers the practical Pi-specific levers that are likely to matter:

* stable system-prompt prefix ordering via `before_agent_start`;
* `PI_CACHE_RETENTION=long` so Pi sends compatible long-cache hints when the provider/model compat enables them;
* session-affinity compat warnings for DeepSeek-like OpenAI-compatible models;
* one-shot sanitized request/response diagnostics via `/deepseek-cache-debug`;
* response usage diagnostics for `cacheRead`, approximate miss, and hit rate when Pi exposes usage.

Given the reported official DeepSeek result of 5/5 cache hits around 96%, direct official DeepSeek appears to be working near the practical ceiling for this use case. More optimization is likely marginal compared with preserving stability and avoiding regressions.

## Additional practical ideas, ranked

1. **Do not change the core optimizer if official direct results stay ~96%.** The biggest remaining risk is breaking prompt semantics or making the prefix less stable.
2. **Document an official DeepSeek baseline as the recommended benchmark.** Use direct `deepseek/deepseek-v4-pro`, same Pi session, same model, no proxy mixing, wait a few seconds between repeats, and evaluate third/future repeats.
3. **Keep proxy guidance separate from official baseline.** Third-party proxies may route across shards, ignore/strip cache hints, or hide raw DeepSeek usage; compare them only after the official baseline is known-good.
4. **Add optional sanitized longitudinal diagnostics if needed.** Persist per-request provider/model/session-hash, system-prompt hash, role-sequence hash, input/cacheRead/cacheWrite/hit-rate, and retention/affinity flags. Do not log prompts, API keys, headers, or raw `prompt_cache_key` values.
5. **Add a stable-prefix drift warning.** The current debug shows system prompt hash and role hash for one request. A future enhancement could compare hashes across turns and warn when the supposedly stable prefix changed.
6. **Keep reusable large content at the earliest stable prefix in controlled benchmarks.** For DeepSeek docs, repeated prefix from token 0 matters more than repeated text later in the message.
7. **Avoid new sessions/forks/compaction/model switches during cache tests.** They change message history, session keys, or provider routing and make cache measurements noisy.
8. **Wait after warm-up requests.** Official docs say cache construction takes seconds, so immediate back-to-back requests can undercount hits.
9. **Treat `prompt_cache_retention`/`prompt_cache_key` as Pi/OpenAI-compatible hints, not official DeepSeek guarantees.** DeepSeek public docs describe automatic caching and do not require those knobs.

## Recommendation

No major new optimization appears necessary before publishing. Ship with conservative documentation: the extension improves the probability of DeepSeek cache hits but cannot guarantee them; official direct DeepSeek should be the baseline; proxy results are provider-dependent.
