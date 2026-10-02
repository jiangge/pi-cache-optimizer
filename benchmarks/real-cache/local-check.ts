/**
 * Offline check of the realistic workload: no real provider is contacted. A mock upstream answers every request,
 * so this verifies (a) the Trellis workspace produces a churning session overview, (b) each treatment group changes
 * the outbound prompt as intended, and reports the deterministic prefix stability per group.
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, type ProviderConfig } from "./lib.ts";
import { runPi } from "./pi-run.ts";
import { startProxy, type RecordedRequest } from "./proxy.ts";
import { TURN_PROMPTS, WORKLOAD_GROUPS, mutateBetweenTurns, prepareBenchHome, prepareWorkspace } from "./workload.ts";

const TURNS = Number(process.env.BENCH_TURNS || 4);
const outDir = join(OUT_DIR, `local-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
process.env.BENCH_AGENTS_DIR = join(outDir, "agents");
process.env.BENCH_HOME = prepareBenchHome(outDir);

const upstream = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => { raw += d; });
  req.on("end", () => {
    const tokens = Math.round(raw.length / 4);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"DONE"},"finish_reason":"stop"}]}\n\n');
    res.write(`data: {"choices":[],"usage":{"prompt_tokens":${tokens},"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0}}}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const upstreamPort = (upstream.address() as { port: number }).port;

// Fake provider config: no real key, never leaves this machine.
const config: ProviderConfig = {
  provider: "mockprov", modelId: "mock-model", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: "mock",
  providerEntry: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, api: "openai-completions", apiKey: "mock", compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true } },
  modelEntry: { id: "mock-model", name: "mock", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
};
const proxy = await startProxy({ upstreamBase: config.baseUrl, minGapMs: 0, maxRequests: 500, outDir });

for (const group of WORKLOAD_GROUPS) {
  const ws = prepareWorkspace();
  const label = `${group.name}.s0`;
  for (let turn = 0; turn < TURNS; turn++) {
    const result = await runPi({
      config, group, label, port: proxy.port, sessionId: "00000000-0000-4000-8000-0000000000aa", prompt: TURN_PROMPTS[turn % TURN_PROMPTS.length],
      cwd: ws.dir, noTools: false, extensions: [ws.trellisExtension], thinking: "off",
    });
    if (result.code !== 0) console.log(`${label} turn ${turn} exit=${result.code} ${result.stderr.slice(0, 200)}`);
    mutateBetweenTurns(ws.dir, turn);
  }
  rmSync(ws.dir, { recursive: true, force: true });
}
await proxy.close();
upstream.close();

const rows: RecordedRequest[] = readFileSync(proxy.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log("group  reqs  promptChars  stability(LCP/prompt, turns>=2)  key  retentionParam  tools  systemChars");
for (const group of WORKLOAD_GROUPS) {
  const list = rows.filter((r) => r.label === `${group.name}.s0`);
  const warm = list.slice(1);
  const stability = warm.length ? warm.reduce((s, r) => s + (r.lcpTokens ?? 0) / (r.usage.promptTokens || 1), 0) / warm.length : NaN;
  const body = JSON.parse(readFileSync(join(outDir, list.at(-1)?.bodyFile ?? ""), "utf8"));
  const system = body.messages?.[0]?.content;
  console.log([group.name.padEnd(4), String(list.length).padStart(5), String(Math.round(list.reduce((s, r) => s + r.promptChars, 0) / Math.max(1, list.length))).padStart(11),
    `${(stability * 100).toFixed(1)}%`.padStart(12), body.prompt_cache_key ? "yes" : "no ", ("prompt_cache_retention" in body ? "yes" : "no ").padStart(10),
    String(body.tools?.length ?? 0).padStart(8), String(typeof system === "string" ? system.length : "?").padStart(10)].join("  "));
}
console.log(`log: ${proxy.logFile}`);
