# Pi system prompt anatomy — measured snapshot

> Measured 2026-05-17 against this very session, using the actual on-disk
> SKILL.md / AGENTS.md / pi-coding-agent source. Estimate column for
> trellis injections is observed (not measured byte-for-byte) because pi
> doesn't ship a "dump system prompt to file" mode and we did not add a
> debug hook for this measurement.
>
> Reproduction: `python3 /tmp/measure-prompt-anatomy.py` from the project
> root. The script reads pi-coding-agent's `formatSkillsForPrompt` source
> (`/home/jiang/.volta/.../pi-coding-agent/dist/core/skills.js:258-285`)
> and mirrors it byte-for-byte for the skills block.

## Summary

| Section                                  | Bytes   | KB    | % of total |
| ---------------------------------------- | ------- | ----- | ---------- |
| Pi base preamble template                | 1,652   | 1.6   | 7.5 %      |
| AGENTS.md formatted block                | 1,089   | 1.1   | 4.9 %      |
| Project Context wrapper                  | 68      | 0.1   | 0.3 %      |
| **Skills XML block (31 skills)**         | **13,596** | **13.3** | **61.5 %** |
| Date + cwd footer                        | 96      | 0.1   | 0.4 %      |
| **Static subtotal (no trellis)**         | **16,501** | **16.1** | —      |
| Trellis preamble + dispatch protocol\*   | 2,500   | 2.4   | 11.3 %     |
| `<session-overview>` (mostly stable)\*   | 2,000   | 2.0   | 9.0 %      |
| `<workflow-state>` per-turn breadcrumb\* | 1,100   | 1.1   | 5.0 %      |
| **Estimated grand total**                | **22,101** | **21.6** | **100 %** |

\* trellis rows are observation-anchored estimates, not measurements.
The exact numbers depend on the trellis injection branch taken
(`no_task` vs `in_progress` etc.) and the active-tasks list length.

## Per-skill cost (top 10 of 31)

```
impeccable                626 bytes  (description 444 chars)
trellis-before-dev        554 bytes  (description 358 chars)
trellis-brainstorm        521 bytes  (description 325 chars)
critique                  503 bytes  (description 355 chars)
find-skills               487 bytes  (description 303 chars)
frontend-design           456 bytes  (description 294 chars)
trellis-check             454 bytes  (description 268 chars)
extract                   444 bytes  (description 298 chars)
harden                    440 bytes  (description 296 chars)
delight                   425 bytes  (description 279 chars)
... and 21 more skills
```

Per-skill XML overhead per entry (without description):
```
  <skill>
    <name>NAME</name>
    <description></description>
    <location>FULL_ABSOLUTE_PATH/SKILL.md</location>
  </skill>
```
That's ~110 bytes of pure XML overhead + the absolute filesystem path
(~70 bytes for the `~/.agents/skills/<name>/SKILL.md` form). For a
short-description skill, the XML envelope can outweigh the actual content.

Skills section header + footer add another 369 bytes of fixed overhead.

## What this tells us about the cost lever

1. **The skills XML block alone is 61.5 % of the system prompt.** 30 of
   31 skills are not relevant to any given turn. Pi ships their full
   description text in every system prompt regardless. This is the
   single biggest cut available.

2. The skills block is at a stable position (always emitted after the
   project-context block, before date/cwd) so it's currently 100 %
   cacheable. But "cacheable" only matters for cache-hit savings; the
   tokens are still billed (at the cached-input rate) on every request.
   Cutting the volume is independent of the cache rate already won.

3. The trellis per-turn churn (`<workflow-state>`) is small (~1.1 KB)
   relative to the skills block, but it's the chunk that destabilizes
   the cache for whatever sits AFTER it in the prompt. In pi's current
   ordering, the `<workflow-state>` is appended after the skills block
   via `appendSystemPrompt`, so it does not invalidate the skills
   block's cacheability — but if the cache-optimizer's `optimizeSystemPrompt`
   ever moves dynamic content above stable content, that protection
   would invert.

4. AGENTS.md is small (1.1 KB). It is duplicated by trellis preamble in
   meaningful ways (both list `.trellis/spec/`, `.trellis/tasks/`,
   `.trellis/workspace/`); deduping would save < 0.5 KB. Not the lever.

## How Claude Code compares (qualitative)

Claude Code does not eagerly inject skill catalogs or per-turn workflow
breadcrumbs into the system prompt. Anthropic's Skills feature loads a
skill's body only when the model itself calls a `Skill(name)` tool —
the system prompt only carries an index, not the descriptions, and the
index is small (one line per skill). Project-level `CLAUDE.md` is
loaded once and is roughly equivalent in role to `AGENTS.md` here.

Approximate cost difference per turn, on this same repo, same prompt:

* Pi today: ~22 KB system prompt × N turns × cached-input rate
* Claude Code-equivalent shape: ~6–8 KB system prompt × N turns
  (dropping ~13 KB skills block, ~1 KB workflow-state, ~1 KB session-overview tail)

That's roughly a **65 % cut** of the system prompt size, every turn,
without changing cache behavior, without changing tools, without
removing any user-facing capability — the model would still discover
skills via the existing one-line index and `read .pi/skills/<name>/SKILL.md`
when a task matches. (This mirrors Anthropic's lazy-load pattern.)

## Implementation surface

Two clean intervention points exist inside this extension's
`before_agent_start` hook:

1. **Replace the `<available_skills>` block** with a one-line index in
   `optimizeSystemPrompt` (post-build). Greppable: the block always
   starts with `<available_skills>` and ends with `</available_skills>`.
   No need to touch pi or trellis. Risk: regex-based string surgery on
   the prompt — must be defended the same way `MIN_STABLE_CANDIDATE_LENGTH`
   defends `replace()`.

2. **Re-build the prompt from `event.systemPromptOptions`** with a
   custom skills serializer that emits the compressed index. Cleaner;
   does not depend on pi's exact whitespace. Risk: re-builds duplicate
   work pi already did, and would need to mirror future pi prompt
   builder changes.

Recommendation if/when we ship this: option 2 (re-build), with a
fallback to option 1 if `systemPromptOptions` shape ever changes.

## What we still don't know

* The trellis row sizes are estimated, not measured. To replace them
  with measurements, add a one-shot env-gated dump in the cache-optimizer's
  `before_agent_start` hook (`PI_CACHE_OPTIMIZER_DUMP_PROMPT=1` writes
  the prompt to `/tmp/pi-system-prompt.txt`), run pi once, compare.
  Worth doing before we ship a compression change because we want
  before/after numbers from the SAME measurement method.
* Per-turn input tokens vs prompt bytes is roughly 1 token = 4 bytes
  for English text, but for skill descriptions with many camel-case
  identifiers, it's closer to 1 token = 3.5 bytes. So ~22 KB ≈ 6 K
  tokens of system prompt per turn. At 92 % cache hit, that's ~480
  uncached system-prompt tokens per turn just from prompt assembly,
  before any user content / tool output.
