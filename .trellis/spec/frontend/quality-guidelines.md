# Quality Guidelines

> Code quality standards for this Pi extension project.

---

## Overview

This repository is a single-package Pi extension. Quality checks emphasize:

- TypeScript no-emit validation
- task-level verification scripts for changed behavior
- privacy/security review for user-facing diagnostics and persisted files
- package dry-run checks before release
- keeping README/spec docs aligned with behavior

---

## Required Checks

Before committing runtime behavior changes, run the relevant subset and record task-specific results:

```bash
bunx tsc --noEmit --pretty false
git diff --check
npm pack --dry-run
```

When a task has a verification script, run it too, for example:

```bash
bun .trellis/tasks/<task>/verify.ts
```

For Trellis task context files:

```bash
python3 ./.trellis/scripts/task.py validate .trellis/tasks/<task>
```

---

## Required Patterns

- Update `.trellis/spec/frontend/cache-adapter-footer-stats.md` when changing cache stats, prompt optimization, compat diagnostics, persistence, or routing-provider behavior.
- Keep `README.md` and `README.zh-CN.md` in sync for user-visible features or commands.
- Add/update a task-level verification script for new parsing, migration, routing, prompt, or compat behavior.
- Keep footer behavior truthful; never fake cache counters for transports that do not expose usage fields.
- Prefer conservative fallback behavior over crashes in Pi hooks.
- Commit Trellis archive moves after implementation commits so task history stays durable.

---

## Forbidden Patterns

- Logging or persisting API keys, prompts, payloads, headers, response bodies, raw session ids, or model outputs.
- Writing `models.json` outside the explicit `/cache-optimizer fix` confirmation flow.
- In-place writes to stats/config files when atomic temp + rename is required.
- Adapter selection by provider id, API type, base URL, or compat flags.
- Importing router packages or depending on package-specific router globals instead of optional versioned symbols.
- Adding non-actionable startup warnings for provider limitations.
- Leaving debug `console.log` / noisy diagnostics in normal hook paths.

---

## Testing Requirements

Add or update tests/verification scripts when changing:

- adapter detection
- usage normalization
- persisted stats schema/migration
- prompt rewrite/reorder behavior
- JSONC compat fix editing
- OpenAI-compatible `prompt_cache_key` fallback
- routing-provider registry/cache-hints protocol
- command output semantics

Task verification should assert external behavior and protocol behavior, not private implementation details, unless the helper is deliberately exported under `__internals_for_tests`.

---

## Code Review Checklist

- [ ] TypeScript check passes.
- [ ] Task verification scripts pass.
- [ ] `git diff --check` passes.
- [ ] `npm pack --dry-run` passes when package contents may matter.
- [ ] No secrets or prompt content are persisted/logged/displayed.
- [ ] README/spec updates match behavior.
- [ ] Unsupported models/transports fail safe and truthful.
- [ ] Runtime disable/env opt-out gates still work.

## Scenario: Pi cache adapter footer stats

### 1. Scope / Trigger
- Trigger: The Pi extension persists provider/model-scoped cache counters and displays footer status by active model.
- Applies when modifying `extension.ts`/`index.ts` cache stats, model-family detection, usage normalization, state migration, prompt rewrite, compat diagnostics, or routing-provider protocol behavior.

### 2. Signatures
- Extension hooks: `session_start`, `model_select`, `before_agent_start`, `before_provider_request`, `after_provider_response`, `message_end`.
- State file: `~/.pi/agent/pi-cache-optimizer-stats.json` (legacy rename source: `~/.pi/agent/deepseek-cache-optimizer-stats.json`).
- Status key: `pi-cache-stats` via `ctx.ui.setStatus(key, textOrUndefined)`.
- OpenAI-compatible prompt cache key env: enabled by default; opt out with `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` or `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0`.

### 3. Contracts
- Persisted state must contain only counters and local dates; never API keys, prompts, messages, headers, or outputs.
- Current state shape is versioned and session-scoped; normal updates use `${sessionHash}:${provider}/${id}` in memory and `sessions[sessionHash][provider/model]` on disk.
- Adapter selection must use only model id/name plus assistant message `model`/`name`; never provider id, API type, base URL, thinking format, or compat flags.
- Stable-prefix optimization may move stable instruction files and compressed skill listings ahead of dynamic context; it must not persist or print their contents.
- OpenAI-compatible payloads may receive a top-level `prompt_cache_key` from `ctx.sessionManager.getSessionId()` when the active/effective model uses `openai-completions`/`openai-responses`, no effective key exists, and opt-out env vars are not set.
- Router/provider live registry data may be used for pre-message UX, but `message_end` stats identity is authoritative from assistant message metadata.

### 4. Validation & Error Matrix
- Missing/corrupt state file -> fall back to empty in-memory counters and continue.
- Persist write failure -> warn at most once and continue with in-memory counters.
- Unsupported/ambiguous model -> clear footer status instead of guessing provider semantics.
- Missing usage fields -> preserve truthful zero/empty stats; do not synthesize cache hits.
- Malformed routing registry snapshots -> warn/ignore; do not crash.

### 5. Good/Base/Bad Cases
- Good: DeepSeek/OpenAI-family/Claude/Gemini/model-family id/name match updates only the active session + provider/model bucket.
- Good: A routed assistant message with real upstream metadata updates the upstream bucket, not the virtual router shell.
- Base: A matched but unseen model shows 0/0 for the current session.
- Bad: Generic OpenAI-compatible API metadata selects the OpenAI adapter when model id/name does not match an OpenAI-family token.
- Bad: Two providers exposing the same model id share footer counters.

### 6. Tests Required
- Load extension through Pi/Jiti or `tsc` without type/runtime errors.
- Simulate supported and unsupported `message_end` events for changed adapters.
- Assert provider/model/session counters stay separate.
- Assert state migrations preserve valid data and drop malformed data.
- Assert OpenAI cache-key injection is enabled-by-default but opt-outable, API-gated, session-id sourced, and does not override existing keys.
- Assert routing-provider helpers use message metadata for final stats and registry data only for live UX.
- Run `git diff --check` and `npm pack --dry-run` before release.
