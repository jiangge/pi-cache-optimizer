# Push and publish pi-cache-optimizer 2.8.17

## Goal

Fulfill the user's explicit request `push后再npm publish` by publishing the current verified code as the next patch release after 2.8.16.

## Requirements

- Preserve all existing code and history; only bump root package versions to 2.8.17.
- Run the full `npm run check` gate and inspect package contents.
- Commit release preparation, seal the dedicated release intent, then push the non-main release branch.
- Only after the branch push succeeds, push a new annotated `v2.8.17` tag to trigger `.github/workflows/publish.yml` and its `npm publish --provenance` step.
- Verify the workflow succeeds and npm's latest version is 2.8.17.
- Do not force-push, overwrite release tags, merge to master, or change authentication/publishing configuration.

## Known Facts and Decisions

- Working tree was clean; HEAD is 961478b, 42 commits ahead of origin/master.
- npm latest and the root manifest are already 2.8.16; that version cannot be republished. The next patch 2.8.17 is the minimal release-only bump.
- npm local authentication returns E401. The established tag-triggered workflow uses GitHub OIDC trusted publishing; the last three release workflows succeeded.
- Use release/2.8.17 rather than pushing master under review autonomy.
- Proposed intent int_6ce69160 is integrated ancestor work (5b30336 is in HEAD), not a contradictory change. The stale master intent int_a5925f74 concerns Issue #17 and must not own the release. A fresh release branch/intent isolates the release-only changes.

## Acceptance Criteria

- [x] package.json and both root versions in package-lock.json equal 2.8.17.
- [x] Full quality checks and task context validation pass (171 tests passed).
- [x] Release preparation committed as 52c91c4 and release intent int_7ef62d57 sealed/published.
- [x] Branch push succeeded and was verified before annotated v2.8.17 tag push.
- [x] GitHub publish workflow 37087625824 succeeded and npm latest is 2.8.17.

## Out of Scope

Runtime changes, dependency upgrades, PR/merge, master push, repairing stale historical intents, npm login/token management, overwriting existing versions/tags.

## Failure Handling

Stop before publishing if checks fail or the version/tag already exists. If CI fails, inspect evidence and report the exact required recovery without force-pushing a release tag. A new patch release, not overwriting npm versions, is the rollback/correction path.

## Technical Notes

References: package.json, package-lock.json, .github/workflows/publish.yml, .trellis/spec/frontend/quality-guidelines.md. No new tests are needed for this version-only change; the full existing suite validates the code being released.
