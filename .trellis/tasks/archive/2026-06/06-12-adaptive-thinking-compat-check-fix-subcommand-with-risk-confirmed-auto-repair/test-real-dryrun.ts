#!/usr/bin/env bun
/** Dry-run against the user's REAL models.json (read-only, no writes). */
import { readFileSync } from "fs";
import { homedir } from "os";
import { __internals_for_tests } from "../../../index.ts";

const { locateModelInJsonc, composeFixInsertion, selfCheckFix, decideFixPlacement, stripJsoncComments } = __internals_for_tests as any;

const text = readFileSync(`${homedir()}/.pi/agent/models.json`, "utf8");
const parsed = JSON.parse(stripJsoncComments(text));

console.log("=== Dry-run on real ~/.pi/agent/models.json (READ-ONLY) ===\n");

for (const [providerLabel, prov] of Object.entries<any>(parsed.providers ?? {})) {
  const models = Array.isArray(prov?.models) ? prov.models : [];
  for (const m of models) {
    if (!m?.id) continue;
    // Only test adaptive-generation candidates on anthropic-ish channels
    const idLower = String(m.id).toLowerCase();
    const isCandidate = /opus-4[.-][6-9]|sonnet-4[.-][6-9]|fable-[5-9]/.test(idLower);
    if (!isCandidate) continue;

    const merged = { ...(prov.compat ?? {}), ...(m.compat ?? {}) };
    const hasFlag = merged.forceAdaptiveThinking === true;
    console.log(`${providerLabel}/${m.id}`);
    console.log(`  forceAdaptiveThinking effective: ${hasFlag}`);
    if (hasFlag) { console.log(""); continue; }

    const loc = locateModelInJsonc(text, providerLabel, m.id);
    if (!loc) { console.log("  ❌ scanner could not locate\n"); continue; }
    const keys = { forceAdaptiveThinking: true };
    const d = decideFixPlacement(keys, providerLabel, loc.allModelIds);
    console.log(`  siblings: [${loc.allModelIds.join(", ")}]`);
    console.log(`  → auto placement: ${d.placement} (${d.reason})`);
    const out = composeFixInsertion(text, loc, keys, d.placement);
    const err = selfCheckFix(text, out, providerLabel, m.id, keys);
    console.log(`  → selfCheckFix: ${err === null ? "✅ pass" : "❌ " + err}`);
    // Show the inserted diff region (first changed line span)
    const oLines = text.split("\n");
    const nLines = out.split("\n");
    let i = 0;
    while (i < oLines.length && oLines[i] === nLines[i]) i++;
    console.log(`  → inserted near line ${i + 1}:`);
    nLines.slice(i, i + (nLines.length - oLines.length) + 1).forEach((l: string) => console.log(`      ${l}`));
    console.log("");
  }
}
console.log("(no file was written)");
