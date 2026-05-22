# Cache Adapter Footer Stats Contract

> Single-file Pi extension `extension.ts`. Pi loads this via Jiti at extension activation.

This document captures the executable contract for the footer cache stats
behavior. AI assistants and contributors should treat the rows
below as binding when changing `extension.ts`.

---

## Identity

| Field | Value | Notes |
|---|---|---|
| npm package name | `pi-cache-optimizer` | Renamed from `pi-deepseek-cache-optimizer` in 2.0.0. |
| Status key | `pi-cache-stats` | Passed to `ctx.ui.setStatus(STATUS_KEY, ...)`. Renamed from `deepseek-cache-stats`. |
| Stats file path | `~/.pi/agent/pi-cache-optimizer-stats.json` | Renamed from `~/.pi/agent/deepseek-cache-optimizer-stats.json`. |
| Models JSON path | `~/.pi/agent/models.json` | Reference path for compat warnings; `%USERPROFILE%\.pi\agent\models.json` on Windows. |

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

### OpenAI-family prompt cache-key fallback

The extension MAY add a top-level `prompt_cache_key` in the
`before_provider_request` hook, but only as a conservative fallback around Pi
core's own cache transport.

* Scope gate: the active model MUST be OpenAI-family by `id`/`name` detection
  (`gpt-`, `chatgpt`, or safe-boundary `o[1345]`) AND its `api` MUST be an
  OpenAI-compatible Pi adapter (`openai-completions` or `openai-responses`).
  Do not inject this field into custom transports such as `kiro-api`, even if
  the model name contains `gpt`.
* Cache-key source: use `ctx.sessionManager.getSessionId()`, clamped to
  OpenAI's 64-codepoint `prompt_cache_key` limit. Do NOT derive the key from a
  prompt/stable-prefix hash; Pi core uses session id for official OpenAI paths,
  and the extension fallback must match that stability model.
* Existing key preservation: a non-empty string in either `prompt_cache_key`
  or `promptCacheKey` is authoritative and MUST NOT be overwritten. Values that
  are `undefined`, `null`, `""`, or whitespace-only are treated as missing and
  may be replaced by the session-id fallback.
* Opt-out: default behavior is enabled. Users can disable fallback injection
  with `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` (truthy: `1`, `true`, `yes`,
  `on`) or legacy-style `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0` (disabled:
  `0`, `false`, `no`, `off`).
* Official OpenAI Responses / Codex prompt bypass remains unchanged: the
  `before_agent_start` hook still avoids prompt rewriting for
  `openai-codex-responses` and `openai-responses`.

#### Third-party GPT proxy compat warning

For OpenAI-family models using `api: "openai-completions"` through a non-official
base URL (not `api.openai.com`), warn once per model when merged compat lacks
one or both of:

```json
{
  "supportsLongCacheRetention": true,
  "sendSessionAffinityHeaders": true
}
```

This warning is advisory only and MUST NOT mutate `~/.pi/agent/models.json`.
It exists because many third-party OpenAI-compatible proxies fan out to multiple
upstream instances; a body `prompt_cache_key` alone may not keep requests on the
same cache-bearing backend unless the proxy also honors session-affinity headers.

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

## Validation matrix

| Scenario | Expected behavior |
|---|---|
| `prompt_cache_key` fallback disabled (`PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` or `PI_CACHE_OPTIMIZER_OPENAI_CACHE_KEY=0`) | No extension-added `prompt_cache_key`; Pi core behavior remains authoritative. |
| OpenAI-family `openai-completions` payload has no effective key | Extension adds `prompt_cache_key` from `ctx.sessionManager.getSessionId()` if a non-empty session id is available. |
| Payload has non-empty `prompt_cache_key` or `promptCacheKey` | Extension does not replace it. |
| Payload has `prompt_cache_key: undefined`, `null`, `""`, or whitespace | Treat as missing; extension may add the session-id fallback. |
| Model id/name looks GPT-like but API is a custom transport (e.g. `kiro-api`) | Do not add OpenAI `prompt_cache_key`; do not assume compat layers reach custom transports. |
| Third-party GPT `openai-completions` proxy missing cache/session-affinity compat | Warn once per model with a copyable `compat` suggestion; do not edit `models.json`. |
| Old stats path exists, new stats path missing | Read old, write new atomically, best-effort `unlink` old. `version: 2` `statsByProvider` data preserved unchanged. |
| New stats path corrupt | Log warning, fall back to empty in-memory counters; do not delete. Next valid write replaces it. |

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

* Never creating, backing up, overwriting, or deleting provider/model entries in `models.json`. This extension may mention `models.json` only in advisory compat text.
* Reading or logging the value of `DEEPSEEK_API_KEY` (or any other API key env var).
* Storing prompts, request payloads, response bodies, or HTTP headers in any
  on-disk file produced by this extension.
* Injecting OpenAI `prompt_cache_key` into non-OpenAI-compatible custom APIs.
* Deriving OpenAI `prompt_cache_key` from prompt content or stable-prefix hashes; use the Pi session id fallback instead.
* Overwriting a non-empty user/Pi-provided `prompt_cache_key` or `promptCacheKey`.
* Adapter selection by `provider` id, API type, base URL, or compat flags.
* Using `version: 3+` schema or marker fields inside the stats file.
* Generating in-place writes to the stats file.
* Re-emitting per-session notifications or duplicate warnings.
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

### Truncation guard (structural marker integrity)

`optimizeSystemPrompt` uses `String.replace(part, "")` to extract
stable candidates from the dynamic remainder. If an upstream extension
(e.g. trellis, or any future extension) injects text that shares a
substring with a candidate, `replace()` removes the **first** occurrence
— the one in the stable block. This is usually safe because the copy
inside the dynamic injection stays.

When it is **not** safe: if a candidate substring appears ONLY inside
an injected block (not in any stable block), the first (and only)
occurrence IS inside the injection — `replace()` eats dynamic content.

Guard:
* Before reorder, scan `original` for **all** structural markers. Three
  marker categories are recognized:
  - XML opening tags `<tagname>` (lowercase, alphanumeric + `-`/`_`)
  - XML closing tags `</tagname>`
  - HTML comment START/END pairs `<!-- NAME:START --> ... <!-- NAME:END -->`
* After reorder, scan the result for the same markers.
* If any marker present in `original` is missing from the result →
  **fall back to the original prompt** (no reorder), flip
  `promptTruncationDetected` flag. The model receives a complete
  prompt; cache stability is sacrificed for integrity.
* `publishStatus` reads the flag once, appends ` ⚠️ integrity` to
  the footer status line, and resets the flag — the warning is
  visible for exactly one status update.
* The guard is **extension-agnostic**: trellis `<workflow-state>`,
  hypothetical `<task-tracker>`, AGENTS.md `<!-- TRELLIS:START -->`,
  or any future extension's structural markers are all protected
  without code changes when new extensions ship.
* Tags with attributes (`<task id="42">`) are deliberately not picked
  up: the pi extension ecosystem currently does not emit them, and
  including them would require a more permissive regex that risks
  false positives on prose like `<3` or `<= x`.
* Markdown headers, horizontal rules, and timestamp patterns are not
  used as guards: they have no closing form and cannot reliably
  signal "missing in result".

When the user sees ` ⚠️ integrity` in the footer:
1. The prompt sent to the model is the **original** (extension-injected)
   prompt — no reorder was applied on that turn.
2. The cause is almost always an upstream format change (e.g. trellis
   update, or a new extension introducing a substring collision).
3. `/reload` may help if the collision depends on per-turn state;
   otherwise, degrades gracefully (cache miss, no prompt corruption).
