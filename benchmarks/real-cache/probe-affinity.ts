/**
 * Step 1b: isolate prompt_cache_key from session-affinity headers. Four Pi runs (2 requests each group), serial:
 *   A0n = Pi core, no affinity headers, no key        A1n = extension (key fallback), no affinity headers
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
const outDir = join(OUT_DIR, `probe-affinity-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outDir, { recursive: true });
const proxy = await startProxy({ upstreamBase: config.baseUrl, minGapMs: GAP_MS, maxRequests: 12, outDir });

const filler = Array.from({ length: 260 }, (_, i) =>
  `Reference item ${i}: the archive keeps record ${i * 7 + 3} under heading ${(i * 13) % 97}, cross-linked to entry ${(i * 29) % 211}.`).join("\n");
const cwd = mkdtempSync(join(tmpdir(), "bench-cwd-"));
const filePath = join(outDir, "append.txt");
writeFileSync(filePath, `Reference material (stable):\n${filler}`);

const noAffinity = { sendSessionAffinityHeaders: false };
const groups: PiGroup[] = [
  { name: "A0n", extension: false, compat: noAffinity },
  { name: "A1n", extension: true, compat: noAffinity },
];
for (const group of groups) {
  const label = `pi-${group.name}`;
  const sessionId = `00000000-0000-4000-8000-${group.name === "A0n" ? "000000000b00" : "000000000b01"}`;
  for (const prompt of ["Reply with the single word OK.", "Reply with the single word DONE."]) {
    const result = await runPi({ config, group, label, port: proxy.port, sessionId, prompt, cwd, appendSystemPromptFile: filePath });
    console.log(`${label} exit=${result.code}${result.code ? ` stderr=${result.stderr.slice(0, 300)}` : ""}`);
    await sleep(GAP_MS);
  }
}
await proxy.close();
rmSync(cwd, { recursive: true, force: true });
const rows: RecordedRequest[] = readFileSync(proxy.logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
console.log("seq label    st prompt cached  lcp~  cacheKey  affinity");
for (const r of rows) {
  console.log([String(r.seq).padEnd(3), r.label.padEnd(8), r.status, String(r.usage.promptTokens ?? "?").padStart(6),
    String(r.usage.cachedTokens ?? "n/a").padStart(6), String(r.lcpTokens ?? "?").padStart(5), r.promptCacheKey ? "yes" : "no", Object.keys(r.affinityHeaders).join(",") || "-"].join("  "));
}
