/**
 * Real-project task benchmark against TourStory.
 *
 * Each arm clones the same committed TourStory HEAD into a private temp tree and asks Pi
 * to implement the same end-to-end conversation-history task. The user's working tree is
 * never modified. OLD loads the exact v2.8.16 extension, CURRENT loads this checkout, and
 * CORE runs Pi without pi-cache-optimizer. A benchmark-only observer records Pi-normalized
 * usage and cost; provider credentials stay inside ignored isolated agent dirs and are deleted.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BENCH_DIR, OUT_DIR, loadProviderConfig } from "./lib.ts";
import { runPi, type PiGroup } from "./pi-run.ts";

const PROVIDER = process.env.BENCH_PROVIDER || "openai-codex";
const MODEL = process.env.BENCH_MODEL || "gpt-6-luna";
const REPLICATES = Number(process.env.BENCH_REPLICATES || 1);
const START_BLOCK = Number(process.env.BENCH_START_BLOCK || 0);
const EXPERIMENT = process.env.BENCH_EXPERIMENT || "release";
const PROJECT = resolve(process.env.BENCH_PROJECT_DIR || join(BENCH_DIR, "..", "..", "..", "idea", "tourstory"));
const SEED = Number(process.env.BENCH_SEED || 20261003);
const observerExtension = fileURLToPath(new URL("./codex-observer-extension.ts", import.meta.url));
const currentExtension = resolve(BENCH_DIR, "..", "..", "index.ts");

type Arm = PiGroup & { description: string; extensionPath?: string };

const outDir = join(OUT_DIR, `tourstory-${PROVIDER.replace(/[^\w.-]/g, "_")}-${MODEL.replace(/[^\w.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
process.env.BENCH_AGENTS_DIR = join(outDir, "agents");

// Materialize the exact old extension inside the current repo so its package imports
// resolve through this checkout's node_modules. This file lives under ignored benchmark output.
const oldDir = join(outDir, "v2.8.16");
mkdirSync(oldDir, { recursive: true });
const oldExtension = join(oldDir, "index.ts");
writeFileSync(oldExtension, execFileSync("git", ["show", "v2.8.16:index.ts"], { cwd: resolve(BENCH_DIR, "..", ".."), encoding: "utf8" }));

const arms: Arm[] = EXPERIMENT === "skill"
  ? [
      {
        name: "SKILL_ON",
        extension: false,
        extensionPath: currentExtension,
        env: { PI_CACHE_RETENTION: "long" },
        description: "current optimizer with skill compression enabled",
      },
      {
        name: "SKILL_OFF",
        extension: false,
        extensionPath: currentExtension,
        env: { PI_CACHE_RETENTION: "long", PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION: "1" },
        description: "same current optimizer with only skill compression disabled",
      },
    ]
  : [
      { name: "CORE", extension: false, description: "Pi core only" },
      { name: "OLD", extension: false, extensionPath: oldExtension, description: "exact pi-cache-optimizer v2.8.16" },
      { name: "CURRENT", extension: false, extensionPath: currentExtension, description: "current pi-cache-optimizer checkout" },
    ];

if (EXPERIMENT !== "release" && EXPERIMENT !== "skill") throw new Error("BENCH_EXPERIMENT must be release or skill");

if (!Number.isInteger(REPLICATES) || REPLICATES < 1) throw new Error("BENCH_REPLICATES must be a positive integer");
if (!Number.isInteger(START_BLOCK) || START_BLOCK < 0) throw new Error("BENCH_START_BLOCK must be a non-negative integer");

const taskPrompt = `Improve this real TourStory project by implementing conversation-history support end to end.

Requirements:
- Work only in this checkout; do not ask for clarification.
- Inspect the existing backend chat/content models and routes before editing.
- Add authenticated backend endpoints to list the current user's conversations and fetch one conversation by id. A user must never be able to read another user's conversation.
- Implement mobile ChatService.getConversations() and getConversation(id) against those endpoints, parsing the existing Conversation model.
- Add or update focused tests where practical.
- Run the relevant Rust/Flutter formatting, static checks, and tests available in this checkout; fix issues caused by your changes.
- Keep the change focused and production-quality. Do not commit or push.
- Finish with a concise summary of files changed and checks run.`;

let rngState = SEED >>> 0;
function random(): number {
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
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

const config = loadProviderConfig(PROVIDER, MODEL);
const projectHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT, encoding: "utf8" }).trim();
const observerFile = join(outDir, "requests.jsonl");
writeFileSync(join(outDir, "manifest.json"), JSON.stringify({
  benchmark: "tourstory-task-ab",
  version: 1,
  experiment: EXPERIMENT,
  provider: PROVIDER,
  model: MODEL,
  project: "tourstory",
  projectHead,
  task: taskPrompt,
  seed: SEED,
  replicates: REPLICATES,
  startBlock: START_BLOCK,
  arms: arms.map(({ name, description }) => ({ name, description })),
}, null, 2));

const cleanupAgents = () => rmSync(process.env.BENCH_AGENTS_DIR!, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { cleanupAgents(); process.exit(130); });

try {
  for (let offset = 0; offset < REPLICATES; offset++) {
    const block = START_BLOCK + offset;
    for (const arm of shuffle(arms)) {
      const label = `${arm.name}.s${block}`;
      const clone = mkdtempSync(join(tmpdir(), `tourstory-bench-${arm.name.toLowerCase()}-${block}-`));
      try {
        execFileSync("git", ["clone", "-q", "--no-hardlinks", PROJECT, clone]);
        execFileSync("git", ["checkout", "-q", projectHead], { cwd: clone });
        const extensionArgs = arm.extensionPath ? [arm.extensionPath] : [];
        const result = await runPi({
          config,
          group: arm,
          label,
          sessionId: randomUUID(),
          prompt: taskPrompt,
          cwd: clone,
          noTools: false,
          tools: ["read", "bash", "edit", "write"],
          extensions: extensionArgs,
          postExtensions: [observerExtension],
          // Codex already sends a distinct Pi-owned prompt_cache_key per session.
          // Do not perturb the semantic prompt with a random benchmark prefix there;
          // it can change the model's tool trajectory and confound task-cost comparisons.
          benchmarkNamespace: PROVIDER === "openai-codex" ? undefined : randomUUID(),
          benchmarkObserverFile: observerFile,
          thinking: "low",
          timeoutMs: 1_200_000,
        });
        writeFileSync(join(outDir, `${label}.stdout.txt`), result.stdout);
        writeFileSync(join(outDir, `${label}.stderr.txt`), result.stderr);
        writeFileSync(join(outDir, `${label}.diff.patch`), execFileSync("git", ["diff", "--binary"], { cwd: clone }));
        writeFileSync(join(outDir, `${label}.status.txt`), execFileSync("git", ["status", "--short"], { cwd: clone }));
        console.log(`${label}: exit=${result.code}`);
      } finally {
        rmSync(join(process.env.BENCH_AGENTS_DIR!, label), { recursive: true, force: true });
        rmSync(clone, { recursive: true, force: true });
      }
    }
  }
} finally {
  cleanupAgents();
}

console.log(`done: ${outDir}`);
