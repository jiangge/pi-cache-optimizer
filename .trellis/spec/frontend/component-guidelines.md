# Component Guidelines

> This package does not define React/UI components.

---

## Overview

`pi-cache-optimizer` is a Pi extension package. User interaction is performed through Pi extension APIs:

- `ctx.ui.setStatus(...)` for footer status
- `ctx.ui.notify(...)` for notifications
- optional `ctx.ui.select(...)` / confirmation helpers for command flows
- `pi.registerCommand(...)` for `/cache-optimizer`

There are no JSX components, component props, CSS modules, Tailwind classes, or browser accessibility concerns in this repository.

---

## UI Output Patterns

Even without components, user-facing output must follow these rules:

- Keep footer status concise and deterministic.
- Do not show secrets, prompts, payloads, response bodies, HTTP headers, API keys, or raw session ids.
- Use platform-friendly paths from helpers such as `getModelsJsonDisplayPath()`.
- For commands that can write files (`/cache-optimizer fix`), require explicit interactive confirmation and show a preview/risk notice first.
- For advisory diagnostics, include copyable safe JSON snippets but never mutate `models.json` except through the confirmed fix flow.

---

## Command Text Conventions

- `/cache-optimizer doctor` should distinguish applicable fully configured models (`✅ Compat fully configured.`) from non-applicable models (`ℹ️ Compat check not applicable for this model.`).
- `/cache-optimizer reset` must clarify that it resets only local stats, not upstream provider caches.
- Runtime enable/disable notifications should describe current-process scope and feature states.

---

## Common Mistakes

- Treating this as a React app and adding component scaffolding.
- Adding noisy startup warnings for non-actionable provider limitations.
- Displaying raw session ids or hashes to users.
- Showing credential-bearing `models.json` content instead of minimal compat snippets.
