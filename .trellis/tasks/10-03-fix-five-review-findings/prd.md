# Fix five deep-review findings and add regression tests

## Goal

Fix all five reproduced review findings on the integrated 2.8.16 / Pi 1.0 baseline, add permanent regression coverage, and merge the verified result into local master. Work in the main session without sub-agents. Do not push, publish Mainline metadata, release, or publish a package until the user requests it.

## Requirements

1. Feature reset reads and validates the latest config under the shared transaction lock, removes only feature overrides, preserves footer mode and model key opt-outs, and refuses malformed/non-regular targets without overwriting them.
2. Doctor displays a credential-blind endpoint: remove URL userinfo, query and fragment; malformed input must not leak raw strings. Preserve normal endpoint diagnostics and never mutate the transport URL.
3. Final stats use request-local/catalog identity, not the selected model at response time. Same-family models on the same provider remain separate. Preserve direct response alias handling and native/legacy routing behavior.
4. Persistent openAICacheKey settings override both current and legacy environment switches. Config output, runtime diagnostics, and actual request hooks agree; runtime disable remains authoritative.
5. Malformed shard JSON is eligible for mtime-based retention cleanup. Current-day shards, young corrupt files, live old shards, and symlink targets remain protected.

## Acceptance Criteria

- [x] Permanent tests reproduce each finding before its fix and pass afterward.
- [x] Config reset tests cover stale cached state, invalid JSON/schema, symlinks, file mode, absence, and serialized updates.
- [x] URL tests cover valid URLs with credentials/query/fragment, malformed values, safe URLs, and command-level output.
- [x] Stats tests cover same-provider/model-family switches, catalog id vs response alias, cross-provider identity, and reload persistence.
- [x] Cache-key tests cover persistent on/off, both env switches, env-only behavior, runtime disable, and request-hook behavior.
- [x] Cleanup tests cover malformed old/young files, invalid schema, current-day and live-PID protection, symlinks, and unrelated names.
- [x] npm run check and Trellis task validation pass.
- [x] README translations and binding specs describe the repaired contracts.
- [ ] Changes committed and merged to local master; no remote writes or release.

## Prior Integration

Local master is 76f1763. It contains origin/master and the previously unmerged local development branch, preserving both histories. The integration quality gate passed with 147 tests. Historical branches already merged or superseded are not reintroduced.

## Verification

- Before implementation, the first 20 new permanent regression tests yielded 16 failures covering all five findings; four existing safety-boundary guards passed.
- Added a further guard test for manual content, inode replacement, mode, deletion, and creation races after the original config read, plus a red-then-green test for concurrent unknown aliases before response headers arrive. There are 22 new permanent tests in total.
- Final `npm run check`: 169 tests / 169 passed / 0 failed / 0 skipped; typecheck and diff checks pass; 26 source modules have no import cycles; every relative import in 27 source files resolves in the 31-file package dry run.
- `python3 .trellis/scripts/task.py validate .trellis/tasks/10-03-fix-five-review-findings` passes.
- All verification uses isolated temporary Pi agent directories and local fixtures. No real provider requests or provider-cache performance claims.

## Decisions

- Share strict locked feature mutation between setting and reset, binding the original read through atomic identity/hash/mode guards rather than accepting a writer's later snapshot.
- Share endpoint sanitization between request snapshots and doctor; malformed/non-HTTP input has no printable fallback.
- Prefer dispatched catalog identity for direct stats; preserve legacy echoed aliases only through safely correlated request-local lifecycle snapshots, never use the current selection to correlate unknown concurrent aliases, and keep the selected direct model's footer after a late response.
- Resolve both cache-key environment switches in `featureEnabled`, so config display, diagnostics, and actual injection share policy. Runtime disable remains a separate outer gate.
- JSON parsing failure makes a shard eligible for the same mtime retention as invalid schema; read failures and symlinks remain untouched.
