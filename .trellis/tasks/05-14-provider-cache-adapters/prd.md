# brainstorm: Provider-specific cache adapters

## Goal

Research how major model providers handle prompt/KV/context caching, then design a provider-specific adapter plan for `pi-deepseek-cache-optimizer` before implementation. The goal is to expand cache optimization and footer stats safely without blindly generalizing DeepSeek behavior to incompatible providers.

## What I already know

* User wants provider/model-family-specific adapters, not direct generalization.
* Current package is DeepSeek-focused.
* Current footer stats only count DeepSeek-like models where model id/name contains `deepseek`.
* Current stats persist across Pi restarts and reset on `/reload` and local natural-day rollover.
* README now says future support should be provider/model-family adapters.

## Assumptions (temporary)

* Candidate providers likely include DeepSeek, Anthropic Claude, OpenAI/ChatGPT-compatible models, Gemini, and OpenAI-compatible proxies that expose cache usage.
* Some providers expose cache usage in response usage fields, while others expose no reliable cache stats.
* Adapter support may differ between optimization behavior and footer statistics.

## Open Questions

* None for approved MVP.

## Requirements (evolving)

* Research provider cache semantics before implementation.
* Produce an implementation plan and wait for user approval before coding.
* User approved MVP: adapter architecture, DeepSeek migration, OpenAI/Anthropic/Gemini read-only stats, no request mutation/cache-control injection.
* Avoid storing or printing API keys, prompts, messages, or headers.
* Preserve current DeepSeek behavior unless an approved plan changes it.

## Acceptance Criteria (evolving)

* [x] Research notes cover cache controls, TTL/retention, usage fields, and limitations for each target provider.
* [x] Plan separates adapter responsibilities: detection, request/cache controls, usage normalization, footer label, docs.
* [x] Plan identifies MVP scope and out-of-scope providers.
* [x] User approves plan before implementation begins.
* [ ] Implementation preserves DeepSeek behavior and migrates v1 persisted stats to DeepSeek adapter stats.
* [ ] Footer stats are separate per provider family and only show the active supported family.
* [ ] README and Chinese README document multi-provider read-only stats and limitations.

## Definition of Done

* Research saved under task research directory.
* PRD updated with selected MVP scope after user confirmation.
* No code implementation begins before approval.

## Out of Scope (explicit)

* Implementing adapters before user approves the plan.
* Adding unsupported cache statistics when a provider does not expose reliable usage fields.
* Changing API keys, model IDs, provider URLs, or unrelated Pi config.

## Technical Notes

* Current source files likely impacted after approval: `extension.ts`, `README.md`, `README.zh-CN.md`, possibly package version.
* Existing package version is `1.0.2` on npm.
* Research artifact: `.trellis/tasks/05-14-provider-cache-adapters/research/provider-cache-semantics.md`.
* Research summary:
  * DeepSeek: automatic prefix/KV cache; official usage exposes prompt cache hit/miss tokens; best-effort cleanup hours-to-days.
  * Anthropic: explicit `cache_control` breakpoints; 5m/1h TTL semantics; usage exposes cache read/create input tokens.
  * OpenAI: automatic prompt caching for long prompts; `cached_tokens` in prompt/input token details; optional cache key/retention where supported.
  * Gemini/Vertex: implicit caching plus explicit cached-content resources; usage metadata can expose cached content token count.
  * Proxies/aggregators: cache semantics depend on upstream routing and may be inconsistent; adapters must be capability/provider-specific.

## Approved Plan

1. Refactor current DeepSeek-specific logic behind a `CacheProviderAdapter` abstraction.
2. Preserve current DeepSeek behavior as the first adapter and migrate persisted stats safely.
3. Add read-only stats adapters for official/provider-detected OpenAI, Anthropic/Claude, and Gemini/Vertex only when Pi-normalized or known usage fields expose cache read/write tokens.
4. Keep provider counters separate and show the active model/provider footer only; do not combine all providers into one global hit rate.
5. Add provider-specific docs/warnings; avoid request mutation/cache-control injection until a later, separately approved phase.

## Implementation Notes

* Implemented `CacheProviderAdapter` with DeepSeek, OpenAI official, Claude/Anthropic, and Gemini/Vertex adapters.
* Persisted stats moved to version 2 shape: `statsByProvider`, with v1 DeepSeek-only state migration.
* No request body mutation, no Anthropic `cache_control` injection, and no Gemini explicit cache resource management.
* Package version bumped to `1.0.3`.
