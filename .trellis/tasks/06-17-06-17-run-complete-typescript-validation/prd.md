# Run complete TypeScript validation

## Problem Statement

The repository needs a clean TypeScript validation pass after the recent cache-optimizer changes. This task records the validation command set and results so the repo has a durable Trellis artifact showing that the current `index.ts` and local Pi type declarations compile without emitting code.

## Scope

- Validate the project TypeScript configuration in `tsconfig.json`.
- Confirm `index.ts` and `types/**/*.d.ts` pass `tsc --noEmit`.
- Run release-adjacent sanity checks that catch packaging or whitespace regressions.
- Do not change runtime behavior unless validation uncovers a compile failure that must be fixed.

## Validation Commands

- `bunx tsc --version`
- `bunx tsc --noEmit --pretty false`
- `git diff --check`
- `npm pack --dry-run`
- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/06-17-06-17-run-complete-typescript-validation`

## Completion Criteria

- TypeScript completes with exit code 0.
- Whitespace diff check completes with exit code 0.
- `npm pack --dry-run` completes with exit code 0.
- Task context validates.
- A validation report is committed with the task archive.
