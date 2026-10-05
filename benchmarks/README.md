# Maintainer benchmarks

This directory contains development-only measurement and research tooling. It is intentionally excluded from the published `pi-cache-optimizer` package and is not required to install, configure, or use the extension.

The scripts are kept in Git so cache-optimization claims and past design decisions remain reproducible. They may use local Pi sessions, provider credentials already configured on the maintainer machine, recording proxies, repeated workloads, or offline snapshots. Captured request bodies and experiment output must remain under ignored local output directories and must not be committed.

Useful entry points:

- `prompt-prefix-stability.ts` — offline prompt-prefix stability measurement.
- `snapshot-provider-usage.ts` — snapshot provider-reported cache counters.
- `provider-usage-analysis.ts` — compare previously captured provider-usage windows.
- `real-cache/` — maintainer-only real-provider A/A and A/B harnesses, probes, workload drivers, and analysis scripts.

For the Pi 1.0 / OpenAI Codex prompt-prefix comparison, `real-cache/codex-prefix-ab.ts` runs randomized real-provider blocks across Pi core, v2.8.16-equivalent Codex prompt behavior, the current optimizer, and a benchmark-only legacy-reorder counterfactual. Analyze its `requests.jsonl` with `real-cache/analyze-codex-prefix.ts`. The Codex arm supports Pi OAuth without writing credentials into benchmark logs; temporary isolated auth copies are deleted when the run exits.

`real-cache/tourstory-task-ab.ts` is the higher-level real-project benchmark: it gives Pi the same production-style TourStory implementation task under Pi core, exact v2.8.16, and the current checkout, then records request usage, diffs and checks. `real-cache/analyze-tourstory-task.ts` treats total monetary cost as the primary metric after task-quality validation. If a subscription/custom model reports zero runtime cost, pass the installed catalog prices explicitly with `BENCH_PRICE_INPUT`, `BENCH_PRICE_OUTPUT`, `BENCH_PRICE_CACHE_READ`, and `BENCH_PRICE_CACHE_WRITE` (prices per 1M tokens); the report labels this as `catalog` rather than `runtime` cost.

For repeated task runs, set `BENCH_REPLICATES` and `BENCH_START_BLOCK`; labels are recorded as `CORE.sN`, `OLD.sN`, and `CURRENT.sN`. Inspect each arm's final diff/check summary before comparing cost. If any arm in a paired block fails the task-quality bar, exclude the **whole block** from the verdict with `BENCH_EXCLUDE_BLOCKS=...`; never keep the cheaper peers from a block whose counterpart failed, because that would bias the paired comparison.

The TourStory task benchmark explicitly allowlists only Pi's built-in `read,bash,edit,write` tools, so sub-agents, MCP tools, and future extension tools cannot enter the comparison. `BENCH_EXPERIMENT=skill` switches to a causal two-arm test using the same current optimizer in both arms: `SKILL_ON` vs `SKILL_OFF` (`PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION=1`). Both request long retention. For `openai-codex`, the benchmark does **not** inject a random text namespace into the system prompt: Pi already supplies a distinct per-session `prompt_cache_key`, and changing otherwise-identical prompt text can itself perturb the model's tool trajectory. Other providers may still use the benchmark text namespace when a provider-side cache key is unavailable.

`BENCH_EXPERIMENT=trajectory` runs only `CORE` vs `CURRENT`. It is the preferred lower-cost experiment when the question is whether the current optimizer changes Pi's provider/tool-call trajectory; real discovered skills remain loaded, while the explicit tool allowlist still prevents sub-agents and unrelated custom tools.

`BENCH_EXPERIMENT=isolation` is the next causal layer for Codex trajectory regressions: `CORE_LONG` runs Pi core with `PI_CACHE_RETENTION=long`; `NO_REWRITE` loads the current optimizer with prompt rewriting disabled; `CURRENT` enables the full current optimizer. All three share long retention, real discovered skills, the same tool allowlist, and no benchmark text namespace on `openai-codex`. This separates prompt rewriting from the optimizer's non-prompt runtime behavior.

`BENCH_EXPERIMENT=skill-counterfactual` compares `NATIVE_SKILLS` (skill compression explicitly disabled) with `COMPRESSED_SKILLS` (compression enabled/forced). This does not change product behavior; it is used to measure model/provider sensitivity to the same skill-index transformation. `codex-skill-counterfactual` remains as a compatibility alias for older benchmark commands.

`real-cache/tourstory-task-ab.ts` is the task-level reality check: it clones the committed TourStory project into throwaway worktrees and asks each arm to implement the same end-to-end conversation-history feature. `OLD` loads the exact v2.8.16 extension, `CURRENT` loads this checkout, and `CORE` uses Pi alone. `real-cache/analyze-tourstory-task.ts` treats Pi-normalized total dollar cost as the primary comparison and reports cached/input tokens only as a diagnostic.

Run these scripts directly with Node + jiti from a development checkout when an experiment is needed. They are deliberately not exposed as end-user npm scripts.
