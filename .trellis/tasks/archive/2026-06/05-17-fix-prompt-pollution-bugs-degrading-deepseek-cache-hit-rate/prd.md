# Fix prompt-pollution bugs degrading DeepSeek cache hit rate

## Goal

Real-world observation: with the same total token volume, this user's DeepSeek bills via pi
are ~2× higher than via Claude Code. The signal points at cache hit rate, not pricing tier
(both clients are on the same DeepSeek 1M-context endpoint).

Investigation in this session uncovered concrete bugs in pi's prompt assembly that bloat,
mangle, and partly destabilize the system prompt every turn. Fix the highest-confidence
bugs first ("Tier 1"), then verify cache hit rate via the extension's footer counters.

## What I already know (from this session)

* **Bug 1 — Trellis tool registration passes a string where pi expects `string[]`.**
  `.pi/extensions/trellis/index.ts:1077` registers the `subagent` tool with
  `promptGuidelines: SUBAGENT_DISPATCH_PROTOCOL` (bare string). Pi's
  `_normalizePromptGuidelines` (`agent-session.js:634`) does `for (const g of guidelines)`,
  which iterates a string character-by-character. Result: ~57 unique chars become ~57
  separate single-char "guidelines" (`- S`, `- u`, `- b`, …, `- I`). Visible in the live
  system prompt this turn.

* **Bug 2 — `[object Object]` bloat in dynamic remainder.**
  ~32 literal `[object Object]` lines appear after the `---` divider in the live system
  prompt. Source not yet identified; likely a string-vs-array mistake in the trellis
  extension or in how the cache-optimizer iterates one of its inputs.

* **Bug 3 — `optimizeSystemPrompt` is fragile against short candidates.**
  `extension.ts` does `rest = rest.replace(part, "")` for each stable candidate. With Bug 1
  feeding it 57 entries like `- S`, `- u`, …, each `replace` consumes the first occurrence
  of a 3-byte string anywhere in `rest`, ripping arbitrary bytes out of unrelated text.
  Even if Bug 1 is fixed upstream, the cache-optimizer should refuse short / ambiguous
  candidates as a defense-in-depth measure.

* **Validation surface available:** the cache-optimizer already shows
  `DS cache X/Y · …M/…M tok (Z%)` in pi's footer and persists counters at
  `~/.pi/agent/pi-cache-optimizer-stats.json`. We can compare same-day before/after.

* **DeepSeek pricing math.** Cache hit ≈ 1/10 of cache-miss input price (e.g.
  $0.145 vs $1.74 per 1M tok at 1M-pro tier per the seed). A drop from ~85% to ~40%
  hit rate roughly doubles spend at constant total tokens — consistent with the user's
  observation.

## Decisions (resolved)

* **D1 (scope) — option 3 chosen.** Apply both the cache-optimizer hardening (Bug 3) AND a
  local patch to `.pi/extensions/trellis/index.ts:1077` (Bug 1). Mark the trellis edit with
  a clear `LOCAL PATCH` comment so a future `trellis update` makes it visible if the
  upstream still hasn't fixed it. After this task, the user will open an upstream PR
  against `mindfold-ai/Trellis:src/templates/pi/extensions/trellis/index.ts` so the fix
  reaches all users.

* **D2 (upstream verification — done in this session)**
  - Updated `@mindfoldhq/trellis` 0.5.13 → 0.5.16 (latest stable). Bug 1 is still present
    at line 1077 of `dist/templates/pi/extensions/trellis/index.ts.txt`.
  - Also checked beta `0.6.0-beta.17`. Same bug at line 1079.
  - No related issues open in the upstream repo.
  - Repo `github.com/mindfold-ai/Trellis` is public, AGPL-3.0, accepts bug fix PRs per
    `CONTRIBUTING.md` / `CONTRIBUTING_CN.md`, no CLA, no AI-specific restrictions.

* **D3 (Bug 2 strategy)** — Treat as follow-up. Investigate root cause briefly during
  Bug 3 work; if not obvious, file as separate task with the captured evidence rather
  than blocking this one. The Bug 3 hardening (skip short / structurally invalid
  candidates) defends the cache-optimizer against most string-vs-array regressions even
  without naming the exact source.

## Open Questions

* (none currently blocking — see Decisions)

## Requirements (evolving)

