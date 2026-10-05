# Upgrade the project Pi baseline to 0.99.2 and support native virtual models

## Goal

Upgrade this repository's reproducible local Pi development baseline from 0.87.1 to npm `latest` 0.99.2, support Pi 0.99's native virtual models (`api: "pi-virtual"`), apply the other adjustments the upgrade requires, and release the result as 2.8.12.

## Requirements

- Upgrade `@earendil-works/pi-coding-agent` to `^0.99.2` and exact `@earendil-works/pi-server` to `0.99.2`; keep the published peer range at `>=0.82.0`.
- Regenerate the lockfile, verify `npm ci`, and run the full quality gate.
- Fix the proven built-in `llama.cpp` fingerprint drift with a contract test against the installed Pi provider.
- Support native virtual models: request hooks, footer stats, and diagnostics act on the physical model Pi routes to; identity-dependent request mutations fail closed when the physical provider cannot be pinned; prompt rewriting and the affinity header bridge stay off for virtual selections.
- Apply the other upgrade adjustments found in the review (see Compatibility Assessment).
- Synchronize READMEs, implementation comments, and specs.
- Work in the main session (user instruction: no sub-agents).
- Release 2.8.12: commit, push a branch, open a PR, and publish through the repository's tag-triggered npm Trusted Publishing workflow (user instruction).

## Acceptance Criteria

- [x] Manifest and lockfile resolve both direct Pi development packages to 0.99.2; local `pi --version` reports 0.99.2.
- [x] Clean `npm ci`, `npm run typecheck`, `npm test`, `npm run check:diff`, and `npm run check:pack` pass.
- [x] Peer range remains `>=0.82.0`; new host features degrade to the previous behavior on older hosts.
- [x] The untouched built-in `llama.cpp` model is recognized on both the 0.82.x and 0.83+ provider shapes.
- [x] Native virtual model behavior is covered by permanent tests and verified against a real Pi 0.99.2 host.
- [x] Version 2.8.12 is published to npm (confirmed during archival with `npm view pi-cache-optimizer@2.8.12 version --prefer-online`).

## Compatibility Assessment

- npm publishes nothing between 0.87.1 and 0.99.0. 0.99.0/0.99.1/0.99.2 have no breaking-changes section; extension-facing exports, provider hook event shapes, and `ModelRegistry.find()` (chat models only) are unchanged. `supportsPromptCacheKey` is still absent, so the extension-owned opt-out remains necessary.
- **`llama.cpp` drift (Pi 0.83.0+):** the built-in provider changed `supportsUsageInStreaming` from `false` to `true`, so the fingerprint stopped matching and local `llama.cpp` received generic proxy advice. Removed the field from the fingerprint; a contract test builds the model from the installed `createLlamaProvider()`.
- **Native virtual models (0.99.0):** `ctx.model` stays virtual (`api: "pi-virtual"`, empty `baseUrl`) during every request. Before this change the extension evaluated request policy against the virtual model: per-model `prompt_cache_key` omit rules never applied (proven on a real host), Anthropic TTL repair and official-OpenAI retention were skipped, and footer/doctor diagnosed the virtual model. Request hooks now resolve the physical model from the payload's dispatched id; UX surfaces follow the latest physical response on the session branch.
- **Codemode nested tool calls (0.99.0):** nested calls emit `tool_execution_end` with `parentToolCallId`; each triggered a full shard re-scan. Nested events are now skipped; the calling tool's end event refreshes once.
- **Prompt-cache warming (0.86.0+):** warm requests pass `before_provider_request`/`after_provider_response` but never `message_end`, so request lifecycle records accumulated. The list is now capped (oldest completed record first).
- **Skills compression anchor:** the extension's copy of `formatSkillsForPrompt` still matches Pi 0.99.2 byte-for-byte; a new contract test pins it to the installed export.
- Not required: ChatGPT sign-in keeps `https://api.openai.com/v1`; the 0.99.2 built-in catalog produces no new compat false positives (only the intended third-party `sendSessionAffinityHeaders` advice); MCP `mcp_servers` prompt section and other 0.99.2 changes do not touch extension surfaces; peer minimum unchanged.

## Verification

- Before source changes, typecheck and all tests passed on 0.99.1 and 0.99.2.
- The `llama.cpp` contract test failed against the real 0.99.1 provider and passed after the fix.
- New native-virtual tests: 9 of 11 failed against the previous `index.ts` (the header-bridge regression guard passes on both by design); all pass now.
- Real-host e2e (Pi 0.99.2 RPC, fake local OpenAI-compatible server, `PI_OFFLINE=1`): with an omit rule for the routed physical model, the old extension still sent `prompt_cache_key` and doctor diagnosed `jev`; the new extension removed the key, showed `Kimi cache 1/1 … ⚠️ compat`, and doctor diagnosed `fakeproxy/kimi-k3` with the virtual-to-physical route line.
- Final gate: see the release PR checks.

## Decision (ADR-lite)

**Decision:** Resolve native virtual requests from the dispatched payload model id and fail closed on ambiguity, rather than trusting the previous routed model; Pi's provider hooks expose no physical model, and a wrong guess would apply one provider's cache/retention policy to another.

## Out of Scope

- Raising the minimum supported host Pi version.
- A Pi upstream change to pass the physical model to provider hooks.
