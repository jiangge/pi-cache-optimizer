# 全项目审查：修复扩展生命周期与持久化问题

## Goal

审查 `pi-cache-optimizer` 运行时代码，修复已确认的 Pi 0.82 生命周期、跨 reload 全局状态和统计持久化缺陷，同时保持现有 adapter、routing、usage 与配置修复行为不变。

## Confirmed Findings

### 1. Pending footer stats are lost on shutdown

`message_end` delays disk persistence by 2 seconds, but the extension does not register `session_shutdown`. Pi 0.82 awaits this hook before quit/reload/new/resume/fork and then tears down the runtime or exits. A response followed by shutdown within the debounce window can therefore lose the last stats update.

### 2. Cache-hints service survives extension teardown

`installCacheHintsService()` returns an uninstall callback, but the extension discards it. Reload/session replacement can leave a global `Symbol.for("pi.cache.hints.v1")` service backed by the old extension closure, including the previous session's prompt/cache hint, until a new instance overwrites it.

### 3. Runtime disable restores the wrong retention value after reload

The startup `PI_CACHE_RETENTION` snapshot is module-local. The first load requests `long`; a subsequent module reload captures that extension-written value as the new startup baseline. `/cache-optimizer disable` then leaves `PI_CACHE_RETENTION=long` instead of restoring the process's original unset/custom value.

### 4. Persistence writes can complete out of order

Debounced `message_end` persistence and immediate reset/enable/disable/rollover persistence can overlap. Atomic rename protects file integrity but does not order multiple writes from the same extension instance. An older write that renames last can restore counters deleted by a newer reset.

## Requirements

- Register `session_shutdown` and await a final stats flush.
- Cancel the pending debounce timer during shutdown.
- Uninstall the cache-hints service and clear extension-owned legacy hint globals during shutdown.
- Preserve one validated process-level `PI_CACHE_RETENTION` baseline across extension module reloads.
- Keep enable/disable behavior process-local and restore the true original unset/custom value.
- Serialize all stats writes from one extension instance so invocation order is preserved.
- Ensure reset/delete/replace persistence intents are not lost when state changes during an in-flight write or a write fails.
- Preserve atomic temp-file + rename behavior and best-effort inter-process semantics; do not claim locking.
- Do not alter id/name-only adapter selection, usage normalization, provider transport behavior, or `models.json` write safety.
- Add direct helper and hook-level regression verification.
- Update the binding spec and hook guidelines. README changes are unnecessary because this is correctness-only lifecycle behavior.

## Acceptance Criteria

- [x] A pending `message_end` write is flushed before `session_shutdown` completes.
- [x] Shutdown unregisters the instance's cache-hints service without deleting a newer/replacement service.
- [x] Shutdown clears extension-owned legacy cache-key state.
- [x] Reloaded module instances share the original retention baseline; disable restores unset and custom values correctly.
- [x] Same-instance persistence calls execute serially in call order.
- [x] A reset queued behind an older write remains authoritative and cannot be overwritten by that older write.
- [x] Existing Issue #4 Kimi stats, routing, migration, adaptive-thinking, direct-provider consolidation, 403, fix self-check, Sonnet 5, and Pi 0.82 regressions pass.
- [x] Typecheck, `git diff --check`, `npm pack --dry-run`, and Trellis validation pass.

## Verification Result

- Lifecycle teardown and serialization regression: 19/19 passed.
- Issue #4 direct Kimi stats regression: 21/21 passed.
- Pi 0.82 current review regression: 20/20 passed.
- Restart-persistent stats regression: 9/9 passed.
- 403 diagnostics regression: 18/18 passed.
- Kimi Pi 0.80.10 compat regression: 22/22 passed.
- Routing protocol regression passed.
- Typecheck, `git diff --check`, `npm pack --dry-run` (`2.6.22`), and Trellis validate passed.
- One superseded archived Pi 0.82 script still calls the intentionally removed `resolvePiAgentDir`; its current replacement (`verify-review-fixes.ts`) passes 20/20 against Pi core `getAgentDir()` semantics.

## Out of Scope

- Inter-process file locking or transactional multi-process durability.
- Adapter detection changes.
- Provider transport changes.
- npm publication or release creation.
