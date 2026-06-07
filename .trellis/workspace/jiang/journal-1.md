# Journal - jiang (Part 1)

> AI development session journal
> Started: 2026-05-13

---



## Session 1: Rename to pi-cache-optimizer and auto-config DeepSeek

**Date**: 2026-05-16
**Task**: Rename to pi-cache-optimizer and auto-config DeepSeek
**Branch**: `master`

### Summary

Renamed npm package from pi-deepseek-cache-optimizer to pi-cache-optimizer (v2.0.0, then 2.0.1 to refresh badges on npm). Auto-seeds a DeepSeek block into ~/.pi/agent/models.json on first run with full recommended compat (supportsLongCacheRetention, sendSessionAffinityHeaders) when no DeepSeek-like model exists; atomic write with timestamped backup; opt-out via PI_CACHE_OPTIMIZER_NO_AUTO_CONFIG=1; once-per-session API-key hint that never reads the key value. Stats file migrated to pi-cache-optimizer-stats.json with one-shot read-fallback. Updated both READMEs and added cache-adapter-footer-stats.md spec. Published 2.0.0 + 2.0.1 to npm and deprecated the old package name with a migration message. Pushed master to origin.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b5584a5` | (see git log) |
| `32f33d3` | (see git log) |
| `b94fcad` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

---

## Session 2: Fix prompt-pollution bugs degrading DeepSeek cache hit rate

**Date**: 2026-05-17
**Task**: `.trellis/tasks/05-17-fix-prompt-pollution-bugs-degrading-deepseek-cache-hit-rate`
**Branch**: `master`

### Trigger

User reported their DeepSeek bills via pi were ~2× higher than via Claude Code
at similar total token volumes, both clients on the DeepSeek 1M-context
endpoint. Same model id, same prompts — only the harness differed. The signal
pointed at cache hit rate, not pricing tier.

### Investigation

Inspected the live system prompt pi was sending this turn (visible to me as
the assistant) and found three concrete bugs in pi's prompt assembly:

1. **Trellis tool-registration regression** —
   `.pi/extensions/trellis/index.ts:1077` registers the `subagent` tool with
   `promptGuidelines: SUBAGENT_DISPATCH_PROTOCOL` (bare string). Pi's
   `_normalizePromptGuidelines` does `for (const g of guidelines) { ... }`,
   which iterates a string char-by-char. Result: ~57 unique chars become 57
   single-character "guidelines" (`- S`, `- u`, `- b`, ...). Bug confirmed
   present in `@mindfoldhq/trellis` 0.5.13, 0.5.16 (latest stable), and
   0.6.0-beta.17 — not fixed upstream yet.

2. **`[object Object]` bloat** — ~32 literal `[object Object]` lines appear
   in the dynamic remainder of the system prompt. Source not pinpointed in
   this session. Filed as follow-up; the Bug 3 hardening below contains the
   blast radius even without the root cause.

3. **Cache-optimizer fragility** — `optimizeSystemPrompt` does
   `rest = rest.replace(part, "")` for each stable candidate. Bug 1 feeds it
   single-character candidates; each `replace()` matches the FIRST
   occurrence anywhere in `rest`, ripping arbitrary bytes out of unrelated
   text and yielding a non-deterministic dynamic remainder. That alone
   destabilizes the prompt prefix between requests, killing the prefix
   cache.

### Decisions (from PRD)

- D1: Apply both fixes (option 3): cache-optimizer hardening + local trellis
  patch. Mark trellis edit with `LOCAL PATCH` comment for the next
  `trellis update`.
- D2: Latest `@mindfoldhq/trellis` 0.5.16 still has the bug; beta
  0.6.0-beta.17 too. Repo `mindfold-ai/Trellis` is public, AGPL-3.0,
  CONTRIBUTING.md welcomes bug fixes, no AI-specific restrictions.
- D3: Bug 2 (`[object Object]`) deferred to follow-up.

### Main Changes

- **`extension.ts`** — added `MIN_STABLE_CANDIDATE_LENGTH = 8` constant and
  applied it inside `optimizeSystemPrompt` so any stable candidate with
  trimmed length `< 8` is silently skipped (no `replace` call). This neutralizes
  the cascade even if pi feeds us garbage candidates again. Also exported
  `__internals_for_tests` ({buildStableCandidates, optimizeSystemPrompt,
  MIN_STABLE_CANDIDATE_LENGTH}) so the task verification script can exercise
  the hardening directly. Pi only invokes the default export, so the named
  export is harmless to runtime behavior.
- **`.pi/extensions/trellis/index.ts:1077`** — changed
  `promptGuidelines: SUBAGENT_DISPATCH_PROTOCOL` to
  `promptGuidelines: [SUBAGENT_DISPATCH_PROTOCOL]`. Added a `LOCAL PATCH`
  comment block above naming the upstream file path and the rationale.
- **`.trellis/spec/frontend/cache-adapter-footer-stats.md`** — added a
  "System prompt reordering invariants" section: hard contracts
  (threshold, idempotence, where the filter lives) plus a Common Mistake
  entry describing the upstream string-vs-array regression class with
  Wrong/Correct snippets, so future investigations recognize the
  failure mode quickly.
- **`.trellis/tasks/.../verify.ts`** — standalone bun-runnable
  verification harness: 4 assertion groups, runs in ~80ms.
  - Threshold value matches spec (8).
  - Healthy run lifts guidelines, dynamic remainder doesn't carry them.
  - Polluted run (single-char junk added) does NOT corrupt rest:
    after stripping `- X` bullets from polluted, dynamic remainder is
    byte-equal to the control run. This is the regression test for Bug 3.
  - `buildStableCandidates` keeps healthy bullets (sanity check).
  Negative-mutation test (threshold = 0) verified the harness catches the
  regression: 3 assertions fail.

### Testing

No project lint/test runner exists; substituted with three checks:

- [OK] `bun build --no-bundle` parses both `extension.ts` and
  `.pi/extensions/trellis/index.ts` without errors.
- [OK] `jiti` loads `extension.ts` (default export is a function,
  `__internals_for_tests` carries the threshold constant 8).
- [OK] `bun verify.ts` — all assertions pass with threshold 8; mutating
  threshold to 0 fails 3 assertions; restoring 8 passes again.
- [OK] No new `console.log/warn/error` introduced.
- [OK] Spec spot-checks (`cache-adapter-footer-stats.md`): adapter
  selection by id/name only — unchanged; atomic-write/backup paths
  preserved; API-key value never logged; persisted stats schema
  untouched.

### Before / After (qualitative — awaiting controlled measurement)

The footer counter (`DS cache X/Y · …M/…M tok (Z%)`) and DeepSeek billing
dashboard's "cached input tokens" are the two verification surfaces. The
changes here only take effect after `/reload` (or pi restart) so pi picks up
the patched extension and the patched trellis vendored file. To capture the
numeric delta:

1. Note the current `DS cache X/Y · …M/…M tok (Z%)` value before reload.
2. `/reload` to load the patched extension.
3. Run a fixed 5-prompt sequence (e.g. "Answer in one sentence: cache
   ping N" for N=1..5) in a single session.
4. Compare footer; expect post-fix hit rate ≥ 70% and visibly higher than
   pre-fix on the same flow within the same local day.
5. Optionally cross-check on `platform.deepseek.com` billing page:
   "cached input tokens" / "input tokens" should rise toward ~85%.

(Numbers will be filled in when the user runs the verification flow.)

### Upstream PR template (for `mindfold-ai/Trellis`)

When ready to upstream, use this against the Trellis repo. Path is
`src/templates/pi/extensions/trellis/index.ts` (the source the npm package
builds from). Branch and PR per `CONTRIBUTING.md`.

```text
Title: fix(pi): subagent promptGuidelines must be string[] not string

