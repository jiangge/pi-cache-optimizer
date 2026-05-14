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
- Trigger: The Pi extension persists provider cache counters and displays footer status by provider/model family.
- Applies when modifying `extension.ts` cache stats, provider detection, usage normalization, or state migration.

### 2. Signatures
- Extension hooks: `session_start`, `model_select`, `before_agent_start`, `message_end`.
- State file: `~/.pi/agent/deepseek-cache-optimizer-stats.json`.
- Status key: `deepseek-cache-stats` via `ctx.ui.setStatus(key, textOrUndefined)`.

### 3. Contracts
- Persisted state must contain only counters and local dates; never API keys, prompts, messages, headers, or outputs.
- Current state shape uses `version: 2` with `statsByProvider` keyed by provider-family adapter id.
- Old `version: 1` state migrates into the DeepSeek adapter counters.
- `/reload` resets persisted counters; Pi process restart restores persisted counters; local natural-day rollover resets on next status/update.

### 4. Validation & Error Matrix
- Missing/corrupt state file -> fall back to empty in-memory counters and continue.
- Persist write failure -> warn at most once and continue with in-memory counters.
- Unsupported/ambiguous model -> clear footer status instead of guessing provider semantics.
- Missing usage fields -> do not update counters for read-only non-DeepSeek adapters.

### 5. Good/Base/Bad Cases
- Good: Official DeepSeek/OpenAI/Claude/Gemini usage with cache fields updates only that adapter's counters.
- Base: DeepSeek usage with no cache read increments total requests and records a miss, preserving legacy behavior.
- Bad: Generic OpenAI-compatible proxy without explicit provider family is counted as official OpenAI.

### 6. Tests Required
- Load extension through Pi/Jiti without type/runtime errors.
- Simulate DeepSeek, OpenAI, Claude, Gemini, and unsupported proxy `message_end` events.
- Assert provider counters stay separate and unsupported model status clears.
- Assert v1 state migrates to v2 DeepSeek counters.
- Run `git diff --check` and `npm pack --dry-run` before release.

### 7. Wrong vs Correct

#### Wrong
```typescript
// Treats every OpenAI-shaped proxy as official OpenAI cache support.
if (model.api === "openai-completions") showOpenAIStats();
```

#### Correct
```typescript
// Adapter detection must be provider/model-family specific and conservative.
const adapter = selectAdapterForModel(model);
ctx.ui.setStatus(STATUS_KEY, adapter ? formatCacheStats(adapter, stats) : undefined);
```
