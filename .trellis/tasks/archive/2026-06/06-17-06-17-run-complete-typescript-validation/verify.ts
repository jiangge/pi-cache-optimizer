// Verification script for task 06-17-run-complete-typescript-validation.
//
// Run from the repo root with:
//   bun .trellis/tasks/06-17-06-17-run-complete-typescript-validation/verify.ts
//
// This script intentionally shells out to the same validation commands used
// for release sanity checks and fails fast on any non-zero exit code.

import { spawnSync } from "node:child_process";

type Step = {
  name: string;
  command: string[];
};

const steps: Step[] = [
  { name: "TypeScript version", command: ["bunx", "tsc", "--version"] },
  { name: "TypeScript noEmit", command: ["bunx", "tsc", "--noEmit", "--pretty", "false"] },
  { name: "Whitespace diff check", command: ["git", "diff", "--check"] },
  { name: "Package dry run", command: ["npm", "pack", "--dry-run"] },
];

for (const step of steps) {
  console.log(`\n==> ${step.name}`);
  console.log(`$ ${step.command.join(" ")}`);
  const result = spawnSync(step.command[0], step.command.slice(1), {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(`\n❌ ${step.name} failed to start: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`\n❌ ${step.name} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\n✅ Complete TypeScript validation passed.");
