import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, OUT_DIR, type ProviderConfig } from "./lib.ts";

export type PiGroup = {
  name: string;
  /** Load this repo's extension (false = Pi core only). */
  extension: boolean;
  /** Extra environment, e.g. PI_CACHE_OPTIMIZER_NO_PROMPT_REWRITE=1. */
  env?: Record<string, string>;
  /** Overrides merged into the provider's `compat`, e.g. { sendSessionAffinityHeaders: false }. */
  compat?: Record<string, unknown>;
};

const EXTENSION_PATH = join(BENCH_DIR, "..", "..", "index.ts");
// Pinned to the repo's devDependency copy of Pi: the global `pi` shim resolves per working directory and fails inside workspace clones.
const PI_CLI = join(BENCH_DIR, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

/**
 * Creates an isolated agent dir for one run: only the benchmarked provider/model, with its base URL pointed at the
 * recording proxy under `label`. No persisted extension config, no global skills or AGENTS.md, so environment
 * variables are the only feature switches.
 */
export function prepareAgentDir(config: ProviderConfig, group: PiGroup, label: string, port: number): string {
  const dir = join(process.env.BENCH_AGENTS_DIR || join(OUT_DIR, "agents"), label);
  mkdirSync(dir, { recursive: true });
  const provider = {
    ...config.providerEntry,
    compat: { ...((config.providerEntry.compat as Record<string, unknown> | undefined) ?? {}), ...group.compat },
    baseUrl: `http://127.0.0.1:${port}/${encodeURIComponent(label)}${new URL(config.baseUrl).pathname.replace(/\/+$/, "")}`,
    models: [config.modelEntry],
  };
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { [config.provider]: provider } }, null, 2), { mode: 0o600 });
  return dir;
}

export function runPi(options: {
  config: ProviderConfig;
  group: PiGroup;
  label: string;
  port: number;
  sessionId: string;
  prompt: string;
  cwd: string;
  thinking?: string;
  appendSystemPromptFile?: string;
  noTools?: boolean;
  /** Extra extension files loaded with -e (e.g. the workspace's own Trellis extension). */
  extensions?: string[];
  timeoutMs?: number;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const agentDir = prepareAgentDir(options.config, options.group, options.label, options.port);
  const args = [
    "-p",
    "--no-extensions",
    ...(options.extensions ?? []).flatMap((path) => ["-e", path]),
    ...(options.group.extension ? ["-e", EXTENSION_PATH] : []),
    "--provider", options.config.provider,
    "--model", options.config.modelId,
    "--session-id", options.sessionId,
    "--session-dir", join(agentDir, "sessions"),
    "--thinking", options.thinking || "low",
    ...(options.noTools === false ? [] : ["--no-tools"]),
    ...(options.appendSystemPromptFile ? ["--append-system-prompt", options.appendSystemPromptFile] : []),
    options.prompt,
  ];
  const env: Record<string, string | undefined> = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  // Clear inherited retention first; a group may request it explicitly below.
  delete env.PI_CACHE_RETENTION;
  Object.assign(env, options.group.env);
  if (process.env.BENCH_HOME) env.HOME = process.env.BENCH_HOME;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PI_CLI, ...args], { cwd: options.cwd, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 300_000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
