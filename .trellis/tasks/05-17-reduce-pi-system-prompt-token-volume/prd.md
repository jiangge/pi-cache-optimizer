# Reduce pi system prompt token volume

## Goal

Cache hit rate is now ~92% (theoretical near-max). The remaining cost lever is
**reducing the absolute size of each request's input tokens**. Empirical signal
from a controlled test (2026-05-17, in this very repo, model
`deepseek/deepseek-v4-pro`):

* User sent a single short prompt: `cache hit test`
* Pi spawned **29 model turns** (one user message → 29 round trips)
* Total input: **2.35M tokens** (avg ~81K input/turn)
* Total output: **22,563 tokens**
* Cache hit: 91.5% (cached 2.15M / total 2.35M)
* Final cost ≈ $0.74 for one short prompt

The user reports this is still more expensive than Claude Code at apparently
similar token volumes. Two parallel hypotheses to validate:

1. **Pi runs more agent turns than Claude Code does for the same prompt** (the
   29-turn observation strongly suggests pi entered "do work mode" instead of
   "answer mode", likely triggered by trellis `<workflow-state>` injection).
2. **Pi's per-turn system prompt is bigger** than Claude Code's, so even at
   92% cache hit, the absolute token volume per turn is higher.

Both cost money. Both are independent of the cache-hit rate that the previous
task already maxed out.

## What I already know (from session inspection)

* Live system prompt this turn is roughly **30 KB**, dominated by:
  - Pi base preamble (`You are an expert coding assistant...`) + tool snippets
    + guidelines: ~3 KB
  - 31 skill XML descriptions emitted by `formatSkillsForPrompt`: ~6–10 KB
  - AGENTS.md content (Trellis instructions + skill list summary in the
    managed block): ~3 KB
  - Trellis `<session-overview>` (developer name, branch, recent commits,
    active tasks, journal file line count): ~2 KB
  - Trellis `<workflow-state>` per-turn breadcrumb (status + workflow guidance
    text): 200 B – 1 KB depending on status
  - Repeated/cosmetic content (lifted stable prefix may include a chunk that
    also appears in the dynamic remainder): noisy
* `<session-overview>` mostly stays stable within a session, so it benefits
  from cache. But its last entries (`Line count: N / 2000`, recent commits)
  shift turn-to-turn when the user commits or appends to journal — and that
  invalidates the tail.
* `<workflow-state>` is regenerated per turn but is small and at the end of
  the system prompt, so it only loses the trailing chunk of the cache.
* The 31 skills are emitted **regardless of whether the model would ever
  invoke them**. Most prompts touch 0–2 skills. The other 29 skills' XML
  descriptions are pure waste from a per-prompt cost POV.
* Claude Code by contrast does NOT inject git status / recent commits / per-turn
  workflow breadcrumbs into the system prompt. Skills (in Anthropic's Skills
  feature) are loaded lazily — only when the model requests them. Static
  system prompt → always cached, no churn.

## Hypotheses (largest to smallest expected ROI)

* **H1 (biggest lever)**: Trellis injection in `before_agent_start` causes the
  model to interpret short user messages as "do work" instructions. If we drop
  workflow-state injection when status is `no_task` (and trim session-overview
  to only branch + active task list), pi behaves more like Claude Code on
  conversational prompts → fewer turns per user message.
* **H2 (steady savings)**: Skills XML is the largest single chunk of system
  prompt and the most underutilized. Replacing the inline XML with a one-line
  index (`Available skills (read SKILL.md when needed): adapt, animate, ...`)
  would cut ~6–10 KB per turn while preserving discoverability. The model can
  still `read .pi/skills/<name>/SKILL.md` when a skill matches.
* **H3 (cosmetic)**: AGENTS.md TRELLIS:START block partially duplicates what
  `<workflow-state>` injects per turn. Some content can be deduped without
  losing fidelity.

## Open Questions (blocking)

* **Q1 (scope)**: Extension-only (this repo, npm-shipped to all users).
  Do NOT patch trellis vendored. Skills compression is the dominant
  lever (61.5 % of total prompt) and lives entirely in
  `optimizeSystemPrompt` / `before_agent_start` in this extension.
  Trellis can be revisited later if needed.
* **Q2 (skill compression aggressiveness)**: Option (b) — one-line
  index by default with opt-out env
  `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1`. See
  `research/system-prompt-anatomy.md` for measurement and
  `cache-adapter-footer-stats.md` → "System prompt budget" for the
  contract.
* **Q3 (workflow-state)**: Do NOT compress for now. The skills block
  alone gets us from ~22 KB to ~9 KB total system prompt. The
  workflow-state is small (~1 KB) and correctly in the dynamic
  remainder. Not worth the code complexity / trellis vendored patch
  overhead for marginal gains.
* **Q4 (verification target)**: ≥30 % input-token reduction on the
  same 5-prompt flow. Cache hit rate ≥ 80 %. Model still answers
  conversational prompts in 1–3 turns. Accepted.

