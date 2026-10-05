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
