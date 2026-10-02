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
if (missing.length) {
  console.error(`check-pack: ${missing.length} problem(s)\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-pack: ${packed.size} files packed; every relative import in ${sources.length} source files resolves inside the tarball`);
