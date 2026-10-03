# Privacy Guidelines

> Binding privacy rules for `pi-cache-optimizer` request transformations.

## Trust boundary

Pi prompt options, assembled system prompts, provider payloads, headers, assistant messages, route snapshots, and usage data are external or sensitive inputs. The extension may inspect them at hook boundaries only to perform documented transformations. Diagnostics and persisted state must never expose their raw contents.

## Deterministic tool ordering

`PI_CACHE_OPTIMIZER_TOOL_ORDER` is an explicit truthy opt-in (`1`, `true`, `yes`, or `on`, case-insensitive) and is gated by runtime enablement. The feature has no persistent state.

The pure normalizer may sort only verified built-in payload shapes for allowlisted Pi APIs. It must return the caller's original payload for unknown/custom APIs, unsupported wrappers, malformed tools, missing/blank names, or unrecognized schemas. It sorts by exact tool name and original index, preserves every tool field and request-control field, and never mutates caller input.

When order changes, the helper shallow-clones only the root/container/tool-array path. Tool objects and unrelated request fields retain identity, including Google/Vertex SDK objects and `AbortSignal`. Google/Vertex tools must be read from Pi's actual `payload.config.tools[].functionDeclarations` path.

Any supported tool array carrying a top-level tool `cache_control` field is a deliberate no-op. This covers native Anthropic and OpenAI-compatible Anthropic cache formatting. Anthropic arrays containing `defer_loading` are also no-ops because the array encodes immediate/deferred grouping. Existing cache-control and TTL validation remains authoritative; this feature must not move a cache breakpoint or add a trailing breakpoint. The request hook must compose ordering with existing TTL, retention, prompt-cache-key, routing, and adapter logic rather than returning early.

## Verification privacy

The task verifier uses deterministic local fixtures only. It may report changed-tool counts and unchanged cache-marker counts. It MUST NOT print prompts, prompt diffs, payloads, headers, session ids, credentials, response bodies, or usage values presented as provider cache evidence. Fixture-only runs must explicitly say that provider cache usage is unavailable and must never claim synthetic cache hits.

## DeepSeek protocol and rollback privacy

DeepSeek model id/name tokens may select the `DS cache` adapter, but they never
prove a reasoning wire protocol. Only effective explicit
`thinkingFormat: "deepseek"` on an `openai-completions` DeepSeek-like model may
activate DeepSeek replay diagnostics. `supportsReasoningEffort`, provider ids,
base URLs, and endpoint domains are not substitutes for that signal. The
extension must not issue hidden probes or persist a guessed protocol.

A reasoning rejection detector may inspect a response header or finalized
assistant error only for the narrow direction “`thinking` is rejected; use
`reasoning_effort`”. It stores only a model-scoped process-local category. It
must never store, print, or log the complete error or any surrounding payload.
The response hook never edits or rolls back configuration automatically.

A successful interactive models.json fix may write one models receipt atomically.
A prompt-cache-key opt-out writes a versioned extension-config receipt containing
only transaction id, exact provider/model identity, the receipt-owned model key,
whether that key existed before, SHA-256 config hashes, basename-only backup
filename, target existence, timestamps, and rollback status.
Neither receipt contains prompts, payloads, headers, credentials, response bodies,
or raw errors. The config transaction preserves footerMode and refuses to overwrite
changed user config. It excludes credentials, prompts, payloads, headers,
response bodies, and raw errors.
Rollback requires explicit UI confirmation. An unchanged file may be restored
from a verified pre-fix backup; a changed file may only receive guarded
surgical restoration of receipt-owned scalar keys whose post-fix values still
match. Otherwise it refuses without overwriting user changes. Backups,
replacements, and receipt writes use atomic operations and preserve the existing
`models.json` access mode. Fix and rollback transactions serialize across
extension instances; rollback binds the exact receipt file identity and hash from
preview through commit and refuses if another transaction replaces or rewrites it.
Creating a previously absent config uses atomic no-replace semantics. Receipt
marking is part of rollback: if it fails after the config mutation, the extension
must restore the exact post-fix config under identity/hash/mode guards rather than
leave an actionable receipt paired with an already-rolled-back file.

## Scenario: privacy-safe deterministic tool ordering

### 1. Scope / Trigger

This contract applies when the opt-in environment gate is enabled during provider-request hooks. It covers deterministic sorting of verified built-in tool payloads.

### 2. Signature

```ts
normalizeToolsInPayload(payload, api): { payload: unknown; changed: boolean };
```

`PI_CACHE_OPTIMIZER_TOOL_ORDER` accepts only `1`, `true`, `yes`, or `on` as opt-in values and is additionally gated by runtime enablement.

