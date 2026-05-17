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

### Provider transport caveats (do not paper over)

Some pi providers ship as extensions that register a custom `api` id and
own their own request/response transport. Pi's compat-driven cache marker
injection (`cacheControlFormat: "anthropic"`, `cachePoint` insertion in
bedrock-converse-stream, etc.) lives **inside** the openai-completions,
anthropic-messages, and bedrock-converse-stream adapters. Custom-API
extensions are not visited by that compat layer.

When the adapter selection picks an underlying provider whose transport
does not surface cache fields, the footer MUST stay at 0% rather than
being massaged. Do NOT special-case-bump these counters.

#### `kiro-api` (provider `kiro`, package `pi-provider-kiro`)

* Wire identity: assistant messages carry `"provider":"kiro"`,
  `"api":"kiro-api"`. The transport is
  `POST https://q.<region>.amazonaws.com/generateAssistantResponse`
  with header
  `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`
  (the AWS CodeWhisperer / Amazon Q Developer streaming protocol).
* Source-of-truth pointer: `pi-provider-kiro@0.6.1`'s
  `dist/{stream.js,usage.js}` contain zero matches for `cache_control`,
  `cachePoint`, `cache_read_input`, `cacheReadInputTokens`, or
  `cacheCreationInputTokens`. All `cacheRead`/`cacheWrite` references
  are zero-initializers, never assignments from upstream response data.
  The request body's `userInputMessage.content` is a flat string with
  no slot for cache markers.
* Configuration note: a user's `models.json` `"kiro": { ... }` block
  cannot fix this. The package registers `kiro-api` and the custom
  `stream` function; pi's compat flags do not reach that code path.
* Footer behavior: Claude requests on `kiro-api` MUST keep showing 0%
  cache hit rate. This is **truthful and unchangeable from this
  extension's side**. Do NOT add a special-case bump or fake `cacheRead`
  values to make the number look better.
* Warning behavior: the Claude adapter's `warningText` MUST stay silent
  for `kiro-api` (it currently fires only when
  `isOpenAICompatibleApi(model.api)` is true, which `kiro-api` is not).
  The compat warning's purpose is to nudge the user toward flipping a
  flag; on `kiro-api` there is no flag the user can flip, so an
  informational warning would be startup noise. If a future contributor
  proposes adding a Kiro-specific warning, the answer is: don't — the
  decision is recorded here.
* Investigation references:
  `.trellis/tasks/05-17-investigate-kiro-claude-0-cache-hit-rate/`
  (`prd.md` + `research/kiro-cache-passthrough.md`).

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
* Special-casing `kiro-api` (or any other custom-API extension whose
  transport does not surface cache fields) by faking `cacheRead`,
  `cacheReadInputTokens`, or hit counts to make the footer look better.
  The 0% is the truthful number; documenting the constraint is the
  correct response, not papering over it.

---

## System prompt budget

### What counts as cacheable-and-stable vs cacheable-and-volatile

Pi's system prompt combines several layers. From most-to-least
cacheable:

| Layer | Stability | Cache impact |
| ----- | --------- | ------------ |
| Pi base preamble (tools + guidelines + doc paths) | Stable across sessions unless tools change | Always in stable prefix; 100 % cacheable |
| `AGENTS.md` / project context files | Stable per repo; changes only on commit | Lifted to stable prefix by `optimizeSystemPrompt`; 100 % cacheable |
| Skills XML `<available_skills>` block | Deterministic from `opts.skills` (stable unless you install/remove a skill) | Lifted to stable prefix; now **compressed by default** (see below) |
| Trellis `<session-overview>` | Mostly stable; tail (commits, journal line count) churns per turn | Currently in dynamic remainder (tail churn). Do not lift in this extension — that's trellis's own ordering decision. |
| Trellis `<workflow-state>` per-turn breadcrumb | Changes per task activation, per turn | Always in dynamic remainder. Small (~1 KB). |
| Date + cwd footer | Date changes once/day; cwd stable | In dynamic remainder; ~100 bytes, not worth lifting. |

### Skills compression contract

`formatSkillsForPromptCompressed` replaces pi's per-skill four-line XML
block (`<name>`, `<description>`, `<location>`) with a **single text
block** grouped by skill-root directory:

```
The following skills provide specialized instructions for specific tasks.
When a skill name matches the task you are doing, read the SKILL.md at
the listed location to load the full instructions. When a SKILL.md
references a relative path, resolve it against the skill directory
(parent of SKILL.md / dirname of the path) and use that absolute path in
tool commands.

Skills under /home/jiang/.agents/skills/<name>/SKILL.md:
  adapt, animate, arrange, audit, ...

Skills under /home/jiang/jiang/source/.../pi-cache-optimizer/.pi/skills/<name>/SKILL.md:
  trellis-before-dev, trellis-brainstorm, ...
```