* R1: Trellis `subagent` tool no longer pollutes guidelines list with single-char entries.
  After fix, `Guidelines:` section shows only well-formed multi-char bullets.
* R2: `optimizeSystemPrompt` rejects candidates shorter than a safe threshold so a similar
  upstream regression cannot mangle the dynamic remainder again.
* R3: No `[object Object]` strings appear in the rendered system prompt.
* R4: Footer `DS cache` hit rate visibly improves on a same-flow comparison
  (e.g. open a project, ask 5 short repeated questions).

## Acceptance Criteria (evolving)

* [x] Trellis (`.pi/extensions/trellis/index.ts:1077`): `subagent` registration uses
      `promptGuidelines: [SUBAGENT_DISPATCH_PROTOCOL]` (array form). A `LOCAL PATCH`
      comment block above the change names the upstream file path
      (`src/templates/pi/extensions/trellis/index.ts`) and the rationale.
* [ ] After fix, the live system prompt no longer contains the `- S`, `- u`, … bullets
      (verified via /diagnostics or by inspecting an outgoing request).
      — awaiting `/reload` + in-pi observation by the user.
* [x] Cache-optimizer (`extension.ts`): `optimizeSystemPrompt` rejects candidates whose
      trimmed length is below a constant `MIN_STABLE_CANDIDATE_LENGTH = 8`. Constant
      lives at module top with a brief comment explaining why.
* [x] Test added (`.trellis/tasks/.../verify.ts`): given junk single-character guidelines,
      `optimizeSystemPrompt`'s dynamic remainder is byte-equal to a control run with the
      junk filtered out. Runs via `bun verify.ts`. Negative-mutation run
      (threshold = 0) confirms the test catches the regression.
* [ ] `[object Object]` bloat: deferred to follow-up. Bug 3 hardening contains the
      blast radius. Root-cause hunt left for a separate task; current PRD's Out of
      Scope notes this.
* [ ] Manual verification: footer `DS cache` hit rate on a controlled 5-prompt repeat
      sequence is higher post-fix than pre-fix, with both numbers recorded in the
      journal entry. Acceptable noise floor: pre-fix < 50% and post-fix ≥ 70% on the
      same flow within the same local day.
      — awaiting user-run flow after `/reload`.

## Definition of Done

* Lint / typecheck / test green for `extension.ts` and the trellis vendored file
  (use whatever the project's `package.json` exposes; do not introduce a new test runner).
* Existing extension behavior preserved: DeepSeek auto-seed, footer stats, stable-prefix
  reordering for healthy inputs, persisted counters round-trip across sessions.
* Journal entry includes:
  - Before/after `DS cache` numbers from a controlled session
  - Upstream PR description template ready to copy-paste against `mindfold-ai/Trellis`
    (Conventional Commit `fix(pi): subagent promptGuidelines must be string[] not string`,
    repro, fix, expected impact)
* No new `console.warn` regressions during normal pi startup.

## Out of Scope

* Tier 2 changes: removing/trimming `<session-overview>`, moving `<workflow-state>` out of
  the system prompt. Those need separate design discussion (they affect trellis UX).
* Disabling pi's auto-compaction or changing its threshold.
* Changing DeepSeek model id from `deepseek-v4-pro` to `deepseek-chat` (pricing tier
  change — not the bug being fixed here).
* Upstreaming the trellis fix to wherever the trellis extension is maintained.

## Technical Notes

* Files of interest:
  - `extension.ts` — `optimizeSystemPrompt` and `buildStableCandidates` (this repo)
  - `.pi/extensions/trellis/index.ts:1077` — the `subagent` registration
  - `.pi/extensions/trellis/index.ts:790` — `SUBAGENT_DISPATCH_PROTOCOL` constant
* Pi internals consulted (read-only):
  - `dist/core/system-prompt.js` — base prompt builder
  - `dist/core/agent-session.js:634` — `_normalizePromptGuidelines` (the iteration site)
  - `dist/core/system-prompt.d.ts` — confirms `promptGuidelines?: string[]`
* Cache mechanics: DeepSeek KV cache is automatic prefix-based at 64-token granularity;
  long retention is requested via `PI_CACHE_RETENTION=long` (already set by this extension).
* Verification harness: footer counters + DeepSeek billing dashboard "cached input tokens".
