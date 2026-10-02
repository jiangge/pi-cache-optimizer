import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { BENCH_DIR } from "./lib.ts";
import type { PiGroup } from "./pi-run.ts";

const REPO_ROOT = join(BENCH_DIR, "..", "..");

const noAffinity = { sendSessionAffinityHeaders: false };
export const PREFIX = "PI_CACHE_OPTIMIZER_";

/** Treatment groups for the realistic (Trellis workspace) workload. Every group loads the workspace's own Trellis extension. */
export const WORKLOAD_GROUPS: PiGroup[] = [
  { name: "G0", extension: false },
  { name: "G1", extension: true },
  { name: "G1b", extension: true }, // A/A replicate of G1
  { name: "G2", extension: true, env: { [`${PREFIX}NO_PROMPT_REWRITE`]: "1" } },
  // Core only, but with the long-retention request the extension makes process-wide: isolates key/retention from prompt edits.
  { name: "G0L", extension: false, env: { PI_CACHE_RETENTION: "long" } },
  { name: "G5", extension: true, env: { [`${PREFIX}TOOL_ORDER`]: "1" } },
  { name: "G0n", extension: false, compat: noAffinity },
];

/**
 * Pi also discovers skills under $HOME/.agents/skills. Use a private HOME holding a snapshot of the user's skills
 * (SKILL.md only) so runs are reproducible, never read the real home, and the prompt keeps its realistic size.
 */
export function prepareBenchHome(outDir: string): string {
  const home = join(outDir, "home");
  const source = join(homedir(), ".agents", "skills");
  if (existsSync(source)) {
    for (const file of execFileSync("find", [source, "-name", "SKILL.md"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
      const target = join(home, ".agents", "skills", relative(source, file));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
    }
  }
  mkdirSync(home, { recursive: true });
  return home;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Clones this repo (committed HEAD) into a temp dir so each session has a real Trellis workspace: AGENTS.md,
 * project skills, the Trellis extension and the real get_context.py session overview. The user's checkout is never touched.
 */
export function prepareWorkspace(): { dir: string; trellisExtension: string } {
  const dir = mkdtempSync(join(tmpdir(), "bench-ws-"));
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", REPO_ROOT, dir]);
  git(dir, "config", "user.email", "bench@example.invalid");
  git(dir, "config", "user.name", "bench");
  const developer = join(REPO_ROOT, ".trellis", ".developer");
  if (existsSync(developer)) copyFileSync(developer, join(dir, ".trellis", ".developer"));
  mkdirSync(join(dir, "scratch"), { recursive: true });
  return { dir, trellisExtension: join(dir, ".pi", "extensions", "trellis", "index.ts") };
}

/**
 * Between two user turns, change what the session overview reports: the git status every turn and the recent
 * commit list every other turn. This is the churn the optimizer's prompt rewrite is meant to neutralise.
 */
export function mutateBetweenTurns(dir: string, turn: number): void {
  appendFileSync(join(dir, "scratch", "notes.md"), `turn ${turn} note ${Date.now()}\n`);
  if (turn % 2 === 1) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `bench: step ${turn}`);
  }
}

/** Cheap, tool-using turns: the second request of a turn replays the first plus a tool result. */
export const TURN_PROMPTS = [
  "Use the read tool to read the first 5 lines of README.md, then reply with the single word DONE.",
  "Use the read tool to read the first 5 lines of package.json, then reply with the single word DONE.",
  "Use the read tool to read the first 5 lines of AGENTS.md, then reply with the single word DONE.",
  "Use the read tool to read the first 5 lines of tsconfig.json, then reply with the single word DONE.",
  "Use the read tool to read the first 5 lines of LICENSE, then reply with the single word DONE.",
  "Reply with the single word FINISHED without using any tool.",
];
