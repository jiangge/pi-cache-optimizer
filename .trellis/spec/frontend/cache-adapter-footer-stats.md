# Cache Adapter Footer Stats and Auto-Config Contract

> Single-file Pi extension `extension.ts`. Pi loads this via Jiti at extension activation.

This document captures the executable contract for the footer cache stats and the
DeepSeek auto-config behavior. AI assistants and contributors should treat the rows
below as binding when changing `extension.ts`.

---

## Identity

| Field | Value | Notes |
|---|---|---|
| npm package name | `pi-cache-optimizer` | Renamed from `pi-deepseek-cache-optimizer` in 2.0.0. |
| Status key | `pi-cache-stats` | Passed to `ctx.ui.setStatus(STATUS_KEY, ...)`. Renamed from `deepseek-cache-stats`. |
| Stats file path | `~/.pi/agent/pi-cache-optimizer-stats.json` | Renamed from `~/.pi/agent/deepseek-cache-optimizer-stats.json`. |
| Models JSON path | `~/.pi/agent/models.json` | Read/auto-write target on Linux/macOS; `%USERPROFILE%\.pi\agent\models.json` on Windows. |

---

## Adapter selection (id/name only)

Adapter selection MUST consider only the active model `id` and `name`, plus the
assistant message's `model` and `name` fields on `message_end`. It MUST NOT use
`provider` id, `api` type, base URL, `compat.thinkingFormat`, or any other
metadata for selection. Generic OpenAI-compatible proxies are NOT treated as
OpenAI-family just because they use an OpenAI-shaped API.

| Adapter | Detection token (case-insensitive substring on id/name) | Footer label |
|---|---|---|
| DeepSeek | `deepseek` | `DS cache` |
| OpenAI-family | `gpt-`, `chatgpt`, or pattern `o[1345]` with safe boundaries | `OpenAI cache` |
| Anthropic / Claude | `anthropic`, `claude` | `Claude cache` |
| Gemini / Vertex | `gemini`, `vertex` | `Gemini cache` |

If no adapter matches, the footer status MUST be cleared (set to `undefined`).

---

## Persisted stats schema

* Stats are persisted in version 2 schema:

  ```ts
  type PersistedCacheStatsV2 = {
    version: 2;
    statsByProvider: Partial<Record<"deepseek" | "openai" | "claude" | "gemini", CacheStats>>;
  };
  ```

* `CacheStats` MUST contain `day`, `totalRequests`, `hitRequests`,
  `cachedInputTokens`, `cacheWriteInputTokens`, `totalInputTokens` (all
  non-negative integers; `hitRequests <= totalRequests`;
  `cachedInputTokens <= totalInputTokens`).
* The schema version is NOT bumped by the rename; existing v2 files written by
  1.x continue to load unchanged.
* `version: 1` files (DeepSeek-only, single-stats shape) MUST keep migrating
  into the `deepseek` slot.

### Migration on first run after rename

| Condition | Behavior |
|---|---|
| New path readable | Use it. Do not read or touch the old path. |
| New path missing AND old path readable | Parse old path, write new path atomically, best-effort `unlink` old path. |
| New path missing AND old path also missing | Initialize empty in-memory counters. |
| New path readable but corrupt JSON | Log a one-line warning, fall back to empty counters; do NOT overwrite with empty data on next write — let the regular write path replace it on the next valid update. |
| Old path corrupt | Log a one-line warning, do NOT delete the old file, do NOT write the new file from corrupt data. |

---

## models.json auto-config (DeepSeek seed)

Trigger: extension activation (the function exported as `default` runs once when
Pi loads the extension). Auto-config MUST be idempotent: running it multiple
times with the same state must produce the same outcome.

### Decision flow

1. If `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` (case-insensitive truthy:
   `1`, `true`, `yes`, `on`), do not write. Read-only inspection of
   `models.json` is allowed only to set `deepseekPresent` for the API-key hint.
2. Read `~/.pi/agent/models.json`:
   * Missing file → treat as `{ "providers": {} }`.
   * Present but unreadable for any reason other than ENOENT → log warning,
     skip auto-config.
   * Present but JSON invalid → log warning, skip auto-config. **Do NOT
     overwrite a malformed user file.**
   * Present and top-level is not a JSON object (array/string/number) → log
     warning, skip auto-config.
3. Skip seeding if any of:
   * Any model under any provider has an `id` or `name` containing the
     case-insensitive substring `deepseek`.
   * A provider key whose lowercase form equals `deepseek` exists, regardless
     of its model list contents.
