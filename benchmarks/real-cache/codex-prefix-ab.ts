/**
 * OpenAI Codex prompt-cache comparison on the real provider.
 *
 * Arms (all use PI_CACHE_RETENTION=long so prompt construction is the primary variable):
 *   CORE    Pi 1.0 prompt sections, no cache-optimizer extension.
 *   V216    Current extension with prompt rewrite disabled. On openai-codex this reproduces
 *           v2.8.16's prompt behavior because v2.8.16 bypassed all Responses/Codex prompt edits.
 *   CURRENT Current extension behavior (Pi sections + in-place churn strip/skill compression).
 *   LEGACY  Counterfactual only: CURRENT plus the benchmark-only pre-2.8.17 stable-prefix lift.
 *           v2.8.16 never shipped this behavior for openai-codex.
 *
 * OAuth credentials are copied only into per-run ignored agent directories and deleted on exit.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OUT_DIR, loadProviderConfig, sleep } from "./lib.ts";
import { runPi, type PiGroup } from "./pi-run.ts";
import { TURN_PROMPTS, mutateBetweenTurns, prepareBenchHome, prepareWorkspace } from "./workload.ts";

const PROVIDER = process.env.BENCH_PROVIDER || "openai-codex";
const MODEL = process.env.BENCH_MODEL || "gpt-6-luna";
const SESSIONS = Number(process.env.BENCH_SESSIONS || 3);
const TURNS = Number(process.env.BENCH_TURNS || 4);
const GAP_MS = Number(process.env.BENCH_GAP_MS || 2500);
const SEED = Number(process.env.BENCH_SEED || 20261003);
const only = process.env.BENCH_GROUPS?.split(",").map((v) => v.trim()).filter(Boolean);
const legacyExtension = fileURLToPath(new URL("./legacy-reorder-extension.ts", import.meta.url));
const observerExtension = fileURLToPath(new URL("./codex-observer-extension.ts", import.meta.url));

type Arm = PiGroup & { description: string; postExtensions?: string[] };
const arms: Arm[] = [
  { name: "CORE", extension: false, env: { PI_CACHE_RETENTION: "long" }, description: "Pi 1.0 core prompt order; long retention normalized" },
  { name: "V216", extension: true, env: { PI_CACHE_RETENTION: "long", PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE: "1" }, description: "v2.8.16-equivalent Codex prompt behavior (Responses prompt edits bypassed)" },
  { name: "CURRENT", extension: true, env: { PI_CACHE_RETENTION: "long" }, description: "current in-place churn strip + skill compression" },
  { name: "LEGACY", extension: true, env: { PI_CACHE_RETENTION: "long" }, postExtensions: [legacyExtension], description: "counterfactual current + legacy stable-prefix lift; never shipped for Codex in v2.8.16" },
].filter((arm) => !only || only.includes(arm.name));

if (!Number.isInteger(SESSIONS) || SESSIONS < 1) throw new Error("BENCH_SESSIONS must be a positive integer");
if (!Number.isInteger(TURNS) || TURNS < 2) throw new Error("BENCH_TURNS must be an integer >= 2");
if (!arms.length) throw new Error("BENCH_GROUPS selected no known arms");

const config = loadProviderConfig(PROVIDER, MODEL);
const outDir = join(OUT_DIR, `codex-prefix-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
process.env.BENCH_AGENTS_DIR = join(outDir, "agents");
process.env.BENCH_HOME = prepareBenchHome(outDir);

writeFileSync(join(outDir, "manifest.json"), JSON.stringify({
  benchmark: "codex-prefix-ab",
  version: 1,
  provider: PROVIDER,
  model: MODEL,
  sessionsPerArm: SESSIONS,
  turnsPerSession: TURNS,
  gapMs: GAP_MS,
  seed: SEED,
  arms: arms.map(({ name, description }) => ({ name, description })),
  note: "OAuth/API credentials are not recorded in this manifest or request logs.",
}, null, 2));

const cleanup = () => rmSync(process.env.BENCH_AGENTS_DIR!, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { cleanup(); process.exit(130); });

const observerFile = join(outDir, "requests.jsonl");

let rngState = SEED >>> 0;
function random(): number {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) / 0x1_0000_0000;
}
function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

let consecutiveFailures = 0;
try {
  outer: for (let block = 0; block < SESSIONS; block++) {
    for (const arm of shuffle(arms)) {
      const label = `${arm.name}.s${block}`;
      const sessionId = randomUUID();
      const namespace = randomUUID();
      const ws = prepareWorkspace();
      const summary: string[] = [];
      try {
        for (let turn = 0; turn < TURNS; turn++) {
          const result = await runPi({
            config,
            group: arm,
            label,
            sessionId,
            prompt: TURN_PROMPTS[turn % TURN_PROMPTS.length],
            cwd: ws.dir,
            noTools: false,
            extensions: [ws.trellisExtension],
            postExtensions: [...(arm.postExtensions ?? []), observerExtension],
            benchmarkNamespace: namespace,
            benchmarkObserverFile: observerFile,
            thinking: "low",
            timeoutMs: 600_000,
          });
          summary.push(result.code === 0 ? "ok" : `exit${result.code}`);
          consecutiveFailures = result.code === 0 ? 0 : consecutiveFailures + 1;
          mutateBetweenTurns(ws.dir, turn);
          await sleep(GAP_MS);
          if (consecutiveFailures >= 4) {
            console.error(`aborting: 4 consecutive Pi failures (last stderr: ${result.stderr.slice(0, 300)})`);
            break outer;
          }
        }
      } finally {
        rmSync(join(process.env.BENCH_AGENTS_DIR!, label), { recursive: true, force: true });
        rmSync(ws.dir, { recursive: true, force: true });
      }
      console.log(`block ${block + 1}/${SESSIONS} ${label}: ${summary.join(",")}`);
    }
  }
} finally {
  cleanup();
}

console.log(`done. analyze: node --import jiti/register benchmarks/real-cache/analyze-codex-prefix.ts ${observerFile}`);
