/**
 * Step 3: realistic multi-turn workload against the real provider, strictly serial (concurrency 1).
 * Each session runs TURNS user turns inside a throwaway clone of this Trellis repo; between turns the git status
 * (every turn) and recent commits (every other turn) change, which is the churn the prompt rewrite targets.
 * Sessions of all groups are interleaved in randomized blocks so time-of-day and upstream drift hit every group equally.
 *
 * Env: BENCH_SESSIONS (per group, default 2), BENCH_TURNS (default 6), BENCH_GAP_MS (default 3000), BENCH_GROUPS (csv filter).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OUT_DIR, loadProviderConfig, sleep } from "./lib.ts";
import { runPi } from "./pi-run.ts";
import { startProxy } from "./proxy.ts";
import { TURN_PROMPTS, WORKLOAD_GROUPS, mutateBetweenTurns, prepareBenchHome, prepareWorkspace } from "./workload.ts";

const PROVIDER = process.env.BENCH_PROVIDER || "xiaojimao";
const MODEL = process.env.BENCH_MODEL || "gpt-6-luna";
const SESSIONS = Number(process.env.BENCH_SESSIONS || 2);
const TURNS = Number(process.env.BENCH_TURNS || 6);
const GAP_MS = Number(process.env.BENCH_GAP_MS || 3000);
const only = process.env.BENCH_GROUPS?.split(",");
const groups = WORKLOAD_GROUPS.filter((g) => !only || only.includes(g.name));

const config = loadProviderConfig(PROVIDER, MODEL);
const outDir = join(OUT_DIR, `ab-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
// Agent dirs hold a models.json copy with the API key; keep them inside this run's dir and remove them on any exit.
process.env.BENCH_AGENTS_DIR = join(outDir, "agents");
process.env.BENCH_HOME = prepareBenchHome(outDir);
const cleanup = () => rmSync(process.env.BENCH_AGENTS_DIR!, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { cleanup(); process.exit(130); });

// Upstream 503s and Pi's retries must not eat the budget, so it is generous; the run is bounded by sessions x turns.
const proxy = await startProxy({ upstreamBase: config.baseUrl, minGapMs: GAP_MS, maxRequests: 5000, outDir });

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

let consecutiveFailures = 0;
outer: for (let block = 0; block < SESSIONS; block++) {
  for (const group of shuffle(groups)) {
    const label = `${group.name}.s${block}`;
    const sessionId = randomUUID();
    const ws = prepareWorkspace();
    const summary: string[] = [];
    for (let turn = 0; turn < TURNS; turn++) {
      const result = await runPi({
        config, group, label, port: proxy.port, sessionId, prompt: TURN_PROMPTS[turn % TURN_PROMPTS.length],
        cwd: ws.dir, noTools: false, extensions: [ws.trellisExtension], thinking: "low", timeoutMs: 600_000,
      });
      summary.push(result.code === 0 ? "ok" : `exit${result.code}`);
      consecutiveFailures = result.code === 0 ? 0 : consecutiveFailures + 1;
      mutateBetweenTurns(ws.dir, turn);
      await sleep(GAP_MS);
      if (consecutiveFailures >= 4) {
        console.error(`aborting: 4 consecutive Pi failures (last stderr: ${result.stderr.slice(0, 300)})`);
        rmSync(ws.dir, { recursive: true, force: true });
        break outer;
      }
    }
    rmSync(join(process.env.BENCH_AGENTS_DIR!, label), { recursive: true, force: true });
    rmSync(ws.dir, { recursive: true, force: true });
    console.log(`block ${block + 1}/${SESSIONS} ${label}: ${summary.join(",")}`);
  }
}
await proxy.close();
cleanup();
console.log(`done. analyze: node --import jiti/register benchmarks/real-cache/analyze-ab.ts ${proxy.logFile}`);
