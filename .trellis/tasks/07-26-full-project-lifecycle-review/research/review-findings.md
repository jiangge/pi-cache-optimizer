# Full-project lifecycle review findings

## Sources inspected

- `index.ts` runtime hooks, state closure, persistence writer, global routing/cache-hints protocol, env retention controls.
- Pi 0.82 local docs: `docs/extensions.md` session lifecycle.
- Pi 0.82 runtime: `dist/core/agent-session-runtime.js`, `dist/core/extensions/runner.js`, `dist/modes/interactive/interactive-mode.js`.
- Project binding specs and prior task verification scripts.

## Confirmed findings

### P1: debounced stats are not flushed during session shutdown

Pi 0.82 documents and implements `session_shutdown` for quit/reload/new/resume/fork. Runtime disposal awaits extension shutdown handlers before disposing or exiting. The extension schedules `message_end` persistence with a 2000 ms timer but registers no shutdown handler. Therefore a response followed by shutdown within 2 seconds can lose the final provider/model totals and session bucket.

### P1: cache-hints global retains old closure after teardown

The extension installs `Symbol.for("pi.cache.hints.v1")` and receives an ownership-safe uninstall callback, but discards it (`void uninstallCacheHintsService`). On reload or session replacement the old global can continue serving `latestCacheHint` from the old closure until replaced. The helper already supports safe uninstall: it only restores/deletes when the global still points to the same service.

### P1: reload changes the retention restore baseline

`STARTUP_CACHE_RETENTION_ENV` is captured at module evaluation, immediately before the module sets `PI_CACHE_RETENTION=long`. In a fresh process with no value:

1. First module load captures unset, then sets `long`.
2. Reload evaluates a fresh module and captures `long`.
3. `/cache-optimizer disable` restores `long`, not unset.

An isolated Bun reproduction printed `after-first-load long` and `after-second-disable long` with the environment initially unset.

### P1: same-instance atomic writes can rename out of order

`persistCacheStats()` can be entered by the debounce timer and concurrently by immediate flush paths (reset, enable, disable, fix-related reset, rollover). Each writer reads, writes a unique temp file, then renames. Atomic rename prevents partial JSON but does not preserve invocation order. If an older message write stalls after its read and a newer reset completes first, the older temp can rename last and resurrect deleted totals. Same-instance writes need serialization; inter-process last-writer-wins remains explicitly accepted.

## Baseline checks

- `bunx tsc --noEmit --pretty false`: pass.
- `npm pack --dry-run`: pass, five package files.
- `git diff --check`: pass before changes.
- `npm audit`: not runnable because this package intentionally has no npm lockfile; command returns `ENOLOCK`.

## Security/privacy review

No confirmed secret/prompt/payload/header/model-output persistence was found. Stats persistence remains counters, dates, hashed session buckets, and minimal routed model identity only. `models.json` writes remain confined to the explicit interactive fix flow.
