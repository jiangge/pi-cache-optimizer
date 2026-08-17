# Directory Structure

> Actual organization for `pi-cache-optimizer`.

---

## Overview

This repository is a **single-file Pi extension package**, not a React/frontend app. Runtime code lives in `index.ts` and is loaded by Pi via Jiti from the package `pi.extensions` entry.

There is intentionally no `src/` tree, component hierarchy, route layer, or asset pipeline.

---

## Directory Layout

```text
.
├── index.ts                         # Pi extension implementation and test internals
├── tests/                            # Permanent runtime regression tests
├── README.md                        # English user docs
├── README.zh-CN.md                  # Chinese user docs
├── package.json                     # npm/pi package metadata; files includes index.ts
├── tsconfig.json                    # TypeScript noEmit validation
├── docs/agents/                     # Agent operational docs (issue tracker, labels, domain)
└── .trellis/
    ├── spec/                        # Durable development contracts
    └── tasks/                       # Task PRDs, research, verification artifacts
```

---

## Module Organization

Because `index.ts` is the package entry point and Pi loads it directly, prefer organizing code **within the file** by responsibility rather than splitting modules casually.

Current major groups in `index.ts`:

- constants and environment switches
- type declarations and persistence shapes
- prompt optimization helpers
- cache provider adapter detection and usage normalization
- compat diagnostics and fix helpers
- routing-provider protocol helpers
- persistence/migration helpers
- Pi extension hook and command registration
- `__internals_for_tests` exports for task-level verification scripts

Create a new runtime file only when there is a strong reason. If one is added, update `package.json.files` and Pi extension entry behavior deliberately. External API types come from installed dependencies rather than full local ambient redeclarations.

---

## Naming Conventions

- Runtime entry: keep `index.ts` as the Pi extension entry.
- Dependency types: consume the installed Pi and Node declarations directly; a rare local augmentation must be narrow and must not replace the original module surface.
- Permanent regression tests: place under `tests/` and run every `tests/*.test.ts` file through `npm test`.
- Trellis task verification scripts: use them only for task-specific investigation or additional evidence; archive with the task. They must not be the sole coverage for runtime contracts.
- User docs: keep English and Chinese READMEs in sync for user-visible behavior.

---

## Examples

- `index.ts` — canonical extension implementation.
- `tests/runtime-contracts.test.ts` — permanent migration, routing, lifecycle, hook, and persistence contracts.
- `.trellis/spec/frontend/cache-adapter-footer-stats.md` — authoritative behavior contract for cache stats, prompt optimization, diagnostics, routing protocol, and forbidden patterns.
