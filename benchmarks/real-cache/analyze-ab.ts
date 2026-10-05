/**
 * Per-group summary for the realistic workload. Hit/miss (routing) and "cached tokens given a hit" (prefix stability)
 * are reported separately because they have different noise: routing is random and treatment-independent, the
 * second is determined by the prompt prefix. Unit of analysis: session means; the first successful request of a
 * session is excluded (it can only write the cache).
 */
import { readFileSync } from "node:fs";
import type { RecordedRequest } from "./proxy.ts";

const file = process.argv[2];
if (!file) { console.error("usage: analyze-ab.ts <requests.jsonl>"); process.exit(1); }
const rows: RecordedRequest[] = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

type Obs = { prompt: number; cached: number; lcp: number };
const failed = new Map<string, number>();
const sessions = new Map<string, { group: string; obs: Obs[] }>();
const seen = new Set<string>();
for (const r of rows) {
  const group = r.label.split(".")[0];
  if (r.status !== 200 || r.warmer || r.usage.promptTokens === undefined) { failed.set(group, (failed.get(group) ?? 0) + 1); continue; }
  if (!seen.has(r.label)) { seen.add(r.label); continue; }
  const s = sessions.get(r.label) ?? { group, obs: [] };
  s.obs.push({ prompt: r.usage.promptTokens, cached: r.usage.cachedTokens ?? 0, lcp: r.lcpTokens ?? 0 });
  sessions.set(r.label, s);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : NaN; };
const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
const num = (x: number) => (Number.isNaN(x) ? "n/a" : Math.round(x).toString());

console.log("group sess  warmReq  hitRate  ceiling(LCP/prompt)  cached/prompt|hit  cached/LCP|hit  uncachedTok/req  uncachedTok|hit  sd(sess uncached)  failed");
for (const group of [...new Set([...sessions.values()].map((s) => s.group))].sort()) {
  const list = [...sessions.values()].filter((s) => s.group === group);
  const all = list.flatMap((s) => s.obs);
  const hits = all.filter((o) => o.cached > 0);
  console.log([
    group.padEnd(5), String(list.length).padStart(4), String(all.length).padStart(8), pct(hits.length / all.length).padStart(8),
    pct(mean(all.map((o) => o.lcp / o.prompt))).padStart(20), pct(mean(hits.map((o) => o.cached / o.prompt))).padStart(18),
    pct(mean(hits.map((o) => o.cached / Math.max(1, o.lcp)))).padStart(16), num(mean(all.map((o) => o.prompt - o.cached))).padStart(16),
    num(mean(hits.map((o) => o.prompt - o.cached))).padStart(16), num(sd(list.map((s) => mean(s.obs.map((o) => o.prompt - o.cached))))).padStart(18),
    String(failed.get(group) ?? 0).padStart(6),
  ].join("  "));
}
