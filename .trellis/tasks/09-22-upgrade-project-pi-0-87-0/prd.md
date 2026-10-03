# Upgrade the project Pi development baseline to 0.87.0

## Goal

Upgrade this repository's reproducible local Pi development baseline from 0.86.1 to npm `latest` 0.87.0, then assess whether extension source, tests, peer policy, or documentation need adjustment.

## Requirements

- Upgrade `@earendil-works/pi-coding-agent` to `^0.87.0` and exact `@earendil-works/pi-server` to `0.87.0`.
- Keep the published peer range at `>=0.82.0` unless compatibility evidence requires a documented change.
- Regenerate the lockfile, verify `npm ci`, and run the full quality gate.
- Preserve runtime behavior and published package contents unless a Pi 0.87.0 break is proven and fixed with a focused regression.
- Do not bump the extension version, publish, push, or open a PR without explicit approval.

## Acceptance Criteria

- [x] Manifest and lockfile resolve both direct Pi development packages to 0.87.0.
- [x] Local `pi --version` reports 0.87.0.
- [x] Clean `npm ci` succeeds.
- [x] `npm run typecheck` and `npm test` pass.
- [x] `npm run check:diff` and `npm run check:pack` pass.
- [x] Peer range remains `>=0.82.0`; no evidence requires narrowing it.
- [x] A compatibility assessment records required versus unnecessary project changes.

## Verification and Compatibility Assessment

- Upgraded `@earendil-works/pi-coding-agent` to `^0.87.0` and exact `@earendil-works/pi-server` to `0.87.0`. `npm ls --depth=0` and `pi --version` report `0.87.0`.
- `npm ci` reported 0 vulnerabilities. `npm run check` passed: typecheck, 102/102 tests, diff check, and package dry run.
- Pi 0.87.0 breaking changes cover `shouldStopAfterTurn`, exhaustive `SessionEntry`/`ExtensionEvent` switches, direct `session.agent.state.messages` replacement, and `ExtensionRunner.emit("turn_end")`. This extension uses none of those surfaces.
- `supportsPromptCacheKey` is still absent from Pi 0.87.0, so the extension-owned opt-out remains necessary. Documentation and the implementation comment were synchronized from 0.86.1 to 0.87.0.
- No runtime logic, tests, peer minimum, or package version change is required.

## Decision (ADR-lite)

**Decision:** Repeat the confirmed 0.86.1 baseline pattern: move only the local development baseline, keep host peer policy independent, and adapt source only when 0.87.0 evidence requires it.

## Out of Scope

- New extension features.
- Package version bump, npm publish, release, push, or PR.
- Raising the minimum supported host Pi version without evidence.

## Technical Notes

- npm `latest` for both `@earendil-works/pi-coding-agent` and `@earendil-works/pi-server` is `0.87.0`.
- Both require Node `>=22.19.0`.
- Current pins are `^0.86.1` and exact `0.86.1`.
