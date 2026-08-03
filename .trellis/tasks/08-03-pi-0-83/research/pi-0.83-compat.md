# Pi 0.83 compatibility evidence

## Versions

- Global Pi package: `@earendil-works/pi-coding-agent@0.83.0`.
- Project lockfile before this task: `@earendil-works/pi-coding-agent@0.82.0`; it is now synchronized to `0.83.0`.
- Project peer dependency is intentionally `*`, so published package consumers resolve their installed Pi version; the lockfile is the local development baseline.

## Official 0.83 changes relevant to this extension

- `CHANGELOG.md` 0.83.0 adds Claude Opus 5 on GitHub Copilot with adaptive thinking and adds the session `ctx.scopedModels` extension context field.
- The 0.83.0 breaking change upgrades bundled TypeBox aliases to 1.3.7 and removes deprecated TypeBox APIs. This extension imports no TypeBox API and registers no custom tool schema.
- The extension-facing lifecycle hook contracts used here (`session_start`, `session_shutdown`, `model_select`, `before_agent_start`, `before_provider_request`, `after_provider_response`, `message_end`) are unchanged between the installed 0.82 declarations and global 0.83 declarations.
- `BuildSystemPromptOptions` remains compatible for the fields used by this extension: `promptGuidelines`, `contextFiles`, and `skills`.
- `getAgentDir()` and `PI_CODING_AGENT_DIR` remain available with the same behavior.

## Code impact

- Existing adaptive model detection already matches Opus major versions >= 5 through `ADAPTIVE_OPUS_PATTERN` in `index.ts`, and the `anthropic-messages` gate remains correct. The missing coverage is a direct regression test for Opus 5.
- `ctx.scopedModels`, `MessageRenderOptions.outputPad`, and the new TypeBox behavior are unused by this package, so no runtime or ambient-type change is required.
- The safe synchronization is to update the tracked lockfile to 0.83.0, add regression coverage, and document that the extension is validated against Pi 0.83. The peer range remains `*` and the package version remains unchanged because behavior does not change.
- The ambient declaration remains intentionally minimal: it does not mirror unused 0.83-only fields such as `ctx.scopedModels` or `MessageRenderOptions.outputPad`.

## Verification plan

- Install/sync the local peer package at 0.83.0 without adding it to `peerDependencies`.
- Run `npm run check`, `git diff --check`, and inspect `npm pack --dry-run`.
- Test Opus 5 native Anthropic models with missing and complete adaptive compat, plus a non-adaptive older Claude model as a negative case.

## Completed verification

- `npm ci --ignore-scripts` succeeded from the tracked lockfile and installed Pi `0.83.0`.
- Registry metadata reports the same resolved tarball and integrity as `package-lock.json`: `sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==`.
- `package.json` and the lockfile root retain peer dependency `@earendil-works/pi-coding-agent: "*"`; package version remains `2.6.25`.
- `npm run check` passes with typecheck, 15 tests, diff check, and pack dry-run.
- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-03-pi-0-83` passes.