Key properties:

* **Deterministic**: same `skills` array → byte-identical output,
  independent of input order. Groups sort by root path; names within
  each group sort alphabetically.
* **Idempotent**: running `compressSkillsInSystemPrompt` twice is a
  no-op (the verbose form is already gone after the first pass).
* **Opt-out**: `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` disables.
* **Threshold**: compression fires only when the visible skill count
  is ≥ `SKILL_COMPRESSION_MIN_COUNT` (currently 4). Below that, the
  verbose XML block is ≤ ~1 KB and the loss of description hints is
  not worth the micro-savings.
* **Anchored substitution**: compression only fires when the verbose
  output of `formatSkillsForPrompt(opts.skills)` is found verbatim in
  the prompt (substring match, not regex). If pi changes its emitter
  format, the substitution no-ops rather than mangling.
* **Cache-preserving**: the compressed skills block remains
  deterministic from `opts.skills` and is lifted to the stable prefix
  by `optimizeSystemPrompt`. No new cache-churn is introduced.
* **Size cut**: measured at ~93 % reduction of the skills section
  (13.3 KB → ~0.9 KB on the 31-skill snapshot) and ~55 % of total
  system prompt (22 KB → ~9 KB).

### What MUST NOT be lifted into the stable prefix

* `<workflow-state>` per-turn breadcrumb — dynamic, small, safe in
  the tail.
* `<session-overview>` tail fields (recent commits, journal line
  count) — change per-turn when the user commits or writes journal.
  **These are now proactively stripped by `stripSessionOverviewChurn`**
  before reorder, so the remaining session-overview (branch, active
  tasks, paths) becomes stable and cacheable.
* Date / cwd footer — 100 bytes, not worth lifting.
* Any extension-appended block that contains a timestamp, random
  salt, insertion-order-dependent iteration, or env-var-derived
  string. The `before_agent_start` reorder MUST remain idempotent
  (identical inputs → byte-identical output).

### Session-overview churn strip

`stripSessionOverviewChurn(prompt)` surgically removes three fields
from inside `<session-overview>`:
* `## RECENT COMMITS` block (from heading through next `##` heading
  or end of block).
* `Working directory: ...` line.
* `Line count: N / NNNN` line.

The remaining fields (DEVELOPER, Branch, CURRENT TASK, ACTIVE
TASKS, MY TASKS, JOURNAL FILE active-file-only, PACKAGES, PATHS)
are stable within a session and survive the strip intact.

Called in `before_agent_start` BEFORE skills compression and reorder.
No opt-out; the stripped fields carry zero task-execution information
that the model cannot obtain from `git log` / `git status` / `wc -l`
in the rare case it actually needs them.

### Truncation guard (workflow-state integrity)

`optimizeSystemPrompt` uses `String.replace(part, "")` to extract
stable candidates from the dynamic remainder. If an upstream extension
(e.g. trellis) injects text that shares a substring with a candidate,
`replace()` removes the **first** occurrence — the one in the stable
block. This is usually safe because the copy inside the dynamic
injection stays.

When it is **not** safe: if a candidate substring appears ONLY inside
an injected block (not in any stable block), the first (and only)
occurrence IS inside the injection — `replace()` eats dynamic content.

Guard:
* After reorder, check: was `<workflow-state>` present in `original`
  but absent from the resulting `systemPrompt`?
* If yes → **fall back to the original prompt** (no reorder), flip
  `promptTruncationDetected` flag. The model receives a complete
  prompt; cache stability is sacrificed for integrity.
* `publishStatus` reads the flag once, appends ` ⚠️ integrity` to
  the footer status line, and resets the flag — the warning is
  visible for exactly one status update.
* The guard fires on real structural truncation only; it does NOT
  fire on the common substring-collision case (substring in both
  stable AND dynamic) because `<workflow-state>` survives that.

When the user sees ` ⚠️ integrity` in the footer:
1. The prompt sent to the model is the **original** (trellis-injected)
   prompt — no reorder was applied on that turn.
2. The cause is almost always an upstream format change (trellis
   update) that introduced a new substring collision.
3. `/reload` may help if the collision depends on per-turn state;
   otherwise, degrades gracefully (cache miss, no prompt corruption).

---

## Notes on rollback

If a future change needs to revert seeding for a specific user, the user keeps
control by:

1. Setting `PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1` before launching Pi.
2. Editing `~/.pi/agent/models.json` directly (or restoring from the
   `.bak.<ts>` backup the extension wrote before the seed).

The extension MUST NOT auto-revert or auto-clean its own seed, because it
cannot distinguish a user-edited copy of the seed from the original.