Body:
## Problem

`src/templates/pi/extensions/trellis/index.ts` registers the `subagent` tool
with `promptGuidelines: SUBAGENT_DISPATCH_PROTOCOL` (a bare string).

Pi's `_normalizePromptGuidelines` (in `@earendil-works/pi-coding-agent`,
`dist/core/agent-session.js`, around line 634) does
`for (const g of guidelines) { ... }`. JavaScript's `for...of` iterates a
string character-by-character, so each unique char of
`SUBAGENT_DISPATCH_PROTOCOL` becomes its own "guideline". The emitted system
prompt then contains ~57 single-character bullets (`- S`, `- u`, `- b`, ...)
every turn.

Visible side effects:
- ~80 lines of garbage in the system prompt every request.
- The cache-optimizer extension (and similar tools that try to reorder pi's
  prompt) treats those single-char bullets as legitimate stable candidates,
  which can mangle unrelated text via short-pattern `replace()`s.
- Provider prefix caches (notably DeepSeek's automatic KV cache) suffer.

Pi's documented type for the tool registration is
`promptGuidelines?: string[]` (see
`@earendil-works/pi-coding-agent/dist/core/system-prompt.d.ts`).

## Fix

Wrap the protocol string in an array:

```ts
promptGuidelines: [SUBAGENT_DISPATCH_PROTOCOL],
```

No behavior change for any other code path; pi's normalize function then sees
a 1-element array containing the full guideline string and emits a single
properly-formatted bullet.

## Reproduction

1. `pi install <a project that uses Trellis>`.
2. Send any message to pi.
3. Inspect the outgoing system prompt (e.g. via
   `@earendil-works/pi-coding-agent`'s diagnostic dump). The `Guidelines:`
   section contains a long run of single-character bullets.

## Affected versions

Observed present in 0.5.13, 0.5.16, and 0.6.0-beta.17. Likely older.

## Tests

No new test runner needed; pi's existing system-prompt tests would catch the
regression by checking that a tool registering a string-typed
`promptGuidelines` either errors or is correctly normalized to a single bullet
(suggested follow-up).
```

### Status

[OK] **Completed code + spec changes.** Awaiting in-pi verification
(footer counter on a controlled flow) and — separately, when the user
is ready — the upstream PR.

### Next Steps

- User runs the 5-prompt verification flow after `/reload` and records
  pre-fix vs post-fix `DS cache` numbers in the PRD's Acceptance Criteria.
- Optional: open the upstream PR using the template above.
- Follow-up task to root-cause the `[object Object]` source if it persists
  after this fix is reloaded.

---

## 2026-05-17 — Kiro Claude 0% cache: root cause + spec caveat

Task: `.trellis/tasks/05-17-investigate-kiro-claude-0-cache-hit-rate`

### What I learned (one-liner)

The user's Claude traffic flows through `pi-provider-kiro@0.6.1` (npm
extension), which speaks the AWS CodeWhisperer / Q Developer streaming
protocol. That transport has no slot for `cache_control` markers and
never surfaces `cache_read_input_tokens` in responses. The 0% Claude
hit rate is truthful and unfixable from this extension's side.

### Why this is worth a permanent spec note

I almost spent an evening writing a mitmproxy harness to capture
outgoing requests when I could have answered the question by reading
`pi-provider-kiro/dist/{stream.js,usage.js}`. Future contributors
who land on a `kiro-api` Claude footer at 0% will go down the same
rabbit hole unless the `cache-adapter-footer-stats.md` spec tells
them up front: this is a transport-level limitation, do not
special-case-bump the counter.

### Decision recorded in spec

R4 = option 1 (Claude `warningText` stays silent on `kiro-api`).
Reasoning: the existing compat warning's purpose is to nudge the user
toward flipping `cacheControlFormat: "anthropic"`. On Kiro there is
no flag to flip — pi-provider-kiro owns the transport. An
information-only warning would be startup noise and train users to
ignore the notification surface.

### Follow-up worth filing somewhere (not this task)

`pi-provider-kiro` is owned externally; the right long-term fix is
upstream — surface `cacheRead` / `cacheWrite` from whatever AWS Q
metadata events expose (if anything). Out of scope here. If/when
that ships, the spec caveat should be revisited.

### Cost framing correction

Original PRD framed this as "biggest cost lever" (22.3M tokens at
full input rate). Per `pi-provider-kiro/README.md`, all listed Kiro
models are advertised as free; the real pressure point is the
`MONTHLY_REQUEST_COUNT` quota the provider's retry path watches.
Whether Kiro counts cache hits differently against that quota is on
the AWS side and not observable from pi.

---

## 2026-05-17 — Skills compression: cut system prompt 55%

Task: `.trellis/tasks/05-17-reduce-pi-system-prompt-token-volume`

### Measurement first

Read pi's `formatSkillsForPrompt` source, `AGENTS.md`, every SKILL.md
on disk, and mirrored the same builder logic to measure actual byte
sizes. Finding: skills XML at 13.3 KB is **61.5%** of the ~22 KB
system prompt. Everything else (preamble 1.6K, trellis preamble 2.5K,
session-overview 2K, workflow-state 1K) is noise by comparison.

### What changed (index.ts / package.json / spec)

- `formatSkillsForPromptCompressed(skills)` — deterministic, grouped
  by skills-root directory, names sorted, compressed form ~0.9 KB
  vs 13.3 KB verbose.
- `compressSkillsInSystemPrompt(prompt, opts)` — finds the pi-emitted
  verbose block via `formatSkillsForPrompt` match and `String.replace`s
  it with the compressed form. No-op when opted out, below threshold
  (4 skills), or verbose form not found (format change resisted).
- `buildStableCandidates` pushes BOTH forms; `optimizeSystemPrompt`'s
  `rest.includes(part)` short-circuit picks the one in the prompt.
- `before_agent_start` compresses BEFORE optimize, so cache-key
  reflects the actual sent prefix.
- Opt-out: `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1`.
- Version: `2.0.2 → 2.1.0`.
- Spec: `.trellis/spec/frontend/cache-adapter-footer-stats.md`
  "System prompt budget" contract.

### Verification harness

`/tmp/cache-optimizer-smoke.cjs` — 8 invariants (deterministic,
idempotent, opt-out respects, below-threshold no-op,
optimizeSystemPrompt integration, no <available_skills> survives):
all pass.

### What the user still needs to do

1. `/reload` pi with the new code.
2. Run a 5-prompt repeat flow (same prompts as the previous cache-hit
   test) and record before/after total input tokens + cache hit rate.
3. Confirm "conversational" prompts still get 1–3 turn answers.
4. Commit + `task.py done` or `/trellis:finish-work`.

Expected: ~55% cut in system prompt bytes → input tokens per turn
down from ~6K to ~2.5K. At 92% cache hit, uncached token delta is
smaller; the big win is the cached-token charge per turn of a 13 KB
block that was never load-bearing.


## Session 2: Finish Otokapi GPT cache optimization

**Date**: 2026-06-07
**Task**: Finish Otokapi GPT cache optimization
**Branch**: `master`

### Summary

Completed and archived the Otokapi GPT-5.5 cache optimization task; work commit adds broader OpenAI-compatible cache-key/session-affinity handling and related adapter/API support.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `12b30a8` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