4. Otherwise seed:
   1. Write `~/.pi/agent/models.json.bak.<unix-millis>` containing the exact
      bytes that were just read (or empty string if the file did not exist).
      Backup write failure aborts auto-config; the user's file is not touched.
   2. Build the merged document by adding a single `deepseek` provider key.
      Existing keys MUST NOT be modified, deleted, reordered destructively, or
      overwritten.
   3. Write merged JSON to `~/.pi/agent/models.json.tmp.<pid>` with
      `fs.writeFileSync` and 2-space indentation, then `fs.renameSync` over the
      target path. Rename failure leaves the temp file in place and logs a
      warning.

### Seed contents

The seed is `{ "deepseek": <provider-block> }` where the provider block has
exactly these top-level fields: `baseUrl`, `api: "openai-completions"`,
`apiKey: "$DEEPSEEK_API_KEY"`, and `models` — currently
`deepseek-v4-pro` and `deepseek-v4-flash`. Every model in the seed MUST carry
`compat.supportsLongCacheRetention: true` and
`compat.sendSessionAffinityHeaders: true`. These two flags are intentionally
beyond the official DeepSeek+Pi onboarding doc and are the reason this
extension's compat warnings exist.

### Hard contracts

* **Never modify or overwrite an existing user provider entry.** Auto-config is
  add-only and triggers only when the file is fully absent of DeepSeek-like
  models AND has no `deepseek` provider key.
* **Always write a backup before any mutation** of `models.json`. No backup, no
  write.
* **Never read, store, log, or print API key values** (`DEEPSEEK_API_KEY` or
  any other), prompts, message bodies, headers, or model outputs.
* **Atomic rename** (`writeFileSync` to temp + `renameSync`) is required. Plain
  in-place writes are forbidden.
* The opt-out env var `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` MUST short-circuit
  every write path. Even with opt-out, the API-key hint is still allowed to
  fire (its trigger is the presence of DeepSeek in `models.json`, not seed
  ownership).

### API-key hint (once per session)

* On the first `session_start` after extension activation, if
  `process.env.DEEPSEEK_API_KEY` is empty/whitespace AND `models.json` contains
  a DeepSeek-like model (whether seeded by us or pre-existing), emit exactly
  one `ctx.ui.notify(..., "info")` pointing at where to set the env var.
* The hint MUST NOT read the key value, MUST NOT print the key value, and MUST
  NOT duplicate Pi's own missing-key error when the user actually invokes the
  model.
* The hint fires at most once per process. Subsequent `session_start` events
  (e.g. `/reload`) MUST NOT re-emit it.

---

## Validation matrix

| Scenario | Expected behavior |
|---|---|
| Fresh install, no `models.json`, key unset | File created with `{ "providers": { "deepseek": ... } }`. Backup `~/.pi/agent/models.json.bak.<ts>` written as empty string. Hint emitted on first `session_start`. |
| Fresh install, no `models.json`, key set | File seeded same as above. **No** API-key hint. |
| `models.json` already contains a `deepseek` provider key (any models list) | No write. No backup. Hint may still fire when key is unset. |
| `models.json` has another provider whose model id contains `deepseek` (case-insensitive) | No write. No backup. Hint behavior same as above. |
| `models.json` is malformed JSON | No write. No backup. Warning logged. **Original file untouched.** Hint logic still queries `deepseekPresent = false` (cannot trust file). |
| `models.json` top-level is an array/string/number | Same as malformed JSON: skip, do not overwrite. |
| `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` | No write. No backup. Read-only check still computes `deepseekPresent` for hint logic. |
| Old stats path exists, new stats path missing | Read old, write new atomically, best-effort `unlink` old. `version: 2` `statsByProvider` data preserved unchanged. |
| New stats path corrupt | Log warning, fall back to empty in-memory counters; do not delete. Next valid write replaces it. |
| Backup write fails | Abort auto-config; do not write `models.json`. |
| `renameSync` for `models.json.tmp.<pid>` fails | Leave temp file in place; log a one-line warning; do not partial-write the target. |
| Two parallel Pi processes activate simultaneously | Each writes its own `bak.<ts>` and `tmp.<pid>`. The last `renameSync` wins. Backups guarantee both pre-states are recoverable. |

---

## System prompt reordering invariants

