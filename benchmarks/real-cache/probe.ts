/**
 * Step 1 of the real-provider cache study: is the channel measurable at all?
 * Sends ~10 strictly serial requests (raw + through Pi) via the recording proxy and reports whether the
 * provider returns a cached-token count and whether repeating a prompt actually hits the cache.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUT_DIR, loadProviderConfig, sleep } from "./lib.ts";
import { runPi, type PiGroup } from "./pi-run.ts";
import { startProxy, type RecordedRequest } from "./proxy.ts";

const PROVIDER = process.env.BENCH_PROVIDER || "xiaojimao";
const MODEL = process.env.BENCH_MODEL || "gpt-6-luna";
const GAP_MS = Number(process.env.BENCH_GAP_MS || 3000);

const config = loadProviderConfig(PROVIDER, MODEL);
const outDir = join(OUT_DIR, `probe-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
const proxy = await startProxy({ upstreamBase: config.baseUrl, minGapMs: GAP_MS, maxRequests: 24, outDir });

const filler = Array.from({ length: 260 }, (_, i) =>
  `Reference item ${i}: the archive keeps record ${i * 7 + 3} under heading ${(i * 13) % 97}, cross-linked to entry ${(i * 29) % 211}.`).join("\n");

async function rawChat(label: string, extra: { cacheKey?: string; affinity?: string }) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` };
  if (extra.affinity) { headers["x-session-affinity"] = extra.affinity; headers["x-client-request-id"] = extra.affinity; }
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: `You are a terse assistant.\n${filler}` },
      { role: "user", content: "Reply with the single word OK." },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128,
    ...(extra.cacheKey ? { prompt_cache_key: extra.cacheKey } : {}),
  };
  const res = await fetch(`http://127.0.0.1:${proxy.port}/${label}${new URL(config.baseUrl).pathname}/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

const key1 = `probe-key-${Date.now()}`;
const key2 = `probe-other-${Date.now()}`;
console.log("== raw requests (serial) ==");
for (const [label, extra] of [
  ["raw-1", { cacheKey: key1, affinity: key1 }],
  ["raw-1", { cacheKey: key1, affinity: key1 }],
  ["raw-1", { cacheKey: key1, affinity: key1 }],
  ["raw-1", { cacheKey: key1, affinity: key1 }],
  ["raw-1", {}],
  ["raw-1", { cacheKey: key2, affinity: key2 }],
] as const) {
  const status = await rawChat(label, extra);
  console.log(`${label} key=${extra.cacheKey ? "yes" : "none"} -> HTTP ${status}`);
}

console.log("== Pi runs (serial; same session twice per group) ==");
const cwd = mkdtempSync(join(tmpdir(), "bench-cwd-"));
const filePath = join(outDir, "append.txt");
writeFileSync(filePath, `Reference material (stable):\n${filler}`);
const groups: PiGroup[] = [
  { name: "A0", extension: false },
  { name: "A1", extension: true },
];
for (const group of groups) {
  const label = `pi-${group.name}`;
  const sessionId = `00000000-0000-4000-8000-${group.name === "A0" ? "000000000a00" : "000000000a01"}`;
  for (const prompt of ["Reply with the single word OK.", "Reply with the single word DONE."]) {
    const result = await runPi({ config, group, label, port: proxy.port, sessionId, prompt, cwd, appendSystemPromptFile: filePath });
    console.log(`${label} exit=${result.code} out=${JSON.stringify(result.stdout.trim().slice(0, 40))}${result.code ? ` stderr=${result.stderr.slice(0, 300)}` : ""}`);
    await sleep(GAP_MS);
  }
}
await proxy.close();
rmSync(cwd, { recursive: true, force: true });

const rows: RecordedRequest[] = readFileSync(proxy.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log("\n== recorded ==");
console.log("seq label    st warm prompt cached  lcp~  ratio ttft  cacheKey  affinity");
for (const r of rows) {
  const u = r.usage;
  const ratio = u.promptTokens && u.cachedTokens !== undefined ? (u.cachedTokens / u.promptTokens).toFixed(2) : "n/a";
  console.log([
    String(r.seq).padEnd(3), r.label.padEnd(8), String(r.status), r.warmer ? "Y" : "-", String(u.promptTokens ?? "?").padStart(6),
    String(u.cachedTokens ?? "n/a").padStart(6), String(r.lcpTokens ?? "?").padStart(5), String(ratio).padStart(5), String(r.ttftMs ?? "?").padStart(5),
    r.promptCacheKey ? "yes" : "no", Object.keys(r.affinityHeaders).join(",") || "-",
  ].join("  "));
}
const reportsField = rows.some((r) => r.usage.cachedField);
const repeatHits = rows.filter((r) => r.label === "raw-1").slice(1, 4).filter((r) => (r.usage.cachedTokens ?? 0) > 0).length;
console.log(`\nusage reports cached tokens: ${reportsField ? rows.find((r) => r.usage.cachedField)!.usage.cachedField : "NO"}`);
console.log(`raw repeats with key that hit cache: ${repeatHits}/3`);
console.log(`details: ${outDir} (proxy log: ${proxy.logFile})`);
