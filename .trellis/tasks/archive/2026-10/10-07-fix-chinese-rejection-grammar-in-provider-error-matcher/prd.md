# Fix Chinese rejection grammar in the provider error matcher

## Problem

After switching to `jiyuanlvdong/glm-5.3-flash` (a third-party `openai-completions`
proxy at `https://tokenrhythm.studio/v1`), every request failed with
`400: {"code":"UNKNOWN_FIELD","message":"未知请求字段：prompt_cache_key",...}`.

Two layers were diagnosed:

1. Direct cause: the extension's `before_provider_request` key fallback injects
   Pi's session id as `prompt_cache_key` into third-party openai-completions
   payloads; this endpoint rejects the field with a **Chinese-localized** 400.
   (`pipi`/ss2a.top accepts the field, which is why only this channel errored.)
2. Extension gap: the designed evidence-based repair path
   (`/cache-optimizer fix` → `promptCacheKey.omit`) is gated on
   `hasPromptCacheKeyUnsupportedText`, whose grammar is English-only
   (`unknown|unrecognized|unexpected` + `field|parameter|input|argument` + key).
   The Chinese message `未知请求字段：prompt_cache_key` matches none of the three
   patterns (verified by running the actual regexes against the actual message:
   p1/p2/p3 all false). So no ⚠️ fires, no evidence is recorded, `/fix` cannot
   propose the repair, and the 400 repeats forever on this endpoint.

`hasReasoningProtocolRejectionText` has the same English-only limitation
(thinking-parameter rejections phrased in Chinese would not match).

## Approved scope (user instruction: 先修B + reasoning-protocol 一并修复)

- Extend `hasPromptCacheKeyUnsupportedText` with a Chinese rejection grammar
  branch: 未知/未识别/不支持/不允许 + (请求)?(字段|参数) + `[：:]` + key, with the
  same grammar-bound strictness as the English branch (rejection word + field
  word + key + terminal lookahead). Keep the deliberate precision: a rejected
  VALUE or a conditional restriction is still not a match.
- Extend `hasReasoningProtocolRejectionText` with the Chinese equivalent for the
  thinking-parameter rejection it already matches in English.
- Do NOT touch request behavior: the repair stays (a) evidence-gated — only a
  model that actually returned the 400 is recorded; (b) model-scoped — the
  exact provider/modelId; (c) user-invoked — the response hook never edits
  config, `/cache-optimizer fix` proposes with an explicit preview.
- Comprehensive tests with the exact observed error strings, both positive
  (Chinese rejection matches) and negative (non-rejection Chinese text must
  not match).

## Follow-up (second half, after B lands)

- Fix A: add `promptCacheKey.omit: ["jiyuanlvdong/glm-5.3-flash"]` to the
  user-level `~/.pi/agent/pi-cache-optimizer-config.json` (version 2 allows
  `promptCacheKey`; omit entries are `provider/modelId` strings matching the
  receipt format), then verify `isPromptCacheKeyOmittedForModel` +
  `omitOpenAIPromptCacheKeys` against the real config file and a payload
  carrying both key spellings. The failing session must be restarted or
  `/reload` run for the module-level config read to pick it up.

## Implementation and verification

- Added strict Chinese-localized rejection grammars for `prompt_cache_key` and
  the `thinking` → `reasoning_effort` protocol signal. Positive cases include
  the exact observed `未知请求字段：prompt_cache_key` and Chinese reasoning
  rejection/recommendation text; negative cases cover value errors, conditional
  restrictions, negated guidance, and recommendations split across headers.
- Kept request behavior unchanged: evidence remains process-local and exact
  provider/model scoped; response hooks do not edit configuration; config fixes
  still require a user-invoked preview and confirmation.
- Updated both READMEs and the frontend contract spec with the localized error
  recognition and its precision boundaries.
- `npm run check`: passed typecheck, 179 tests, diff check, module graph check
  (26 source modules, no cycles), and package check (31 packed files; relative
  imports resolve).
- Applied A through the interactive fix-command path with confirmation. The
  user-level version-2 config now omits only
  `jiyuanlvdong/glm-5.3-flash`; the original footer mode and file mode were
  preserved. A fresh module load read the persisted rule, both request-key
  spellings were removed, and receipt/backup hashes verified.
- The already-running failing session still needs `/reload` or a restart to
  load the updated module-level config.
- Synchronized ancestry by merging `origin/master` (`59f3e77`) into the task
  branch with a no-content merge commit (`e93fb24`); the synced main tree was
  identical to the common base, and all four existing local commits were
  preserved without rebase. Mainline preflight now passes and permits the
  handoff boundary.

## Evidence

- Error timeline from `~/.pi/agent/sessions/--home-jiang-jiang-source-idea-aishield--/2026-10-05T11-09-28-727Z_*.jsonl`
  (UTC 02:21:13 model_change → 02:22:08 timeout → 02:22:25 + 02:23:52 400
  UNKNOWN_FIELD → 02:24:18 switch away).
- Pattern verification: normalized message
  `400: {code:unknown field,message:未知请求字段：prompt cache key,data:{field:prompt cache key},...}`
  fails all three English patterns.
- Main-session work per user instruction; no sub-agents.
