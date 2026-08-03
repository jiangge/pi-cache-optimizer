# Release configurable footer stats

## Goal

Release the merged configurable footer-stats feature as `pi-cache-optimizer@2.7.0`, push all local master commits, and verify the npm registry result.

## Requirements

* Bump package and lockfile version from `2.6.25` to `2.7.0` because the release adds backward-compatible footer modes and a persistent configuration command.
* Keep `peerDependencies.@earendil-works/pi-coding-agent` as `*` and the Pi development baseline at 0.83.0.
* Update bilingual version-specific feature documentation where appropriate.
* Run the complete project checks and package dry-run before publishing.
* Push `master` to `origin` before npm publishing.
* Use the provided one-time npm token only through an ephemeral npm configuration and remove it immediately after publishing.
* Verify npm `latest` and published version metadata after publication.

## Acceptance Criteria

* [x] `package.json` and `package-lock.json` consistently report `2.7.0`.
* [x] README.md and README.zh-CN.md describe the feature as available in v2.7.0.
* [x] `npm run check`, Trellis validation, diff checks, and registry preflight pass.
* [x] Release commit and task records are pushed to `origin/master`.
* [x] npm reports `pi-cache-optimizer@2.7.0` and `latest=2.7.0`.
* [x] No npm token is present in tracked files or retained temporary config.

## Out of Scope

* Additional runtime feature changes.
* Publishing a prerelease tag.
* Changing peer dependency policy.
