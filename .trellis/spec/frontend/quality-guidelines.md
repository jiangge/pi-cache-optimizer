# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

(To be filled by the team)

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)

## Scenario: Pi cache adapter footer stats

### 1. Scope / Trigger
- Trigger: The Pi extension persists provider/model-scoped cache counters and displays footer status by active model.
- Applies when modifying `extension.ts` cache stats, model-family detection, usage normalization, or state migration.

### 2. Signatures
- Extension hooks: `session_start`, `model_select`, `before_agent_start`, `message_end`.
- State file: `~/.pi/agent/pi-cache-optimizer-stats.json` (legacy rename source: `~/.pi/agent/deepseek-cache-optimizer-stats.json`).
- Status key: `pi-cache-stats` via `ctx.ui.setStatus(key, textOrUndefined)`.
- OpenAI-family prompt cache key env: enabled by default; opt out with `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` or `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0`.

### 3. Contracts
- Persisted state must contain only counters and local dates; never API keys, prompts, messages, headers, or outputs.
- Current state shape uses `version: 3` with `statsByModel` keyed by `${provider}/${id}` and `legacyFamily` for migrated/fallback provider-family counters.
- Adapter selection must use only model id/name plus assistant message `model`/`name`; never provider id, API type, base URL, thinking format, or compat flags.
- Stable-prefix optimization may move stable instruction files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CURSOR.md`, and `.trellis/spec/...` ahead of dynamic context; it must not persist or print their contents.
- OpenAI-family id/name matches may receive a top-level `prompt_cache_key` from `ctx.sessionManager.getSessionId()` when the active model uses `openai-completions`/`openai-responses`, no effective key exists, and opt-out env vars are not set. Do not store or print the session id, and do not override an existing non-empty `prompt_cache_key` or `promptCacheKey`.
- Old `version: 1` state migrates into `legacyFamily.deepseek`; old `version: 2` `statsByProvider` migrates into `legacyFamily` with empty `statsByModel`.
- `/reload` resets persisted counters; Pi process restart restores persisted counters; local natural-day rollover resets all stale model and legacy family buckets on next status/update.

### 4. Validation & Error Matrix
- Missing/corrupt state file -> fall back to empty in-memory counters and continue.
- Persist write failure -> warn at most once and continue with in-memory counters.
- Unsupported/ambiguous model -> clear footer status instead of guessing provider semantics.
- Missing usage fields -> do not update counters for read-only non-DeepSeek adapters.

### 5. Good/Base/Bad Cases
- Good: DeepSeek/OpenAI-family/Claude/Gemini model id/name with cache usage fields updates only the active `${provider}/${id}` model bucket.
- Base: DeepSeek usage with no cache read increments total requests and records a miss, preserving legacy behavior.
- Base: Small stable `AGENTS.md` or `.trellis/spec/...` context can move earlier for cacheability while dynamic task/session context remains later.
- Bad: Generic OpenAI-compatible API metadata selects the OpenAI adapter when model id/name does not match an OpenAI-family token.
- Bad: Two providers exposing the same model id (for example `otokapi/gpt-5.5` and `cafecode/gpt-5.5`) share footer counters.

### 6. Tests Required
- Load extension through Pi/Jiti without type/runtime errors.
- Simulate DeepSeek, OpenAI, Claude, Gemini, and unsupported proxy `message_end` events.
- Assert provider/model counters stay separate and unsupported model status clears.
- Assert v1 and v2 state migrate to v3 `legacyFamily` with empty `statsByModel`.
- If OpenAI cache-key injection changes, assert it is enabled-by-default but opt-outable, id/name + OpenAI-compatible-api gated, session-id sourced, and does not override existing keys.
- Run `git diff --check` and `npm pack --dry-run` before release.

### 7. Wrong vs Correct

#### Wrong
```typescript
// Treats every OpenAI-shaped proxy as OpenAI-family cache support.
if (model.api === "openai-completions") showOpenAIStats();

// Aggregates two different proxy providers into the same footer bucket.
statsByProvider.openai = addUsage(statsByProvider.openai, usage);
```

#### Correct
```typescript
// Adapter detection remains id/name-only and conservative; stats scoping uses
// provider/id only after an adapter has matched.
const adapter = selectAdapterForModel(model);
const key = model ? `${model.provider}/${model.id}` : undefined;
const stats = key ? statsByModel[key] : undefined;
ctx.ui.setStatus(STATUS_KEY, adapter ? formatCacheStats(adapter, stats ?? emptyCacheStats()) : undefined);
```
