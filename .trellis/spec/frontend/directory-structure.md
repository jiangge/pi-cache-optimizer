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
├── types/
│   └── pi-coding-agent.d.ts         # Local ambient Pi type augmentation/shim
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

Create a new file only when there is a strong reason (for example local `.d.ts` declarations under `types/`). If a new runtime file is added, update `package.json.files` and Pi extension entry behavior deliberately.

---

## Naming Conventions

- Runtime entry: keep `index.ts` as the Pi extension entry.
- Type shims: place under `types/**/*.d.ts` so `tsconfig.json` includes them.
- Trellis task verification scripts: place under the relevant `.trellis/tasks/<task>/verify.ts` while active; archive with the task.
- User docs: keep English and Chinese READMEs in sync for user-visible behavior.

---

## Examples

- `index.ts` — canonical extension implementation.
- `types/pi-coding-agent.d.ts` — local Pi API type declarations used by the extension.
- `.trellis/spec/frontend/cache-adapter-footer-stats.md` — authoritative behavior contract for cache stats, prompt optimization, diagnostics, routing protocol, and forbidden patterns.
