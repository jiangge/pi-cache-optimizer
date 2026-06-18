# General routing-provider cache protocol

## Problem Statement

`pi-cache-optimizer` needs to work correctly when the active Pi model is a virtual routing provider instead of a direct upstream provider. Today this area is split across special cases:

- Existing local handling for `router` models can derive true upstream stats from assistant message metadata.
- PR #2 adds `auto-router` support through `globalThis.__piCacheOptimizerRouter`, `__piCacheOptimizerPrompt__`, and `__piCacheOptimizerCacheKey__`.

That direction proves the need, but it risks coupling `pi-cache-optimizer` to individual router package names and to global singleton state. The desired outcome is a generic, low-coupling protocol that can support `pi-router`, `pi-auto-router`, and future router-like extensions without importing or hard-coding any of them.

## Solution

Implement a generic routing-provider compatibility layer in `pi-cache-optimizer` and document the companion contract for router extensions.

The design has three layers:

1. **Completed message stats use assistant message metadata first.** On `message_end`, stats identity should prefer the real upstream `provider`, `model` / `responseModel`, `api`, and `usage` carried by the assistant message. This is the authoritative path and should not depend on a router registry.
2. **Live route / doctor / compat use a generic routing registry.** Router extensions can optionally register themselves under a versioned global symbol, e.g. `Symbol.for("pi.routing.registry.v1")`. `pi-cache-optimizer` consumes this registry to resolve the current underlying route for footer display, doctor, compat checks, and reset commands before a final assistant message exists.
3. **Prompt/cache-key passthrough uses a generic cache hints service.** `pi-cache-optimizer` exposes optimized prompt and cache-key hints through a versioned service, e.g. `Symbol.for("pi.cache.hints.v1")`, instead of scattered package-specific globals.

This keeps the extension relationship protocol-based rather than package-based:

- `pi-cache-optimizer` does not import or name `pi-router` / `pi-auto-router` except in docs and compatibility examples.
- Router extensions do not import `pi-cache-optimizer`; they read/write optional protocol symbols if present.
- Final cache stats remain correct even if the live-route registry is missing, because `message_end` still uses message metadata.

## User Stories

1. As a Pi user selecting `router/deepseek-v4-pro`, I want cache stats to be attributed to the real provider/model used for the request, so that the footer reflects the actual upstream cache behavior.
2. As a Pi user selecting `auto-router/subscription-swe`, I want cache stats to be attributed to the selected target provider/model, so that virtual route profiles do not hide useful cache information.
3. As a Pi user, I want `/cache-optimizer doctor` to diagnose the real routed provider when available, so that compat warnings are actionable.
4. As a Pi user, I want `/cache-optimizer compat` to check the real upstream model configuration, so that I am not warned about missing fields on a virtual provider that never talks to an API directly.
5. As a Pi user, I want footer stats to continue working after `/reload`, so that the last real routed model for the session can be restored.
6. As a Pi user, I want virtual router models that relay correct assistant metadata to work without any router-specific optimizer integration, so that simple routers remain easy to build.
7. As a pi-router maintainer, I want to expose the active canonical route and true upstream route through a generic registry, so that cache optimizer and future tools can observe routing without depending on pi-router internals.
8. As a pi-auto-router maintainer, I want to expose the active profile target through the same registry, so that the optimizer does not need a separate auto-router code path.
9. As a router extension maintainer, I want to read optimized prompt/cache-key hints through a versioned protocol, so that I can pass them to inner `streamSimple` calls without depending on optimizer package internals.
10. As a router extension maintainer, I want the protocol to be optional, so that the router continues working when `pi-cache-optimizer` is not installed.
11. As a Pi user with multiple router extensions installed, I want each virtual provider to register independently, so that the optimizer can resolve whichever router is currently active.
12. As a Pi user with multiple sessions or subagents, I want final stats to avoid global singleton route races, so that cache counters are not written to the wrong provider/model.
13. As a maintainer, I want backwards compatibility with the PR #2 prototype during migration, so that existing auto-router integrations do not break immediately.
14. As a maintainer, I want a documented protocol shape and migration notes, so that future router extensions can integrate consistently.

## Implementation Decisions

- Treat assistant message metadata as the authoritative source for final cache stats. If the message exposes a real upstream provider/model, use that identity even when `ctx.model` is a virtual router model.
- Do not use live route registry data as the primary source for final `message_end` stats. The live route can be stale or ambiguous under concurrency; message metadata is request-local.
- Generalize router detection away from `provider === "router"` and `provider === "auto-router"`. Prefer protocol registration. Existing provider-name checks may remain as compatibility fallback only.
- Introduce a versioned global routing registry symbol, proposed name: `Symbol.for("pi.routing.registry.v1")`.
- A router adapter registered in the routing registry should expose at least:
  - virtual provider id
  - active route resolver for a virtual model id
  - optional candidate route resolver
  - optional subscription API for route changes
- A route snapshot should carry both virtual and real identities:
  - virtual provider and virtual model id
  - real upstream provider and model id
  - optional api, canonical model id, route label, status, session hash, request id, timestamp
