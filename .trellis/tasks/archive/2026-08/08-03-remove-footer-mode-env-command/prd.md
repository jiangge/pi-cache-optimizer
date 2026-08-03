# Remove footer mode env command and document PR decision

## Goal

Remove the `/cache-optimizer config footer-mode env` command option while retaining environment-variable support and the persistent `session` / `total` command settings. Notify the contributor on merged PR #5 about the maintainer's final product decision.

## Requirements

* `/cache-optimizer config footer-mode` accepts only `session` or `total`.
* Persistent command configuration remains higher priority than `PI_CACHE_OPTIMIZER_FOOTER_MODE`; missing persistent config falls through to the environment and then default `total`.
* Existing `pi-cache-optimizer-config.json` values remain valid and are not silently deleted or migrated.
* Documentation explains that returning to environment-controlled behavior requires manually deleting `pi-cache-optimizer-config.json`.
* Update runtime help, permanent tests, English README, Chinese README, and the binding footer-stats spec.
* Comment on PR #5 thanking the contributor and explaining: both modes are retained, default is `total`, persistent command config overrides the env var, and routed/direct footer paths use the same selected scope.
* Do not change stats persistence, cache hooks, package version, dependencies, or unrelated PR state.

## Acceptance Criteria

* [x] The `env` command option is absent from parsing, usage text, tests, and docs.
* [x] `session` and `total` persistent command settings continue to work.
* [x] Environment/default resolution remains covered by tests when no persistent setting exists.
* [x] README.md, README.zh-CN.md, and the binding spec are consistent.
* [x] PR #5 contains a maintainer comment explaining the final decision.
* [x] `npm run check`, diff check, README parity, and Trellis validation pass.

## Out of Scope

* Adding a different command for clearing configuration.
* Automatically deleting existing persistent configuration.
* Publishing the npm package.
