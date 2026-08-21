# State Management

> Runtime and persisted state conventions for `pi-cache-optimizer`.

---

## Overview

This package uses plain module-local state inside `index.ts`. There is no Redux, React state, database, server state cache, or URL state.

State is intentionally small and privacy-preserving.

---

## State Categories

### In-memory runtime state

Examples:

- `runtimeOptimizerEnabled`
- current session hash
- `cacheStatsByModel`
- `legacyFamilyStats`
- `lastActualRoutedModel`
- recent usage samples
- one-shot warning/notification sets
- latest query-scoped cache hint

Rules:

- Keep raw Pi session ids out of persistence and user output.
- Recent samples are in-memory only and contain only numeric counters/booleans.
- Runtime enable/disable is process-local and should not write settings files.

### Persisted stats state

Stats use a v7 shard store under `~/.pi/agent/pi-cache-optimizer-stats.d/`. Each loaded extension instance owns one UUID-named file in `shards/` and never edits another instance's shard.

Rules:

- Persist only counters, local dates, opaque session hashes, provider/model ids, optional API ids, process diagnostics, reset epochs, and last routed model refs.
- Never persist prompts, request payloads, response bodies, HTTP headers, API keys, credentials, raw session ids, or model outputs.
- Every shard and epoch update uses a unique temp file plus atomic rename.
- Aggregate only exact `${provider}/${modelId}` keys. `session` selects the current session hash, `total` selects all valid current-day shards, and `process` selects the current instance shard.
- Old `pi-cache-optimizer-stats.json` and `deepseek-cache-optimizer-stats.json` files are obsolete, are not migrated, and are best-effort deleted so the shard version starts from zero.
- Global/model epochs invalidate old shard records for enable/disable/reset without modifying files owned by another process.
- Keep every current-day shard after its writer exits. Under a cross-process cleanup lease, remove eligible non-current-day shards after 48 hours and temp files after 24 hours; do not follow symlinks.
- Per-instance ownership removes cross-process lost-update races; no inter-process lock is required for ordinary shard writes.

### User configuration state

`~/.pi/agent/models.json` is not mutated during normal operation. The only allowed writer is `/cache-optimizer fix`, and only after explicit interactive confirmation.

Rules for `/cache-optimizer fix`:

- Create a timestamped backup.
- Use a comment-preserving JSONC surgical edit.
- Insert/repair only safe `compat` keys or a missing `compat` object under an existing provider/model.
- Do not create/delete providers, models, API keys, credentials, or router slugs.

---

## Derived State

- Adapter selection derives from model id/name tokens only.
- Stats bucket keys derive from opaque session hash + exact provider/model key; shard filenames derive from random instance UUIDs.
- Compat marker derives from safe fix suggestions for the effective model.
- Routing-provider live state may derive an effective upstream model for pre-message UX, but final stats derive from assistant message metadata.

---

## Common Mistakes

- Persisting raw session ids.
- Aggregating normal stats into provider-family buckets instead of session-scoped provider/model buckets.
- Treating local footer reset as upstream provider cache invalidation.
- Reintroducing the obsolete shared v6 file or legacy `_nosession` migration buckets into runtime behavior.
- Deleting a current-day closed child shard during shutdown or maintenance.
- Using PID/PPID to decide stats ownership or parent-child attribution; they are diagnostics/cleanup hints only.
- Storing full prompts in global singleton compatibility shims.