## Assumptions (to validate)

* Claude Code's "smaller per-turn prompt" claim needs an actual measurement.
  We can collect this by running the same `cache hit test` prompt in Claude
  Code on this repo and recording its turn count + total input tokens.
* The cache-optimizer can intercept `before_agent_start` after trellis fires
  (or before — depends on hook ordering). Need to confirm via pi's hook
  registration order docs. If the cache-optimizer fires BEFORE trellis, we'd
  have to re-process trellis's appended content to compress it.
* Skills lazy-load is safe: the model already knows it can read files via
  `read`. The skills index just needs to clearly say "read SKILL.md when a
  task matches".

## Requirements (evolving)

* R1: Measure the actual byte breakdown of pi's system prompt this session,
  per category (preamble / tools / guidelines / skills / context-files /
  trellis-session / trellis-workflow-state / other). Persist findings in
  `research/system-prompt-anatomy.md`.
* R2: Run apples-to-apples comparison with Claude Code on this same repo:
  same prompt, count turns and total input tokens. Persist in
  `research/claude-code-baseline.md`.
* R3: Pick 1–2 cuts (per Q1–Q3) that the user approves, implement, ship via
  patch version (e.g. `2.0.3` or `2.1.0` if compression is opt-in default).
* R4: Verification flow with documented before/after numbers in journal.

## Acceptance Criteria (evolving)

* [x] System prompt anatomy measured and persisted —
      `research/system-prompt-anatomy.md`.
* [ ] Claude Code baseline measured and persisted — *deferred; the
      skills-block measurement alone shows a 61.5 % cut is available
      without needing the Claude Code comparison. The comparison is
      qualitative only (see anatomy research for notes).*
* [x] Cuts implemented:
      - Skills XML → compact index (one-liner grouped by
        skills-root directory), default on, opt-out via env.
      - Workflow-state / session-overview left alone (small
        relative to skills, correctly in dynamic remainder).
      - No trellis vendored patch (Q1 = extension-only).
* [x] Version bumped to 2.1.0. Opt-out
      `PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1` preserved.
* [ ] Footer cache hit rate ≥ 80 % on 5-prompt repeat — *user verifies*.
* [ ] Total input tokens reduced ≥ 30 % vs pre-change baseline —
      *user verifies*.
* [x] No public API removed. Opt-out preserved.
* [ ] Trellis vendored — N/A (Q1 = extension-only).

## Definition of Done

* Verification numbers (input tokens before/after, cache hit rate before/after,
  agent turn count for one short prompt) recorded in journal.
* Spec updated in `.trellis/spec/frontend/cache-adapter-footer-stats.md` —
  add a "System prompt budget" subsection that codifies what counts as
  cacheable-and-stable vs cacheable-and-volatile vs uncached, plus the
  threshold contract (e.g. "skill XML > 1 KB total triggers compression").
* Optional: GitHub release notes for the bumped npm version.

## Out of Scope

* Anything that improves cache hit rate (already at 92%, can't squeeze more).
* Switching to a different model / different provider / different pricing tier.
* Generic "rewrite pi's prompt builder for everyone" — only changes scoped
  to (this extension) + (trellis vendored as an isolated LOCAL PATCH if Q1
  goes that way).
* Insertion of Anthropic-style cache_control breakpoints (separate task
  `05-17-investigate-kiro-claude-0-cache-hit-rate` covers that for Claude).
* Implementing a generic "skill lazy-load" feature in pi core upstream
  (potential follow-up; not blocking this task).

## Technical Notes

* Files of interest:
  - `index.ts` (this repo) — `optimizeSystemPrompt`, `buildStableCandidates`,
    `formatSkillsForPrompt`. The skills XML emitter is a candidate for the
    compression intervention.
  - `.pi/extensions/trellis/index.ts` — `before_agent_start` hook at line
    ~1140 is where `[current, context, perTurn]` get joined. The
    `buildPerTurnInjection` and `buildTrellisContext` functions decide what
    goes in. `<workflow-state>` parser is at line ~640.
  - `@earendil-works/pi-coding-agent/dist/core/system-prompt.js` — pi's base
    builder; we don't modify pi but understanding what it emits is essential.
  - `@earendil-works/pi-coding-agent/dist/core/skills.js` —
    `formatSkillsForPrompt` is the source of the 31-skill XML block. Pi's
    own version is byte-identical to the cache-optimizer's; either could be
    intercepted.
* Measurement approach for R1: read this current session's JSON from
  `~/.pi/agent/sessions/`, find the system prompt, count bytes per section.
* Measurement approach for R2: open Claude Code in this repo, send the same
  short prompt, look at Anthropic's API usage stats or use a proxy to
  capture request body sizes.
* Hook ordering question for Q1: pi's docs likely describe extension hook
  ordering — check `docs/extensions.md` if needed.
