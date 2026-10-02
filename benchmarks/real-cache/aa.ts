/**
 * Step 2: A/A noise pilot. Runs several independent sessions per group, strictly serially, in randomized blocks
 * (one session of every group per block) so time-of-day drift hits all groups equally.
 *
 *   A0  Pi core, affinity headers      A0n Pi core, no affinity headers
 *   A1  extension, affinity headers    A1n extension, no affinity headers
 *
 * Env: BENCH_SESSIONS (per group, default 6), BENCH_TURNS (requests per session, default 3), BENCH_GAP_MS (default 3000).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OUT_DIR, loadProviderConfig, sleep } from "./lib.ts";
import { runPi, type PiGroup } from "./pi-run.ts";
import { startProxy } from "./proxy.ts";

const PROVIDER = process.env.BENCH_PROVIDER || "xiaojimao";
const MODEL = process.env.BENCH_MODEL || "gpt-6-luna";
const SESSIONS = Number(process.env.BENCH_SESSIONS || 6);
const TURNS = Number(process.env.BENCH_TURNS || 3);
const GAP_MS = Number(process.env.BENCH_GAP_MS || 3000);

const noAffinity = { sendSessionAffinityHeaders: false };
const GROUPS: PiGroup[] = [
  { name: "A0", extension: false },
  { name: "A0n", extension: false, compat: noAffinity },
  { name: "A1", extension: true },
  { name: "A1n", extension: true, compat: noAffinity },
];

const config = loadProviderConfig(PROVIDER, MODEL);
const outDir = join(OUT_DIR, `aa-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
// Agent dirs hold a models.json copy with the API key; keep them inside this run's dir and remove them on any exit.
process.env.BENCH_AGENTS_DIR = join(outDir, "agents");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { rmSync(process.env.BENCH_AGENTS_DIR!, { recursive: true, force: true }); process.exit(130); });
}
// Budget = planned requests + 25% slack for Pi-internal retries after upstream errors.
const budget = Math.ceil(GROUPS.length * SESSIONS * TURNS * 1.25);
const proxy = await startProxy({ upstreamBase: config.baseUrl, minGapMs: GAP_MS, maxRequests: budget, outDir });

const filler = Array.from({ length: 260 }, (_, i) =>
  `Reference item ${i}: the archive keeps record ${i * 7 + 3} under heading ${(i * 13) % 97}, cross-linked to entry ${(i * 29) % 211}.`).join("\n");
const appendFile = join(outDir, "append.txt");
writeFileSync(appendFile, `Reference material (stable):\n${filler}`);
const PROMPTS = ["Reply with the single word OK.", "Reply with the single word DONE.", "Reply with the single word NEXT.", "Reply with the single word LAST."];

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
  for (const group of shuffle(GROUPS)) {
    const label = `${group.name}.s${block}`;
    const sessionId = randomUUID();
    const cwd = mkdtempSync(join(tmpdir(), "bench-cwd-"));
    const summary: string[] = [];
    for (let turn = 0; turn < TURNS; turn++) {
      const result = await runPi({ config, group, label, port: proxy.port, sessionId, prompt: PROMPTS[turn % PROMPTS.length], cwd, appendSystemPromptFile: appendFile });
      summary.push(result.code === 0 ? "ok" : `exit${result.code}`);
      consecutiveFailures = result.code === 0 ? 0 : consecutiveFailures + 1;
      await sleep(GAP_MS);
      if (consecutiveFailures >= 3) {
        console.error(`aborting: 3 consecutive Pi failures (last stderr: ${result.stderr.slice(0, 300)})`);
        rmSync(cwd, { recursive: true, force: true });
        break outer;
      }
    }
    // The per-label agent dir holds a copy of models.json including the API key; never leave it behind.
    rmSync(join(outDir, "agents", label), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    console.log(`block ${block + 1}/${SESSIONS} ${label}: ${summary.join(",")}`);
  }
}
await proxy.close();
rmSync(join(outDir, "agents"), { recursive: true, force: true });
console.log(`done. log: ${proxy.logFile}\nanalyze: node --import jiti/register benchmarks/real-cache/analyze.ts ${proxy.logFile}`);
