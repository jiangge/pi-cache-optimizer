# Follow-up: cross-day session statistics review

## Scope

The current working tree already contained a Pi 1.0.2 dependency update and a
partial cross-day session-footer change. The user requested review, then explicitly
requested implementation in the main session without sub-agents. The original
Pi 1.0.1 PRD/evidence describes an earlier completed baseline upgrade, not these
new changes. This follow-up preserves the existing 1.0.2 manifest/lockfile edits;
it does not claim a new clean-install or full upstream API comparison.

## Proven findings

1. Passing `undefined` to `aggregateStatsShardsV7` still activates its default
   current-day parameter. Yesterday's shards disappeared despite the new README
   promise to retain session history.
2. Skipping rollover in session mode left yesterday's process counters under a
   new top-level shard day. These counters disappeared from aggregation and
   could be cleared on a later mode change. Simply making aggregation all-days
   would not preserve the separate daily total/process contract.

## Implementation

- Use explicit `null` to aggregate retained days; omitted/undefined retains the
  existing daily default.
- Keep session footer aggregation independent of daily totals and stats commands.
- Close the old daily shard with its captured date and rotate to a fresh UUID
  before resetting daily counters, regardless of footer mode.
- Capture queued write paths with their snapshots so rotation cannot redirect
  an old write into a new shard.
- Serialize rollover. Failed archives warn without throwing and keep the retired
  snapshot in memory; reload cannot recover an archive that never reached disk.
- Keep the pre-existing 60-day retention change and synchronize README/specs.

## Regression evidence

The first two new tests failed before the fix: yesterday was missing after reload,
and the same instance lost its midnight session footer counters. Six new tests
now cover retained history on reload, rollover from session/total/process modes,
mode switches, reset epochs across historical days, idle midnight shutdown,
other-session isolation, and failed archive in-memory fallback.

Final verification on installed `pi-coding-agent@1.0.2` / `pi-server@1.0.2`:

- `npm run typecheck`: passed.
- `npm test`: 178 passed, 0 failed.
- `npm run check:diff`: passed.
- `npm run check:modules`: 26 modules, no cycles.
- `npm run check:pack`: 31 files; all relative imports resolve.

No real provider requests or cache-performance claims were made.

## Closeout boundary

Mainline overlaps with `int_7ef62d57`, `int_6ce69160`, and `int_53dcb2c7`
were inspected: their code commits are ancestors of HEAD and describe the
already-integrated release, earlier fixes, and 1.0.1 upgrade, respectively.
This follow-up is complementary rather than a competing implementation.
Preflight still reports a blocking inspect-or-stop boundary; no commit, seal,
push, release, or task archival is performed in this follow-up.

## Follow-up: 1.0.2 → 1.0.3 baseline pass (2026-10-05)

npm latest moved to `@earendil-works/pi-coding-agent@1.0.3` /
`@earendil-works/pi-server@1.0.3` (published 2026-10-05). This pass bumps the
reproducible local dev baseline; published peer range stays `>=0.82.0` and the
package version is unchanged.

### Upstream diff assessment (installed 1.0.2 vs tarball 1.0.3)

- `dist/index.d.ts` (root published type surface): byte-identical.
- Contract-bound internals byte-identical: `dist/core/model-config.js`,
  `dist/extensions/llama/provider.js`, `dist/core/skills.js`,
  `dist/core/system-prompt.js`, `dist/core/model-runtime.js`.
- ExtensionAPI/hooks unchanged (root d.ts identical); provider hook event
  shapes untouched.
- Compat key union across the bundle: 34 = 34, none added or removed;
  `supportsPromptCacheKey` still absent (grep clean in 1.0.3 dist).
- Azure provider renamed `azure-openai-responses` → `azure` (1.0.3 breaking
  change), but the API/transport id stays `azure-openai-responses` and every
  static-catalog azure model still uses it, so the extension's API-type gates
  (Responses-family bypass, non-applicable proxy diagnostics) remain valid.
  The azure Responses transport still sets `prompt_cache_key` from the Pi
  session id (`clampOpenAIPromptCacheKey(options?.sessionId)`) — Pi still owns
  the key for Responses transports. Foundry Chat Completions models resolve at
  runtime, not in the static catalog; generic extension rules apply. The
  extension never matches on provider id, so the rename needs no code change.
  User-side effect only: stats buckets keyed `azure-openai-responses/…`
  become historical after Pi's rename.
- `config.d.ts` diff is codemode install-change detection only — no
  `models.json` schema change. Engine stays `>=22.19.0`.
- `pi-server` 1.0.3: only its own deps moved to `^1.0.3` (chord, pi-protocol).
- Changelog 1.0.3 items outside the extension's surfaces: codemode image files
  (with user-only permissions), Home/End keybindings, OAuth refresh fix,
  codemode pnpm/update detection fix, terminal EIO fix.

### Changes

- `package.json`: devDependencies → `pi-coding-agent ^1.0.3`,
  `pi-server 1.0.3`. Lockfile diff: 43+/43-, exclusively the
  `@earendil-works/*` tree 1.0.2→1.0.3 (even `@types/node` did not move).
- README.md / README.zh-CN.md: validated baseline and `supportsPromptCacheKey`
  claims updated to 1.0.3; engine-requirement sentence follows Pi 1.0.3
  (same `>=22.19.0`).
- `.trellis/spec/frontend/cache-adapter-footer-stats.md`: two version pins
  updated to 1.0.3.
- No source change required; no new regression test needed because every
  surface this extension binds to is pinned by existing contract tests that
  build fixtures from the installed Pi (llama.cpp provider, skills formatter,
  system prompt, model runtime, VIRTUAL_MODEL_API) — those stayed green, which
  is exactly the drift detection they were written for.

### Verification (on installed 1.0.3)

- Clean-scope check: lockfile diff contains only `@earendil-works/*` moves.
- `npm run typecheck`: pass. `npm test`: 178 passed / 0 failed.
- `npm run check:diff`, `check:modules` (26 modules, no cycles),
  `check:pack` (31 files): pass.
- Real-host load smoke via Pi 1.0.3's own `discoverAndLoadExtensions`:
  0 errors; extension registers all 10 handlers (`session_start`,
  `session_shutdown`, `tool_execution_end`, `agent_settled`, `model_select`,
  `before_agent_start`, `before_provider_headers`, `before_provider_request`,
  `after_provider_response`, `message_end`) and the `cache-optimizer` command.
- No release in this pass (dev-only bump + docs); 2.8.19 remains current.
