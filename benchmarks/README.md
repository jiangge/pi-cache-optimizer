# Maintainer benchmarks

This directory contains development-only measurement and research tooling. It is intentionally excluded from the published `pi-cache-optimizer` package and is not required to install, configure, or use the extension.

The scripts are kept in Git so cache-optimization claims and past design decisions remain reproducible. They may use local Pi sessions, provider credentials already configured on the maintainer machine, recording proxies, repeated workloads, or offline snapshots. Captured request bodies and experiment output must remain under ignored local output directories and must not be committed.

Useful entry points:

- `prompt-prefix-stability.ts` — offline prompt-prefix stability measurement.
- `snapshot-provider-usage.ts` — snapshot provider-reported cache counters.
- `provider-usage-analysis.ts` — compare previously captured provider-usage windows.
- `real-cache/` — maintainer-only real-provider A/A and A/B harnesses, probes, workload drivers, and analysis scripts.

Run these scripts directly with Node + jiti from a development checkout when an experiment is needed. They are deliberately not exposed as end-user npm scripts.
