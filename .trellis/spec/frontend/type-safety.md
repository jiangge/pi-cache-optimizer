# Type Safety

> Type safety patterns in this project.

---

## Overview

The project uses TypeScript in a single runtime entry (`index.ts`) and consumes the installed official Pi and Node type declarations directly. Full local redeclarations of external modules are not used because they can hide upstream API drift.

`tsconfig.json` is configured for Pi/Jiti extension validation:

- `module` / `moduleResolution`: `NodeNext`
- `target`: `ES2022`
- `noEmit`: `true`
- `allowImportingTsExtensions`: `true`
- `strict`: currently `false`
- includes `index.ts` and permanent tests under `tests/**/*.ts`

Run TypeScript validation with:

```bash
npm run typecheck
```

The command MUST resolve the repository-local TypeScript dependency from
`devDependencies`; validation must not depend on a globally installed `tsc` or
`bunx`.

---

## Type Organization

- Keep project-local types close to the implementation in `index.ts`.
- Import Pi API types from the installed `@earendil-works/pi-coding-agent` package.
- If an upstream declaration is genuinely missing, use a narrowly scoped module augmentation that imports the original module first; never redeclare the whole Pi or Node module surface.
- Do not export internal helper types as public package API unless the package contract requires it.
- For verification scripts, expose pure helpers through `__internals_for_tests`.

---

## Runtime Validation Patterns

External inputs are not trusted, including:

- assistant messages
- persisted stats JSON
- route snapshots from global routing registry adapters
- cache hints service inputs
- command arguments
- JSONC `models.json` edits

Preferred patterns:

- Use small type guards such as `asRecord`, `isNonEmptyString`, and enum parsers.
- Parse and clamp numeric counters before persisting.
- Drop malformed persisted entries rather than throwing.
- Treat malformed route snapshots as absent.
- Catch adapter/global callback errors and continue safely.

---

## Common Patterns

- Keep pure helpers deterministic and easy to verify in task-level scripts.
- Use explicit persisted schema version parsers/migrators.
- Keep user-facing model refs minimal (`provider`, `id`, optional `name`).
- Use `Pick<ExtensionContext, ...>` / local lightweight interfaces when helpers only need part of Pi context.

---

## Forbidden Patterns

- Do not shadow official dependency types with a complete ambient module redeclaration just to make typecheck pass.
- Do not use `any` as a shortcut for persisted or external data parsing when a small guard is practical.
- Do not trust global protocol objects without version/function checks.
- Do not assume optional Pi APIs such as `modelRegistry.find` or `ui.select` always exist.
- Do not throw from hook paths for malformed user/provider data; warn or ignore and preserve Pi operation.
- Do not suppress TypeScript errors with broad casts unless the boundary is genuinely dynamic and is immediately guarded.
