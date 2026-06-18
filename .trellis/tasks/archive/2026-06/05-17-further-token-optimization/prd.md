# Further prompt & token optimization (post-2.1.0)

## Goal

After the 2.1.0 skills-compression + session-overview-churn-strip release
(token cache ratio climbed from ~84% to ~99.9% per-turn), the biggest
remaining cost lever is **conversation history bloat**. This session alone
has 162K estimated tokens of conversation content, of which:

- 33.2% — thinking blocks (model's internal reasoning, zero ongoing value)
- 61.7% — tool results (large diffs, file contents)
- 4.8% — assistant text (valuable)
- 0.3% — user messages (valuable)

**76% of conversation history is dead weight** that can be safely stripped
or compacted without affecting model output quality.

## Prioritized plan

### Phase 1: Thinking blocks stripping (P0 — highest ROI, zero risk)

**What**: Strip `type: "thinking"` content blocks from conversation history
before each provider request.

**Why**: Thinking blocks are the model's internal reasoning scratchpad.
Once a response is emitted, the thinking content has zero ongoing value
for context. Claude Code strips them from history. Every other leading
AI coding tool (Cursor, Copilot, Codex) does the same.

**Estimated savings**: ~33% of session tokens. On this session: 53,808
tokens → pure savings.

**Risk**: None. Thinking blocks are never referenced by the user, never
used in multi-turn reasoning, and stripping them is the industry standard.

**Implementation**:
- Hook `before_provider_request` (or a new custom hook if available)
- Walk `event.payload.messages` array
- For each assistant message, filter content blocks to remove
  `type: "thinking"` entries
- Cache-safe: removed blocks are at the END of each assistant message
  block list, so the prefix cache for EARLIER blocks is unaffected

### Phase 2: Reasoning level optimization (P1 — output token savings)

**What**: Auto-detect when a prompt is trivially simple (e.g., "cache hit
test", "yes", "continue") and set reasoning to minimal or off.

**Why**: DeepSeek v4's thinking blocks cost BOTH input AND output tokens.
For short prompts, the thinking overhead can exceed the actual response.

**Estimated savings**: 1-5K output tokens per trivial turn.

**Risk**: Low — only affects turns where reasoning is clearly wasted.

### Phase 3: Stale tool result compaction (P2 — moderate risk, moderate ROI)

**What**: When a tool result is superseded by a later result of the same
kind, summarize or drop the old one.

**Why**: Old git status, old ls output, old read contents — all become
noise once a fresher version appears.

**Estimated savings**: 20-30% of tool result tokens.

**Risk**: Need to correctly identify "superseded" — e.g., a `git status`
from turn 2 is superseded by a `git status` from turn 5. But a `read`
might return adjacent file sections, not overlapping ones. Requires
tool-specific heuristics.

### Phase 4: DeepSeek cache_control experiment (P3 — unknown risk, high ROI)

**What**: Test whether DeepSeek supports Anthropic-style `cache_control:
{type: "ephemeral"}` markers in content blocks.

**Why**: If supported, we can create explicit cache breakpoints (like
Claude Code), which would let us cache DISCONTINUOUS blocks of the prompt
rather than just one continuous prefix. This means dynamic injections
between cache breakpoints don't invalidate the cache.

**Implementation**: Add an experimental `--cache-control` flag that
inserts markers, run a test turn, check `cacheRead` in message_end.

### Phase 5: Conversation summary compaction (P4 — complex, risky)

**What**: When session token count exceeds a threshold, auto-summarize
older conversation and replace with a condensed system message.

**Why**: Claude Code's approach to bounded-context sessions.

**Risk**: Model might lose nuanced instructions from early turns.

## Out of Scope

- Multi-model routing (use cheap model for simple tasks) — user-level
  decision, not extension-level
- AGENTS.md dedup — minor savings (~500 bytes), not worth code complexity
- Image/attachment compression — not relevant to current use pattern
- Trellis vendored patches — Q1 from previous task locked to no

## Resolution Summary (2026-05-17)

| Phase | Direction | Status |
|-------|-----------|--------|
| P0 — Thinking blocks stripping | DeepSeek v4 requires thinking blocks for multi-turn reasoning chain. Pi already handles optimally (stores under signature key, not in `content`). | ❌ Canceled |
| P1 — Tool result compaction | Prefix cache hit at 99.9% makes per-turn savings marginal. Old results are cached, not re-billed. | ❌ ROI too low |
| P2 — Reasoning level optimization | User-level decision; not extension-level. `/reasoning off` already available. | → Deferred to user |
| P3 — DeepSeek `cache_control` experiment | **Officially confirmed**: DeepSeek's Anthropic API compat page lists `cache_control` as "Ignored" for ALL content types. DeepSeek uses disk-based prefix KV cache, not explicit breakpoints. | ❌ Not supported |
| P4 — Stats precision improvement | `cacheRead` already sourced from DeepSeek's `prompt_cache_hit_tokens` via pi's adapter. No precision gain available. | ✅ Already optimal |
| P5 — Conversation compaction | Remaining theoretical lever. Complex, quality-risky, needs separate task. | → Future task |

### What shipped in 2.1.0
- Skills XML compression (93.5% cut on skills block)
- Session-overview churn strip (RECENT COMMITS, Working directory, Line count)
- Workflow-state integrity guard
- Token cache ratio: 84% → 99.9% per-turn (post-first-miss)

### DeepSeek API research references
- `/guides/kv_cache` — disk-based automatic prefix caching, `prompt_cache_hit_tokens`/
  `prompt_cache_miss_tokens` fields
- `/guides/anthropic_api` — `cache_control` explicitly **Ignored** for all content types
  (text, tool_use, tool_result, tools)
- Cache write is automatic (disk persistence); no `cacheWrite` field from DeepSeek

### Outcome
This task confirmed we've hit DeepSeek's theoretical cache-efficiency ceiling at 99.9%
per-turn token cache ratio. Remaining cost levers are: (1) conversation summary
compaction for very long sessions, (2) reasoning-level tuning for trivial prompts
(user-side), (3) switching models for simple tasks (user-side).

## Acceptance Criteria

* [x] P0: Investigated — canceled (DeepSeek needs thinking blocks)
* [x] P0: No regression in cache hit rate (maintained 99.9%)
* [x] P0: No observable change in model output quality
* [ ] P1: Reasoning auto-adjustment — deferred to user (`/reasoning off`)
* [x] P2: Tool result compaction — assessed, ROI too low at 99.9% hit
* [x] P3: cache_control experiment documented — DeepSeek explicitly ignores
* [x] Stats precision — already optimal, no change needed
