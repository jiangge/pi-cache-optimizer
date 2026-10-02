/**
 * Skill-loading check against the official openai-codex backend (no recording proxy: Pi talks to the real endpoint).
 *   X0 = Pi's original XML skills list        X1 = compressed grouped Markdown list (bench extension applies it)
 * Credentials: a private agent dir gets the openai-codex OAuth entry with its refresh token REPLACED, so a refresh can
 * never rotate (and invalidate) the user's real token; the access token must stay valid for the whole run.
 * Env: BENCH_REPEATS (default 2), BENCH_GAP_MS (default 4000).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BENCH_DIR, OUT_DIR, sleep } from "./lib.ts";
import { prepareBenchHome } from "./workload.ts";

const REPEATS = Number(process.env.BENCH_REPEATS || 2);
const GAP_MS = Number(process.env.BENCH_GAP_MS || 4000);
const MODEL = process.env.BENCH_MODEL || "gpt-6-luna";
const PI_CLI = join(BENCH_DIR, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
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

const realAuth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["openai-codex"];
if (!realAuth || realAuth.expires - Date.now() < 3 * 3600_000) throw new Error("openai-codex access token missing or expires within 3h; run pi once to refresh it");

const outDir = join(OUT_DIR, `skillload-codex-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
const agentDir = join(outDir, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { ...realAuth, refresh: "bench-disabled" } }), { mode: 0o600 });
const benchHome = prepareBenchHome(outDir);
const cleanup = () => rmSync(agentDir, { recursive: true, force: true }); // holds an access token
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { cleanup(); process.exit(130); });
const cwd = mkdtempSync(join(tmpdir(), "bench-skill-cwd-"));

function runPi(group: "X0" | "X1", prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const args = [
    "-p", "--mode", "json", "--no-extensions", "--no-session",
    ...(group === "X1" ? ["-e", join(BENCH_DIR, "bench-compress-ext.ts")] : []),
    "--provider", "openai-codex", "--model", MODEL, "--thinking", "low", prompt,
  ];
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: benchHome } as NodeJS.ProcessEnv;
  delete env.PI_CACHE_RETENTION;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** Walks every JSON event and collects read-tool paths and the largest input-token count reported. */
function inspect(stdout: string): { reads: string[]; inputTokens?: number; sawToolCall: boolean } {
  const reads: string[] = [];
  let inputTokens: number | undefined;
  let sawToolCall = false;
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if ((node.type === "toolCall" || node.toolName || node.name === "read") && node.arguments) {
      sawToolCall = true;
      const p = node.arguments.path ?? node.arguments.file_path;
      if (typeof p === "string" && p.endsWith("SKILL.md")) reads.push(p);
    }
    if (typeof node.input === "number" && node.input > (inputTokens ?? 0)) inputTokens = node.input;
    Object.values(node).forEach(visit);
  };
  for (const line of stdout.split("\n")) {
    try { visit(JSON.parse(line)); } catch { /* not JSON */ }
  }
  return { reads: [...new Set(reads)], inputTokens, sawToolCall };
}

const queue = TRIALS.flatMap((t) => Array.from({ length: REPEATS }, (_, rep) => (["X0", "X1"] as const).map((group) => ({ group, t, rep })))).flat();
queue.sort(() => Math.random() - 0.5);
queue.length = Math.min(queue.length, Number(process.env.BENCH_LIMIT || Infinity));
type Outcome = { group: string; id: string; reads: string[]; pickedOk: boolean; pathOk: boolean; inputTokens?: number; failed: boolean };
const outcomes: Outcome[] = [];
let consecutiveFailures = 0;
for (const [i, { group, t, rep }] of queue.entries()) {
  const result = await runPi(group, WRAP + t.task);
  const seen = inspect(result.stdout);
  const names = seen.reads.map((p) => p.split("/").at(-2)!);
  const failed = result.code !== 0 || (!seen.sawToolCall && seen.inputTokens === undefined);
  outcomes.push({ group, id: t.id, reads: seen.reads, pickedOk: names.some((n) => t.accept.includes(n)), pathOk: seen.reads.length > 0 && seen.reads.every((p) => existsSync(p)), inputTokens: seen.inputTokens, failed });
  consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
  if (process.env.BENCH_DEBUG) console.log(result.stdout.slice(0, 6000), result.stderr.slice(0, 500));
  console.log(`${i + 1}/${queue.length} ${group}.${t.id}.r${rep} exit=${result.code} reads=${names.join("+") || "NONE"} inputTokens=${seen.inputTokens ?? "?"}${failed ? ` stderr=${JSON.stringify(result.stderr.slice(0, 160))}` : ""}`);
  if (consecutiveFailures >= 4) { console.error("aborting: 4 consecutive failures"); break; }
  await sleep(GAP_MS);
}
cleanup();
rmSync(cwd, { recursive: true, force: true });

console.log("\ngroup trials failed pickedCorrectSkill readExistingPath noSkillRead meanInputTokens");
for (const g of ["X0", "X1"]) {
  const list = outcomes.filter((o) => o.group === g && !o.failed);
  const tokens = list.map((o) => o.inputTokens).filter((x): x is number => x !== undefined);
  console.log([g.padEnd(5), String(list.length).padStart(6), String(outcomes.filter((o) => o.group === g && o.failed).length).padStart(6), `${list.filter((o) => o.pickedOk).length}/${list.length}`.padStart(17),
    `${list.filter((o) => o.pathOk).length}/${list.length}`.padStart(16), String(list.filter((o) => o.reads.length === 0).length).padStart(11),
    String(Math.round(tokens.reduce((a, b) => a + b, 0) / Math.max(1, tokens.length))).padStart(15)].join("  "));
}
console.log("\nper trial:");
for (const t of TRIALS) {
  const fmt = (g: string) => outcomes.filter((o) => o.group === g && o.id === t.id).map((o) => (o.failed ? "FAILED" : o.reads.length ? o.reads.map((p) => p.split("/").at(-2)).join("+") : "NONE")).join(" | ");
  console.log(`  ${t.id.padEnd(12)} X0: ${fmt("X0").padEnd(36)} X1: ${fmt("X1")}`);
}
