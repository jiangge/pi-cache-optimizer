// Fails when a relative import of the published extension is missing from the npm tarball.
// Pi loads the extension straight from the installed package with jiti, so a source file left out of
// package.json "files" breaks every install while all local checks (which run from the repo) still pass.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--cache", "node_modules/.cache/npm"], { encoding: "utf8" });
const packed = new Set(JSON.parse(out)[0].files.map((file) => normalize(file.path)));

const sources = ["index.ts", ...readdirSync("src", { recursive: true }).filter((f) => String(f).endsWith(".ts")).map((f) => join("src", String(f)))];
const missing = [];
for (const file of sources) {
  if (!packed.has(normalize(file))) missing.push(`${file} (source file not packed)`);
  for (const match of readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
    const target = normalize(join(dirname(file), match[1]));
    const candidates = [target, `${target}.ts`, join(target, "index.ts")];
    if (!candidates.some((candidate) => packed.has(candidate))) missing.push(`${file} imports ${match[1]}, which is not in the tarball`);
  }
}
// Pi 1.5+ shows a package's CHANGELOG.md after an update: every entry newer than the last version it recorded, read
// with Pi's parseChangelog rule (a line starting with "## ", then /##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/). So the first entry
// must be this version (its x.y.z core, which is all Pi reads), and versions must strictly descend: a stray or mistyped
// heading above it would be shown to every user.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const versionCore = String(version).match(/^(\d+\.\d+\.\d+)/)?.[1];
if (!packed.has("CHANGELOG.md")) missing.push("CHANGELOG.md (not packed; Pi shows it as the extension's update notes)");
else {
  const entries = [];
  for (const line of readFileSync("CHANGELOG.md", "utf8").split("\n")) {
    if (!line.startsWith("## ")) continue;
    const m = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
    if (m) entries.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  const label = (v) => v.join(".");
  if (entries.length === 0 || label(entries[0]) !== versionCore) {
    missing.push(`CHANGELOG.md must start with an entry for ${versionCore} (first entry: ${entries[0] ? label(entries[0]) : "none"})`);
  }
  for (let i = 1; i < entries.length; i++) {
    const [a, b] = [entries[i - 1], entries[i]];
    const descending = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
    if (!descending) missing.push(`CHANGELOG.md entries must strictly descend (${label(a)} is followed by ${label(b)})`);
  }
}
if (missing.length) {
  console.error(`check-pack: ${missing.length} problem(s)\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-pack: ${packed.size} files packed; every relative import in ${sources.length} source files resolves inside the tarball; CHANGELOG.md leads with ${version}`);
