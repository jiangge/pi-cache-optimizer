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
- Trigger: The Pi extension persists provider-family cache counters and displays footer status by model family.
- Applies when modifying `extension.ts` cache stats, model-family detection, usage normalization, or state migration.

### 2. Signatures
- Extension hooks: `session_start`, `model_select`, `before_agent_start`, `message_end`.
- State file: `~/.pi/agent/deepseek-cache-optimizer-stats.json`.
- Status key: `deepseek-cache-stats` via `ctx.ui.setStatus(key, textOrUndefined)`.
- Optional OpenAI-family prompt cache key env: `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=1`.

### 3. Contracts
- Persisted state must contain only counters and local dates; never API keys, prompts, messages, headers, or outputs.
- Current state shape uses `version: 2` with `statsByProvider` keyed by adapter id.
- Adapter selection must use only model id/name plus assistant message `model`/`name`; never provider id, API type, base URL, thinking format, or compat flags.
- Stable-prefix optimization may move stable instruction files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CURSOR.md`, and `.trellis/spec/...` ahead of dynamic context; it must not persist or print their contents.
- When `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=1`, OpenAI-family id/name matches may receive a top-level `prompt_cache_key` derived from a hash of the stable prefix. Do not store or print the prefix, and do not override an existing `prompt_cache_key`.
- Old `version: 1` state migrates into the DeepSeek adapter counters.
- `/reload` resets persisted counters; Pi process restart restores persisted counters; local natural-day rollover resets on next status/update.

### 4. Validation & Error Matrix
- Missing/corrupt state file -> fall back to empty in-memory counters and continue.
- Persist write failure -> warn at most once and continue with in-memory counters.
- Unsupported/ambiguous model -> clear footer status instead of guessing provider semantics.
- Missing usage fields -> do not update counters for read-only non-DeepSeek adapters.

### 5. Good/Base/Bad Cases
- Good: DeepSeek/OpenAI-family/Claude/Gemini model id/name with cache usage fields updates only that adapter's counters.
- Base: DeepSeek usage with no cache read increments total requests and records a miss, preserving legacy behavior.
- Base: Small stable `AGENTS.md` or `.trellis/spec/...` context can move earlier for cacheability while dynamic task/session context remains later.
- Bad: Generic OpenAI-compatible API metadata selects the OpenAI adapter when model id/name does not match an OpenAI-family token.
- Bad: `prompt_cache_key` is injected by default or into a payload that already has one.

### 6. Tests Required
- Load extension through Pi/Jiti without type/runtime errors.
- Simulate DeepSeek, OpenAI, Claude, Gemini, and unsupported proxy `message_end` events.
- Assert provider counters stay separate and unsupported model status clears.
- Assert v1 state migrates to v2 DeepSeek counters.
- If OpenAI cache-key injection changes, assert it is opt-in, id/name-gated, and does not override existing keys.
- Run `git diff --check` and `npm pack --dry-run` before release.

### 7. Wrong vs Correct

#### Wrong
```typescript
// Treats every OpenAI-shaped proxy as OpenAI-family cache support.
if (model.api === "openai-completions") showOpenAIStats();
```

#### Correct
```typescript
// Adapter detection must be model id/name only and conservative.
const adapter = selectAdapterForModel(model);
ctx.ui.setStatus(STATUS_KEY, adapter ? formatCacheStats(adapter, stats) : undefined);
```
