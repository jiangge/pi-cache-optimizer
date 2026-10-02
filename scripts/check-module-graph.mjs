// Fails on import cycles between src/ modules, or on a src/ module importing the entry file.
// The modules are layered (common/paths at the bottom, command at the top); a cycle would make load
// order matter for module-level constants and state.
import { readFileSync, readdirSync } from "node:fs";

const graph = {};
for (const file of readdirSync("src").filter((f) => f.endsWith(".ts"))) {
  const text = readFileSync(`src/${file}`, "utf8");
  if (/from "\.\.\/index(\.ts)?"/.test(text)) {
    console.error(`check-module-graph: src/${file} imports index.ts`);
    process.exit(1);
  }
  graph[file.slice(0, -3)] = [...text.matchAll(/from "\.\/([\w-]+)\.ts"/g)].map((match) => match[1]);
}
const cycles = new Set();
const visit = (node, path) => {
  if (path.includes(node)) { cycles.add([...path.slice(path.indexOf(node)), node].join(" -> ")); return; }
  for (const next of graph[node] ?? []) visit(next, [...path, node]);
};
for (const node of Object.keys(graph)) visit(node, []);
if (cycles.size) {
  console.error(`check-module-graph: import cycles\n  ${[...cycles].join("\n  ")}`);
  process.exit(1);
}
console.log(`check-module-graph: ${Object.keys(graph).length} src modules, no import cycles`);
