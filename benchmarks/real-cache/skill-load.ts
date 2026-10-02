/**
 * Skill-loading check: does the model still pick the right skill and read the right path when the skills list is
 * compressed? Each trial gives a task phrased WITHOUT the skill's name; the model must read the matching SKILL.md.
 *   X0 = original Pi XML list (NO_SKILL_COMPRESSION=1)     X1 = compressed grouped Markdown list (default)
 * Env: BENCH_REPEATS (per prompt per group, default 2), BENCH_GAP_MS (default 3000).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { OUT_DIR, loadProviderConfig, sleep } from "./lib.ts";
import { runPi, type PiGroup } from "./pi-run.ts";
import { startProxy, type RecordedRequest } from "./proxy.ts";
import { prepareBenchHome } from "./workload.ts";

const REPEATS = Number(process.env.BENCH_REPEATS || 2);
const GAP_MS = Number(process.env.BENCH_GAP_MS || 3000);
const WRAP = "Do not perform the task itself. Your only job: load the single most relevant skill by reading its SKILL.md with the read tool, then reply with just the skill name. Task: ";
const TRIALS: Array<{ id: string; task: string; accept: string[] }> = [
  { id: "quieter", task: "The settings page feels visually loud and overwhelming. Tone it down.", accept: ["quieter"] },
  { id: "critique", task: "Give me a design critique of our landing page's hierarchy and cognitive load.", accept: ["critique"] },
  { id: "adapt", task: "Make this layout work on phones and tablets: breakpoints and touch targets.", accept: ["adapt"] },
  { id: "to-prd", task: "Turn our discussion so far into a PRD and publish it to the issue tracker.", accept: ["to-prd"] },
  { id: "code-review", task: "Review my current diff for correctness bugs.", accept: ["code-review"] },
  { id: "diagnose", task: "A test fails intermittently; run a disciplined reproduce-and-minimise debugging loop.", accept: ["diagnose"] },
  { id: "grill-me", task: "Interview me relentlessly about my plan until we reach shared understanding.", accept: ["grill-me", "grill-with-docs"] },
  { id: "wrangler", task: "Deploy this Worker with the Cloudflare CLI.", accept: ["wrangler", "cloudflare", "workers-best-practices"] },
];
const GROUPS: PiGroup[] = [
  { name: "X0", extension: true, env: { PI_CACHE_OPTIMIZER_NO_SKILL_COMPRESSION: "1" } },
  { name: "X1", extension: true },
];

const config = loadProviderConfig(process.env.BENCH_PROVIDER || "xiaojimao", process.env.BENCH_MODEL || "gpt-6-luna");
const outDir = join(OUT_DIR, `skillload-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
process.env.BENCH_AGENTS_DIR = join(outDir, "agents");
process.env.BENCH_HOME = prepareBenchHome(outDir);
const cleanup = () => rmSync(process.env.BENCH_AGENTS_DIR!, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { cleanup(); process.exit(130); });
const proxy = await startProxy({ upstreamBase: config.baseUrl, minGapMs: GAP_MS, maxRequests: 3000, outDir });

type Trial = { group: string; id: string; rep: number };
const queue: Trial[] = [];
for (let rep = 0; rep < REPEATS; rep++) for (const t of TRIALS) for (const g of GROUPS) queue.push({ group: g.name, id: t.id, rep });
// Randomized order so drift and upstream state do not line up with a group.
queue.sort(() => Math.random() - 0.5);

const cwd = mkdtempSync(join(tmpdir(), "bench-skill-cwd-"));
for (const [i, trial] of queue.entries()) {
  const group = GROUPS.find((g) => g.name === trial.group)!;
  const spec = TRIALS.find((t) => t.id === trial.id)!;
  const label = `${trial.group}.${trial.id}.r${trial.rep}`;
  const result = await runPi({ config, group, label, port: proxy.port, sessionId: randomUUID(), prompt: WRAP + spec.task, cwd, noTools: false, thinking: "low", timeoutMs: 600_000 });
  rmSync(join(process.env.BENCH_AGENTS_DIR!, label), { recursive: true, force: true });
  console.log(`${i + 1}/${queue.length} ${label} exit=${result.code} out=${JSON.stringify(result.stdout.trim().slice(0, 40))}`);
  await sleep(GAP_MS);
}
await proxy.close();
cleanup();
rmSync(cwd, { recursive: true, force: true });

// Evaluate from the recorded request bodies: which SKILL.md paths did the model read?
const rows: RecordedRequest[] = readFileSync(proxy.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
type Outcome = { label: string; group: string; id: string; read: string[]; pickedOk: boolean; pathOk: boolean; firstPromptTokens?: number };
const outcomes: Outcome[] = [];
for (const trial of queue) {
  const label = `${trial.group}.${trial.id}.r${trial.rep}`;
  const spec = TRIALS.find((t) => t.id === trial.id)!;
  const mine = rows.filter((r) => r.label === label && r.status === 200);
  const read: string[] = [];
  const last = mine.at(-1);
  if (last) {
    const body = JSON.parse(readFileSync(join(outDir, last.bodyFile), "utf8"));
    for (const m of body.messages ?? []) for (const call of m.tool_calls ?? []) {
      try {
        const args = JSON.parse(call.function.arguments);
        const p = String(args.path ?? args.file_path ?? "");
        if (p.endsWith("SKILL.md")) read.push(p);
      } catch { /* ignore malformed arguments */ }
    }
  }
  const names = read.map((p) => p.split("/").at(-2)!);
  outcomes.push({
    label, group: trial.group, id: trial.id, read,
    pickedOk: names.some((n) => spec.accept.includes(n)),
    pathOk: read.length > 0 && read.every((p) => existsSync(p)),
    firstPromptTokens: mine[0]?.usage.promptTokens,
  });
}
console.log("\ngroup trials pickedCorrectSkill readExistingPath noSkillRead meanFirstPromptTokens");
for (const g of GROUPS) {
  const list = outcomes.filter((o) => o.group === g.name);
  const tokens = list.map((o) => o.firstPromptTokens).filter((x): x is number => x !== undefined);
  console.log([g.name.padEnd(5), String(list.length).padStart(6), `${list.filter((o) => o.pickedOk).length}/${list.length}`.padStart(17),
    `${list.filter((o) => o.pathOk).length}/${list.length}`.padStart(16), String(list.filter((o) => o.read.length === 0).length).padStart(11),
    String(Math.round(tokens.reduce((a, b) => a + b, 0) / Math.max(1, tokens.length))).padStart(22)].join("  "));
}
console.log("\nper trial (X0 vs X1):");
for (const t of TRIALS) {
  const fmt = (g: string) => outcomes.filter((o) => o.group === g && o.id === t.id).map((o) => (o.read.length ? o.read.map((p) => p.split("/").at(-2)).join("+") : "NONE")).join(" | ");
  console.log(`  ${t.id.padEnd(12)} X0: ${fmt("X0").padEnd(40)} X1: ${fmt("X1")}`);
}
console.log(`log: ${proxy.logFile}`);
