# Support total, session, and process footer modes

## Goal

Extend footer statistics with a third `process` mode while preserving the contributor's original `session` meaning. `total` shows daily cumulative provider/model totals, `session` shows the current Pi conversation session bucket and survives same-session `/reload` or restart, and `process` shows only the current Pi process and resets after Pi restart or extension reload.

## Requirements

* Support `total`, `session`, and `process` in environment parsing, persistent config, direct command, and interactive menu.
* Keep `total` as the default.
* Preserve the contributor's `session` semantics: a Pi conversation session bucket is persisted and can survive same-session restart/reload.
* Add a process-local in-memory bucket that is never restored from disk and is cleared on process/extension startup; `process` must show 0/0 after Pi restart even when the conversation session is restored.
* Update direct/menu commands, English and Chinese README, binding spec, and permanent regression tests.
* Preserve total/session persistence, router scope selection, reset behavior, package peer policy, and Pi 0.82+ compatibility.
* Release the fix as a patch version after checks pass.

## Acceptance Criteria

* [x] Mode parser accepts `total`, `session`, and `process`; invalid values fall back to `total`.
* [x] Direct and router footer selection obeys all three modes.
* [x] Process mode is populated during the current process but is not restored from persisted stats.
* [x] Session mode remains restorable for the same conversation session.
* [x] Menu offers all three modes and direct command offers all three modes.
* [x] README.md, README.zh-CN.md, and binding spec explain exact semantics.
* [x] Tests, typecheck, package dry-run, diff check, and Trellis validation pass.

## Out of Scope

* Changing the meaning of the contributor's `session` mode.
* Changing cache transport, stats schema, or peer dependency policy.
