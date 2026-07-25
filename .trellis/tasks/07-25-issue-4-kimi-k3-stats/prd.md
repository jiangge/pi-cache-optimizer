# 修复 Issue #4：Kimi Coding K3 footer stats 始终为 0/0

## Goal

核查并修复 GitHub issue #4：`kimi-coding/k3` 使用 `anthropic-messages` 时，provider 返回真实 `cacheRead` usage，但 `message_end` 无法选择 Kimi adapter，导致 footer、stats、recent samples 和持久化统计始终为 0。

## Issue

- URL: https://github.com/jiangge/pi-cache-optimizer/issues/4
- Reporter environment:
  - Pi 0.80.10
  - pi-cache-optimizer 2.6.18
  - Windows
  - provider `kimi-coding`, model id `k3`, display name `Kimi K3`
  - API `anthropic-messages`, base URL `https://api.kimi.com/coding`
- Reported assistant usage includes real cache values, e.g. `input: 499`, `cacheRead: 159488`, `cacheWrite: 0`.

## Root Cause

`selectAdapterForAssistantMessage()` builds a response model through `modelFromAssistantMessage()`. That helper always sets `name: id`. For a direct response carrying `provider: "kimi-coding"`, `model: "k3"`, this discards the active model display name `Kimi K3`. The Kimi adapter then sees only `["k3"]`, so no id/name token contains `kimi` and `message_end` exits before recording stats.

The footer can still show `Kimi cache 0/0` because pre-response selection uses the active model with display name `Kimi K3`. Thus display and response paths disagree.

## Design Decision

Do NOT add provider/baseUrl to generic adapter selection. The binding spec requires adapter selection to use model/message id and name only, preventing generic proxy/provider ids from changing cache-family classification.

Instead, preserve the active model's display name in `modelFromAssistantMessage()` only when the response describes the same direct identity:

- response provider equals fallback provider;
- response model id equals fallback model id;
- fallback name is non-empty.

If provider or id differs, keep `name: response id`; routed/upstream metadata remains authoritative and no stale router-shell display name leaks into adapter selection.

## Requirements

- Reproduce the issue with a direct assistant message containing provider `kimi-coding`, model `k3`, API `anthropic-messages`, and normalized cache usage.
- `selectAdapterForAssistantMessage()` must select `Kimi cache` for this message when fallback model name is `Kimi K3`.
- `message_end` must record both session-scoped stats and `totalsByModel["kimi-coding/k3"]`.
- Preserve the id/name-only adapter-selection contract; do not classify by provider, API, base URL, or compat.
- Do not match bare `k3` outside a Kimi-named model.
- Do not leak fallback display names across different provider/model response identities or virtual routing.
- Add direct helper and hook-outcome regression tests.
- Update spec/README only if behavior/contract wording requires it.

## Acceptance Criteria

- [x] Issue #4 reproduction fails before the fix and passes after it.
- [x] Same direct provider/id preserves fallback display name for adapter selection.
- [x] Different response id or provider does not preserve fallback display name.
- [x] Bare unrelated `k3` remains unmatched.
- [x] `message_end` increments Kimi cache stats using real cache usage.
- [x] Existing Kimi K3 adaptive-thinking tests remain green.
- [x] Typecheck, relevant verify scripts, `git diff --check`, `npm pack --dry-run`, and Trellis validate pass.
- [x] Issue receives a maintainer comment with root cause, fix commit/version status, and is closed only after verified resolution.

## Verification Result

- Direct issue regression: 21/21 passed.
- Verified in-memory footer/stats/recent sample updates.
- Verified persisted v6 session bucket and `totalsByModel["kimi-coding/k3"]` contain 1 hit / 1 total and the reported token counters.
- Existing Kimi adaptive-thinking, direct-provider consolidation, 403, migration, fix self-check, Sonnet 5, and Pi 0.82 review regressions pass.
- Package version prepared: `2.6.21`.

## Out of Scope

- Changing Kimi provider transport or cache protocol.
- Provider/baseUrl-driven generic adapter selection.
- Faking cache usage when the provider returns none.
- Publishing a release unless separately requested.

## Technical Notes

- Relevant helpers: `modelFromAssistantMessage`, `selectAdapterForAssistantMessage`, `isKimiLikeAssistantMessage`, `consolidateDirectProviderStatsModel`.
- Relevant hook: `message_end` in `index.ts`.
- Binding spec: `.trellis/spec/frontend/cache-adapter-footer-stats.md` adapter selection and message_end identity rules.
- Existing Kimi verification: archived `verify-kimi-k3-pi-08010.ts`.
