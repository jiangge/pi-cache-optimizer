/**
 * Summarises a recording-proxy log per group. Unit of analysis is the session (label `<group>.<id>`), not the
 * request: requests inside a session are correlated. The first successful request of a session only writes the
 * cache and is excluded; warmer replays and failed requests are counted separately.
 */
import { readFileSync } from "node:fs";
import type { RecordedRequest } from "./proxy.ts";

const file = process.argv[2];
if (!file) { console.error("usage: analyze.ts <requests.jsonl>"); process.exit(1); }
const rows: RecordedRequest[] = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

type Session = { label: string; group: string; ratios: number[]; uncached: number[]; ceiling: number[]; hits: number; turns: number };
const failed = new Map<string, number>();
const sessions = new Map<string, Session>();
const byLabel = new Map<string, RecordedRequest[]>();
for (const r of rows) {
  const group = r.label.split(".")[0];
  if (r.status !== 200 || r.warmer || r.usage.promptTokens === undefined) { failed.set(group, (failed.get(group) ?? 0) + 1); continue; }
  byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r]);
}
for (const [label, list] of byLabel) {
  const s: Session = { label, group: label.split(".")[0], ratios: [], uncached: [], ceiling: [], hits: 0, turns: 0 };
  for (const r of list.slice(1)) {
    const prompt = r.usage.promptTokens!;
    const cached = r.usage.cachedTokens ?? 0;
    s.turns++;
    s.ratios.push(cached / prompt);
    s.uncached.push(prompt - cached);
    s.ceiling.push((r.lcpTokens ?? 0) / prompt);
    if (cached > 0) s.hits++;
  }
  if (s.turns) sessions.set(label, s);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : NaN; };
const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);

console.log("group  sessions  allMiss  allHit  meanRatio  sd(sessions)  meanUncached  ceiling  routeEff  failedReq");
for (const group of [...new Set([...sessions.values()].map((s) => s.group))].sort()) {
  const list = [...sessions.values()].filter((s) => s.group === group);
  const perSession = list.map((s) => mean(s.ratios));
  const ceilings = list.map((s) => mean(s.ceiling));
  const routeEff = mean(perSession) / mean(ceilings);
  console.log([
    group.padEnd(5), String(list.length).padStart(8),
    String(list.filter((s) => s.hits === 0).length).padStart(8), String(list.filter((s) => s.hits === s.turns).length).padStart(7),
    pct(mean(perSession)).padStart(10), pct(sd(perSession)).padStart(13),
    Math.round(mean(list.flatMap((s) => s.uncached))).toString().padStart(13), pct(mean(ceilings)).padStart(8), pct(routeEff).padStart(9),
    String(failed.get(group) ?? 0).padStart(10),
  ].join("  "));
}
console.log("\nper-session mean cache ratio (turns after the first):");
for (const s of [...sessions.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))) {
  console.log(`  ${s.label.padEnd(8)} ${s.ratios.map(pct).join("  ")}`);
}
