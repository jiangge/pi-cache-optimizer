# Investigate Kiro Claude 0% cache hit rate

## Goal

Stats observation (2026-05-17 from `~/.pi/agent/pi-cache-optimizer-stats.json`):

```
claude:  0 hits / 133 requests, 0 cached / 22.3M total input tokens (0%)
openai: 47 hits / 56 requests, 6.5M cached / 7.85M total tokens (84%)
```

The user routes Claude through `kiro` provider (OpenAI-compatible). 22.3M
prompt tokens at 0% hit rate is plausibly the largest single line item on the
user's account. Before the recent pi-cache-optimizer fix landed, OpenAI-family
models were already getting 84%; cache-correctness for Claude over the Kiro
proxy is the next biggest cost lever.

## What I already know

(Original assumptions corrected by the investigation below — see
`research/kiro-cache-passthrough.md` for the full evidence trail.)

* The Kiro integration is **not** an `openai-completions` proxy in
  `models.json`. It is a pi extension package, `pi-provider-kiro@0.6.1`
  (configured in `~/.pi/agent/settings.json` as `"npm:pi-provider-kiro"`),
  which registers a custom API id `kiro-api` and a custom `stream`
  function. The user's `models.json` `"kiro": { modelOverrides: ... }`
  block only renames display labels and remaps thinking levels; it does
  not configure the underlying transport.
* The transport is `POST https://q.<region>.amazonaws.com/generateAssistantResponse`
  with header `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`.
  Body shape: `{ conversationState: { currentMessage: { userInputMessage: { content, modelId, ... } }, history }, agentMode: "vibe", ... }`.
  This is the AWS CodeWhisperer / Amazon Q Developer streaming protocol
  — not Anthropic Messages, not OpenAI Chat Completions, not Bedrock
  Converse.
* Session JSONL confirms wire identity: every assistant message from a
  Kiro Claude run carries `"provider":"kiro"`, `"api":"kiro-api"`, and
  `usage.cacheRead === 0`, `usage.cacheWrite === 0`.
* Pi's compat-driven `cacheControlFormat: "anthropic"` injection runs
  **inside** the openai-completions and anthropic-messages adapters.
  Custom-API extensions own their own request body and are not visited
  by that compat layer.