`extension.ts` exposes `optimizeSystemPrompt(original, opts)` which is invoked
from the `before_agent_start` hook to lift stable content above dynamic
content. The reorder uses `rest.replace(part, "")` per accepted candidate
from `buildStableCandidates(opts)`. Because `String.prototype.replace`
matches the FIRST occurrence of `part` anywhere in `rest`, short or
character-class candidates can rip arbitrary unrelated text out of the
dynamic remainder — corrupting the prompt and destabilizing provider
prefix caches across requests.

### Hard contracts

* The candidate filter MUST drop any trimmed candidate shorter than
  `MIN_STABLE_CANDIDATE_LENGTH` (currently `8`). That threshold is
  intentionally larger than every short bullet form pi may emit (`- X` is
  3 chars, `- ab` is 4, etc.) so single-character or two-character noise
  cannot become a `replace()` target.
* The threshold is a CACHE-CORRECTNESS contract, not a UX preference.
  Lowering it must be paired with a different mangle-resistant strategy
  (e.g. structural lift instead of `replace`-based extraction). Do not
  weaken the threshold without that.
* The reorder MUST remain idempotent: identical `(original, opts)` MUST
  produce byte-identical `(systemPrompt, stablePrefix)`. No timestamps,
  random salts, or iteration order that depends on `Map`/`Set` insertion
  order driven by external data.
* `buildStableCandidates` MAY return strings that the optimizer then
  rejects (it is a pure shaper). The defensive filter MUST live inside
  `optimizeSystemPrompt`, not inside `buildStableCandidates`, so that the
  rejection rationale stays close to the `replace()` call site.

### Common mistake: upstream string-vs-array regression in tool registrations

**Symptom**: Pi's emitted system prompt contains long runs of single-character
bullets such as:

```
- S
- u
- b
- -
- a
- g
- e
- n
- t
```

**Cause**: A pi extension registers a tool with `promptGuidelines` set to a
*string* instead of `string[]`. Pi's `_normalizePromptGuidelines`
(`@earendil-works/pi-coding-agent/dist/core/agent-session.js`) does
`for (const g of guidelines) { ... }`, which iterates a string
character-by-character. Each unique character becomes its own guideline.

**Observed at**: `@mindfoldhq/trellis` 0.5.16 (latest stable as of 2026-05-17)
and 0.6.0-beta.17 — file `src/templates/pi/extensions/trellis/index.ts`,
`subagent` tool registration. Tracked locally in
`.pi/extensions/trellis/index.ts` with a `LOCAL PATCH` comment until
upstream ships the fix.

**Fix at the source** (in the offending tool registration):

```ts
// Wrong
pi.registerTool?.({
  name: "subagent",
  promptGuidelines: SUBAGENT_DISPATCH_PROTOCOL, // string — iterated char by char
});

// Correct
pi.registerTool?.({
  name: "subagent",
  promptGuidelines: [SUBAGENT_DISPATCH_PROTOCOL], // string[]
});
```

**Defense in this extension**: even when pi feeds us such a polluted
`promptGuidelines` array, `optimizeSystemPrompt` MUST NOT lift the
resulting `- X` bullets into the stable prefix or use them as `replace()`
targets. The `MIN_STABLE_CANDIDATE_LENGTH = 8` filter handles this; the
verification harness in any task that touches this code path SHOULD
include a test that mirrors the regression (build candidates that include
single-character entries, assert the dynamic remainder is byte-equivalent
to a control run with the noise pre-filtered).

---

## Forbidden patterns

* Writing `models.json` without first writing the timestamped `.bak.<ts>` backup.
* Overwriting or deleting any existing provider/model entry in `models.json`.
* Reading or logging the value of `DEEPSEEK_API_KEY` (or any other API key env var).
* Storing prompts, request payloads, response bodies, or HTTP headers in any
  on-disk file produced by this extension.
* Adapter selection by `provider` id, API type, base URL, or compat flags.
* Using `version: 3+` schema or marker fields inside `models.json`.
* Generating in-place writes to `models.json` (no `renameSync` step) or to the
  stats file.
* Re-emitting the API-key hint on every `session_start`.

---

## Notes on rollback

If a future change needs to revert seeding for a specific user, the user keeps
control by:

1. Setting `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` before launching Pi.
2. Editing `~/.pi/agent/models.json` directly (or restoring from the
   `.bak.<ts>` backup the extension wrote before the seed).

The extension MUST NOT auto-revert or auto-clean its own seed, because it
cannot distinguish a user-edited copy of the seed from the original.
