# Add footer mode to interactive menu

## Goal

Expose the existing footer mode configuration through the `/cache-optimizer` interactive menu. The direct `config footer-mode session|total` command already works; the menu must provide the same two choices and persist them through the same runtime path.

## Requirements

* Add a Footer mode menu item to the interactive `/cache-optimizer` menu.
* Offer `session` and `total` choices only; do not reintroduce the removed `env` option.
* Reuse the existing `writePersistedFooterMode`, precedence, immediate footer republish, and notification behavior.
* Add a regression test that selects the menu option and verifies the config file and effective mode.
* Keep direct command behavior, stats storage, package version, and environment-variable fallback unchanged.

## Acceptance Criteria

* [x] `/cache-optimizer` menu visibly includes Footer mode.
* [x] Menu selection persists `session` or `total` and updates the effective mode.
* [x] Tests and complete project checks pass.
* [x] Documentation/spec menu descriptions are synchronized.

## Out of Scope

* Adding a configuration-delete command.
* Changing footer mode precedence or persistence format.
