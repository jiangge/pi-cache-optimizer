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

Stats are stored at `~/.pi/agent/pi-cache-optimizer-stats.json`.

Rules:

- Persist only counters, local dates, session hashes, provider/model ids, and last routed model refs.
- Never persist prompts, request payloads, response bodies, HTTP headers, API keys, credentials, raw session ids, or model outputs.
- Use atomic temp-file + rename writes.
- Preserve other session buckets best-effort when writing.
- Do not claim inter-process locking guarantees.

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
- Stats bucket keys derive from opaque session hash + provider/model key.
- Compat marker derives from safe fix suggestions for the effective model.
- Routing-provider live state may derive an effective upstream model for pre-message UX, but final stats derive from assistant message metadata.

---

## Common Mistakes

- Persisting raw session ids.
- Aggregating normal stats into provider-family buckets instead of session-scoped provider/model buckets.
- Treating local footer reset as upstream provider cache invalidation.
- Using legacy `_nosession` buckets after an explicit current-session write.
- Storing full prompts in global singleton compatibility shims.