* `pi-provider-kiro/README.md` claims "All listed models are free to
  use through Kiro." The cost framing in the earlier draft of this PRD
  is therefore likely wrong for Kiro specifically. The real lever Kiro
  caches against is `MONTHLY_REQUEST_COUNT` (a per-account quota the
  provider's retry logic specifically watches as non-retryable).

## Open Questions (resolved)

* **Q1: Does Kiro pass through Anthropic `cache_control` markers and
  surface `cache_read_input_tokens` / `cache_creation_input_tokens`?**
  → **NO.** Verified by source-reading `pi-provider-kiro@0.6.1`:
  `grep -nE 'cache_control|cachePoint|cache_read_input|cacheReadInputTokens|cacheCreationInputTokens'`
  across the entire `dist/` tree returns zero matches. All
  `cacheRead`/`cacheWrite` references are zero-initializers, not
  assignments from response data. The wire format `userInputMessage`
  is a flat string with no slot for cache_control markers.
* **Q2: Documented cache support?** → No. README and source contain
  no mention of prompt caching. The only "cache" references in source
  are AWS SSO token cache, profile-ARN cache, and zero-init usage
  records.
* **Q3: Server-side caching path?** → Even if AWS Q caches internally,
  the streaming protocol's metadata events do not surface a cache-token
  breakdown. Pi has nothing to observe.

## Assumptions (resolved)

* Earlier assumption "this is a cost lever" → **partially incorrect**.
  Kiro models are advertised as free; the lever is the monthly request
  cap, not per-token billing. Footer 0% is still truthful but is not
  the cost line item the original PRD framed.
* Earlier assumption "models.json edit can fix this" → **incorrect**.
  No compat flag in models.json reaches the kiro-api transport.
* The constraint is upstream of pi-cache-optimizer. The right action
  is documentation + (optionally) a tuned warning that targets the
  Kiro case specifically and tells the user the truth: this won't be
  fixed by anything they can flip on their side.

## Requirements

* R1 (resolved): Q1 is answered. No further empirical work needed beyond
  what is already in `research/kiro-cache-passthrough.md`.
* R2 (dropped): no `models.json` change. The transport is owned by
  `pi-provider-kiro`; no compat flag from our side reaches it.
* R3 (active): **Document the constraint** in
  `.trellis/spec/frontend/cache-adapter-footer-stats.md` so future
  contributors don't re-investigate the same dead end. Add a
  "Provider transport caveats" section stating that `kiro-api`
  (provider id `kiro`, package `pi-provider-kiro`) does not surface
  cache fields and that the Claude footer will show 0% on Kiro
  Claude models — this is by design, not a bug in the cache adapter.
* R4 (resolved — option 1): Claude `warningText` stays silent on
  `kiro-api`. No `index.ts` code change. Decision recorded in
  Decision section below; spec note carries the rationale.
* R5: footer stats keep showing 0% on Kiro. That is truthful and must
  not be papered over.

## Acceptance Criteria

* [x] Q1 answered with empirical evidence — `research/kiro-cache-passthrough.md`.
* [ ] `cache-adapter-footer-stats.md` has a "Kiro / kiro-api" caveat
      paragraph that includes:
      - the wire identity (`provider: kiro`, `api: kiro-api`,
        package `pi-provider-kiro`)
      - the source-of-truth pointer (no `cache_control`/`cacheReadInputTokens`
        in `pi-provider-kiro/dist/`)
      - the explicit non-action: footer 0% is correct; do NOT add
        a special-case bump.
* [x] R4 decided: warning stays silent for `kiro-api`. Spec records
      the decision and rationale. No `index.ts` code change.
* [ ] No `models.json` write, no `.bak` write, no extension code path
      that injects cache_control markers into Kiro request bodies.

## Out of Scope

* Switching the user away from Kiro to direct Anthropic. Login /
  account-tier decision, not a cache fix.
* Inserting cache markers ourselves in `before_provider_request` or
  any other hook. Pi's cache machinery isn't reachable on `kiro-api`,
  and re-implementing it at the extension level would mangle the Kiro
  request body.
* Submitting a patch upstream to `pi-provider-kiro` to surface cache
  fields. That repo is owned externally; out of scope for this task.
  (May be worth filing a tracking note in our workspace journal.)
* Building a generic "force cache_control on any Claude-like
  custom-API endpoint" feature. Unsafe; per-provider verification
  required for each.

## Decision (R4) — locked

The Claude `warningText` in `index.ts` currently only fires when
`isOpenAICompatibleApi(model.api)` is true. For `kiro-api` it stays
silent today.

**Locked: option 1 — stay silent on `kiro-api`.**

Reason: the existing compat warning exists to nudge the user toward
flipping a flag (`compat.cacheControlFormat: "anthropic"`). On Kiro
there is no flag the user can flip; the limitation lives entirely
inside `pi-provider-kiro`. A notification with no actionable
suggestion is startup noise. The spec caveat in
`cache-adapter-footer-stats.md` is sufficient for future contributors
landing here re-investigating.

Rejected option 2 (add a Kiro-specific informational warning) for
the same reason: pure-information warnings train users to ignore the
notification surface.

## Research References

* [`research/kiro-cache-passthrough.md`](research/kiro-cache-passthrough.md)
  — Source-level evidence that `pi-provider-kiro@0.6.1` does not send
  cache_control markers and does not surface cache_read /
  cache_creation token counts.

## Technical Notes

* Files of interest if R3/R4 implementation lands:
  - `.trellis/spec/frontend/cache-adapter-footer-stats.md` — add the
    Kiro caveat section.
  - `index.ts` (this repo) — Claude adapter `warningText` and
    `notifyCacheCompatIfNeeded`. Only touch if R4 = option 2.
  - `~/.../pi-provider-kiro/dist/{stream.js,usage.js}` — read-only
    references for the spec note; do NOT modify the installed package.
* Verification of Q1 used only source reading and session JSONL.
  Mitmproxy / curl reproduction is no longer needed; the answer is
  unambiguous from the package source.
* Cost framing in the original PRD ("22.3M tokens at full input rate")
  was likely off because Kiro models are advertised as free. The real
  pressure point is `MONTHLY_REQUEST_COUNT` quota — but Kiro decides
  on its side whether cache hits count differently against that quota,
  and we have no way to observe the answer locally.