### 3. Contracts

- Sorting is exact-name/index stable, immutable, allowlisted, and composed with existing request mutations.
- The pure helper may verify OpenAI Responses fixtures, but the request hook preserves the existing Responses/Codex bypass.
- Cache-marked tools and Anthropic deferred-tool groups remain unchanged.
- Shallow path cloning preserves unrelated special-object and tool-object identity.
- No prompt baseline, epoch, or durable prompt-derived state is introduced.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| Gate absent/non-truthy or runtime disabled | Do not rewrite or reorder; retain the normal request pipeline. |
| Unknown API, malformed tool, missing name, unsupported wrapper, tool cache marker, or Anthropic deferred grouping | Return the original payload unchanged. |
| Google/Vertex payload contains `AbortSignal` | Sort the verified `config.tools` path while retaining the signal by identity. |
| Verified payload is already sorted or has equal-name ties | Return the original payload and preserve original order. |

### 5. Good / Base / Bad Cases

- **Good**: a Google payload sorts `config.tools[].functionDeclarations` while preserving `config.abortSignal` and tool objects by reference.
- **Base**: a malformed, custom, cache-marked, deferred, or already sorted payload is returned unchanged.
- **Bad**: the full payload is cloned, caller input is mutated, or sorting moves an OpenAI-compatible `cache_control` marker.

### 6. Tests Required

- Assert immutable sorting for every allowlisted built-in shape, actual Google/Vertex nesting, `AbortSignal` identity, exact ordering and ties, and field preservation.
- Assert all-API cache-marker no-op, Anthropic deferred-group no-op, malformed/custom/unknown no-ops, Responses hook bypass, runtime/env gates, and composition with TTL/retention/cache-key behavior.
- Run the fixture verifier and confirm it reports only structural ordering metrics and unavailable provider cache measurements.

### 7. Wrong vs Correct

```ts
// Wrong: full cloning can reject SDK objects and breaks identity semantics.
const clone = structuredClone(providerPayload);
clone.tools.sort(compareByName);

// Correct: validate first and shallow-clone only the changed path.
const normalized = normalizeToolsInPayload(providerPayload, api);
return normalized.changed ? normalized.payload : undefined;
```

## Scenario: credential-blind endpoint diagnostics

### 1. Scope / Trigger

Doctor output and request lifecycle snapshots may inspect `model.baseUrl`, which
can contain embedded credentials even though it is model metadata.

### 2. Signature

```ts
snapshotBaseUrlForDiagnostics(baseUrl: unknown): string;
```

### 3. Contracts

Use the shared helper for endpoint display and snapshots. Parse only HTTP(S)
URLs with a hostname; strip userinfo, query, and fragment. Missing, malformed,
or opaque endpoints return an empty string, never a best-effort raw fallback.
Doctor shows `(default)` for missing values and `(unavailable)` for invalid ones.
Sanitization MUST NOT mutate the transport model or request URL.

### 4. Validation & Error Matrix

| Condition | Behavior |
|---|---|
| HTTP(S) URL with userinfo/token query/fragment | Display only sanitized endpoint. |
| Malformed authority, opaque URL, non-HTTP scheme | Return empty; display unavailable. |
| Missing endpoint | Display default. |

### 5. Good / Base / Bad Cases

* Good: authenticated endpoint diagnostics retain host/path but no credentials.
* Base: a normal HTTP(S) endpoint remains useful for diagnosis.
* Bad: a failed `new URL()` falls back to raw text or regex-based redaction.

### 6. Tests Required

`tests/deep-review-regressions.test.ts` exercises actual doctor commands with
fake credentials, encoded userinfo, query/fragment, malformed/opaque URLs,
safe/missing endpoints, and unchanged original transport URLs.

### 7. Wrong vs Correct

```ts
// Wrong: baseUrl itself may contain secrets.
lines.push(`Base URL: ${model.baseUrl}`);
// Correct: never display raw input on parse failure.
const endpoint = snapshotBaseUrlForDiagnostics(model.baseUrl);
```

## Review checklist

- [ ] Tool ordering is off by default and suppressed by runtime disable.
- [ ] Sorting is allowlisted, immutable, stable, shallow-cloned, and cache-control/grouping safe.
- [ ] Unknown/custom/malformed payloads are exact no-ops.
- [ ] No prompt, payload, headers, credentials, response bodies, or raw session ids are persisted or logged.
- [ ] Endpoint diagnostics strip credentials/query/fragment and never echo malformed URLs.
- [ ] README, binding spec, hook/state docs, tests, and verifier describe the same behavior.
