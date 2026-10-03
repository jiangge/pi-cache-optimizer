# Release preparation verification

## Implementation and independent review

- Root package.json version and both root package-lock.json versions: 2.8.17.
- Exactly three version-value changes; dependency tree and runtime code unchanged.
- Implement agent and independent check agent both ran npm run check successfully.
- Tests: 171 passed, 0 failed; typecheck, diff, module graph and package checks passed.
- Package dry run: 31 files, approximately 151 KB packed / 604 KB unpacked. All relative imports in 27 packed sources resolve. No task/benchmark files included.
- Trellis implement/check context validation passed.
- npm latest before release: 2.8.16. Version 2.8.17 and local/remote v2.8.17 tag absent at review time; check again before pushing tag.

## Spec review

Reviewed trellis-update-spec guidance: no new runtime/API/infra contract was introduced. Existing quality guidelines and publish workflow already cover the validation and trusted-publishing contract; no spec change needed for the mechanical patch bump.

## Mainline overlap resolution

- Release intent int_7ef62d57 owns release/2.8.17; initial local HEAD is 961478b. Mainline selected origin/master (8588476) as the intent base, so its evidence window includes inherited integration commits as well as the version bump.
- Preflight still compares the branch's inherited history with main and reports proposed overlap with int_6ce69160, whose code_commit is 5b30336.
- Inspected the existing proposal and verified 5b30336 is an ancestor of HEAD. Its integration/review fixes are deliberately included, not replaced or contradicted.
- The previous instruction to wait before pushing is superseded by the user's explicit push/package-publish request and subsequent continuation.
- The new diff changes only root package versions. No stale-base, dirty-only seal, notes rewrite or divergent code finding applies. Record the already-accounted-for overlap in the release seal; no semantic conflict check is needed solely for inherited file overlap.

## Delivery order

Commit preparation, seal/publish release metadata, push release/2.8.17, then push annotated v2.8.17 to trigger the existing GitHub OIDC npm-publish workflow. Do not push master, force-push or overwrite tags/versions.

## Verified delivery outcome

- Release preparation commit: 52c91c4a3d215674fcf30c034bf36e2bfa1fc1f1.
- Release intent int_7ef62d57: proposed and published.
- release/2.8.17 branch push succeeded; remote branch SHA verified before tag push.
- Annotated v2.8.17 pushed afterward; remote tag peels to the release preparation commit.
- Workflow: https://github.com/jiangge/pi-cache-optimizer/actions/runs/37087625824 — completed successfully, including checks and Publish to npm with OIDC.
- Workflow log confirms signed provenance and `+ pi-cache-optimizer@2.8.17`.
- Registry initially lagged (2.8.16 / E404); polled without retrying publication. Direct registry and subsequent `npm view --prefer-online` both confirmed 2.8.17 with latest=2.8.17.
- npm provenance predicate: https://slsa.dev/provenance/v1.
- Working tree was clean after delivery. No master push, forced push, tag overwrite, auth change or runtime change.
