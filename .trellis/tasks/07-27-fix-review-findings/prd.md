# Fix Review Findings

## Goal

Fix all confirmed review findings without weakening cache safety or configuration-write safeguards.

## Requirements

1. Prompt optimization must never remove the wrong occurrence of a stable candidate. Ambiguous repeated candidates are skipped; unique normal candidates remain optimizable.
2. Explicit long-retention configuration follows Pi's effective precedence: `modelOverrides[modelId].compat` > matching `models[].compat` > provider `compat`.
3. `/cache-optimizer fix` must understand and edit `modelOverrides`, prefer it for built-in models without a custom `models[]` entry, and validate the effective three-layer result.
4. Permanent regression coverage lives under stable `tests/` paths. Archived task verifiers must not be the only executable coverage for runtime contracts.
5. Repository-local commands must run type checking, tests, diff checks, and package dry runs without relying on globally installed `bunx` or `tsc`.
6. Runtime behavior, JSONC comments/formatting, credential safety, atomic config writes, and bilingual user documentation remain correct.

## Acceptance Criteria

- A duplicated prompt candidate inside dynamic marked content is preserved byte-for-byte in that content and is not lifted.
- A unique prompt candidate is still lifted deterministically.
- Long-retention true/false precedence is verified across all three configuration layers.
- Existing `modelOverrides` entries are surgically updated by fix helpers; missing overrides can be created without adding a custom model definition.
- Fix self-check rejects a lower-layer edit shadowed by `modelOverrides`.
- `npm test`, `npm run typecheck`, `git diff --check`, and `npm pack --dry-run` pass.
- README/spec text matches the resulting behavior.

## Non-Goals

- Inter-process locking for footer stats.
- Refactoring the single-file runtime into modules.
- Changing provider adapter detection or cache-stat semantics.