- `pi-cache-optimizer` should use route snapshots for live footer display, doctor, compat, and reset UX.
- For compat diagnostics, after resolving the upstream provider/model, look up the full Pi model from `ctx.modelRegistry.getAvailable()` so real `api`, `baseUrl`, and `compat` fields are available.
- Introduce a versioned cache hints service symbol, proposed name: `Symbol.for("pi.cache.hints.v1")`.
- Cache hints should be query-based rather than global singleton values. Inputs can include session hash, virtual provider/model, upstream provider/model, and api. Outputs can include optimized system prompt, prompt cache key, and retention hint.
- Keep old PR #2-style globals as temporary compatibility shims if needed, but document them as deprecated once the new protocol exists.
- Do not make `pi-cache-optimizer` import router packages or read router-specific config files.
- Do not make router packages import `pi-cache-optimizer`; protocol symbols are optional discovery points.
- For `pi-router` canonical aliases, the route snapshot should expose canonical router id separately from the upstream model id. Stats use the upstream id; UI may show both.
- For `pi-auto-router` profiles, the route snapshot should expose the selected target provider/model and optional target label/profile id. Stats use the selected target.

### Proposed protocol sketch

This sketch is not final API code, but captures the intended contract:

```ts
const PI_ROUTING_REGISTRY = Symbol.for("pi.routing.registry.v1");
const PI_CACHE_HINTS = Symbol.for("pi.cache.hints.v1");

type PiRouteSnapshot = {
  virtualProvider: string;
  virtualModelId: string;
  provider: string;
  modelId: string;
  api?: string;
  canonicalModelId?: string;
  routeLabel?: string;
  status?: "planned" | "trying" | "selected" | "success" | "failed";
  sessionIdHash?: string;
  requestId?: string;
  timestamp: number;
};

type PiRouterAdapterV1 = {
  virtualProvider: string;
  resolveActiveRoute(
    virtualModelId: string,
    hint?: { sessionIdHash?: string; requestId?: string }
  ): PiRouteSnapshot | undefined;
  resolveCandidateRoutes?(virtualModelId: string): PiRouteSnapshot[];
  subscribe?(listener: (event: PiRouteSnapshot) => void): () => void;
};

type PiRoutingRegistryV1 = {
  version: 1;
  registerRouter(adapter: PiRouterAdapterV1): () => void;
  getRouter(virtualProvider: string): PiRouterAdapterV1 | undefined;
};

type PiCacheHintsV1 = {
  version: 1;
  getHints(input: {
    sessionIdHash?: string;
    virtualProvider?: string;
    virtualModelId?: string;
    upstreamProvider?: string;
    upstreamModelId?: string;
    api?: string;
  }): {
    systemPrompt?: string;
    promptCacheKey?: string;
    cacheRetention?: "long";
  } | undefined;
};
```

## Testing Decisions

- Tests should verify external behavior and protocol behavior, not implementation details.
- Add tests for message-based stats identity:
  - active model is a virtual router model
  - assistant message carries real upstream provider/model/api/usage
  - stats are recorded under the real upstream key, not the virtual router key
- Add tests for registry-based live resolution:
  - a fake router adapter is registered for a virtual provider
  - footer / doctor / compat paths resolve the real upstream model from the registry
  - missing registry falls back safely
- Add tests for cache hints service:
  - optimized prompt and session cache key are returned through the versioned service
  - no hints are returned when optimizer is disabled or prompt rewriting is disabled as applicable
  - existing request-level keys are not overwritten by router integration
- Add compatibility tests for old PR #2-style globals if shims are retained.
- Add concurrency-oriented tests where possible:
  - final stats from assistant message metadata should remain correct even if active route snapshot changes before `message_end`
- For pi-router companion work, add tests that route snapshots expose canonical id and upstream id separately.
- For pi-auto-router companion recommendation, document the same fake-adapter tests as integration expectations even if the implementation happens in a different repository.

## Out of Scope

- Implementing pi-router canonical aliases in this task. That is tracked separately in `pi-router`.
- Recreating pi-auto-router policy, budget, UVI, shortcut, or profile logic inside `pi-cache-optimizer`.
- Requiring router extensions to depend on `pi-cache-optimizer` at package-install time.
- Adding fake cache counters for providers/transports that do not expose cache usage.
- Changing API keys, provider base URLs, auth config, or user `models.json`.
- Publishing npm packages before both repository-specific changes are implemented and validated.

## Further Notes

- This task should be implemented in coordination with `pi-router` changes, but each repository must be committed, pushed, and published independently after implementation is complete.
- The immediate `pi-router` companion task is `tasks/2026-06-18-router-model-aliases.md` in the `pi-router` repository. That task should be updated to reference this protocol.
- The protocol should remain small. If future Pi core provides an official delegated-stream API, this global-symbol protocol can become a compatibility layer or be removed.
- Backwards migration should be gentle: PR #2's global names can be supported during transition, but new integrations should use the versioned symbols.
