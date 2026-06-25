#!/usr/bin/env node
// Vendors agent-hooks slices from jfrog-agent-hooks into this plugin.
//
// Usage:
//   JFROG_AGENT_HOOKS_PATH=/path/to/jfrog-agent-hooks node .github/scripts/sync-agent-hooks.mjs
//
// Defaults JFROG_AGENT_HOOKS_PATH to ../jfrog-agent-hooks (sibling clone).
// Reads copy list from sync-agent-hooks-vendor.json.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const vendorPath = path.join(scriptDir, "sync-agent-hooks-vendor.json");

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyEntry(srcRoot, destRoot, entry) {
  const src = path.join(srcRoot, entry.src);
  const dest = path.join(destRoot, entry.dest);
  if (!(await fileExists(src))) {
    throw new Error(`missing upstream path: ${entry.src}`);
  }
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.cp(src, dest, { recursive: true });
  } else {
    await fs.copyFile(src, dest);
  }
  console.log(`  ${entry.src} -> ${path.relative(repoRoot, dest)}`);
}

async function main() {
  const vendor = JSON.parse(await fs.readFile(vendorPath, "utf8"));
  const copies = vendor.copies;
  if (!Array.isArray(copies) || copies.length === 0) {
    throw new Error(`${vendorPath} must define a non-empty copies array`);
  }

  const hooksRoot =
    process.env.JFROG_AGENT_HOOKS_PATH?.trim() ||
    path.resolve(repoRoot, "..", "jfrog-agent-hooks");

  if (!(await fileExists(hooksRoot))) {
    throw new Error(
      `jfrog-agent-hooks not found at ${hooksRoot}. Set JFROG_AGENT_HOOKS_PATH.`,
    );
  }

  console.log(`--- sync from ${hooksRoot} (pin: ${vendor.pin ?? "local"}) ---`);
  for (const entry of copies) {
    await copyEntry(hooksRoot, repoRoot, entry);
  }
  console.log("done.");
}

await main();
