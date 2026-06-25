#!/usr/bin/env node
// Enable this plugin clone in Claude Code (~/.claude/settings.json).
//
// Usage:
//   node scripts/install-beta.mjs
//   node scripts/install-beta.mjs --repo-path /path/to/claude-plugin
//   node scripts/install-beta.mjs --uninstall
//
// Sets enabledPlugins["jfrog@<absolute-plugin-path>"] = true.
// Removes stale manual package-guard hooks from jfrog-agent-hooks install-local.mjs.
// Does not remove boost or other third-party hooks.

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, "..");
const SETTINGS = path.join(homedir(), ".claude", "settings.json");
const PLUGIN_NAME = "jfrog";

const MANUAL_HOOK_MARKERS = [
  "cursor-session-start.mjs",
  "claude-session-start.mjs",
  "package-guard/adapters",
  "package-guard/hooks",
  "package-guard/scripts",
];

function parseArgs(argv) {
  const o = { repoPath: DEFAULT_REPO, uninstall: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo-path") o.repoPath = path.resolve(argv[++i] ?? "");
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "-h" || a === "--help") {
      printUsage(0);
    } else {
      printUsage(2, `Unknown argument: ${a}`);
    }
  }
  return o;
}

function printUsage(code, msg) {
  if (msg) console.error(msg + "\n");
  console.log(`Usage:
  node scripts/install-beta.mjs [--repo-path PATH] [--dry-run]
  node scripts/install-beta.mjs --uninstall [--dry-run]`);
  process.exit(code);
}

async function exists(p) {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function backup(file, dryRun) {
  if (!(await exists(file))) return null;
  const dst = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (dryRun) {
    console.log(`  [dry-run] backup ${file} -> ${dst}`);
    return dst;
  }
  await writeFile(dst, await readFile(file, "utf8"));
  console.log(`  backup: ${dst}`);
  return dst;
}

async function writeJson(file, data, dryRun) {
  const text = JSON.stringify(data, null, 2) + "\n";
  if (dryRun) {
    console.log(`  [dry-run] write ${file}`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

function pluginKey(repoPath) {
  return `${PLUGIN_NAME}@${repoPath}`;
}

function isManualHook(entry) {
  if (typeof entry?.command !== "string") return false;
  return MANUAL_HOOK_MARKERS.some((m) => entry.command.includes(m));
}

function stripManualSessionStart(cfg) {
  if (!cfg.hooks?.SessionStart) return false;
  const groups = cfg.hooks.SessionStart;
  const filtered = groups.filter((g) => !(g?.hooks ?? []).some(isManualHook));
  if (filtered.length === groups.length) return false;
  if (filtered.length === 0) delete cfg.hooks.SessionStart;
  else cfg.hooks.SessionStart = filtered;
  return true;
}

function removePluginKeys(enabledPlugins) {
  let changed = false;
  for (const key of Object.keys(enabledPlugins)) {
    if (key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`)) {
      delete enabledPlugins[key];
      changed = true;
    }
  }
  return changed;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const manifest = path.join(o.repoPath, ".claude-plugin", "plugin.json");
  if (!(await exists(manifest))) {
    throw new Error(`not a Claude plugin root (missing ${manifest})`);
  }

  const cfg = (await readJson(SETTINGS, {})) ?? {};
  cfg.enabledPlugins ??= {};

  console.log(`plugin root: ${o.repoPath}`);
  console.log(`settings:    ${SETTINGS}`);

  if (o.uninstall) {
    const a = removePluginKeys(cfg.enabledPlugins);
    const b = stripManualSessionStart(cfg);
    if (!a && !b) {
      console.log("nothing to remove.");
      return;
    }
    await backup(SETTINGS, o.dryRun);
    await writeJson(SETTINGS, cfg, o.dryRun);
    console.log("uninstalled beta plugin entry and manual package-guard hooks.");
    return;
  }

  const key = pluginKey(o.repoPath);
  removePluginKeys(cfg.enabledPlugins);
  cfg.enabledPlugins[key] = true;
  stripManualSessionStart(cfg);

  await backup(SETTINGS, o.dryRun);
  await writeJson(SETTINGS, cfg, o.dryRun);
  console.log(`enabled: ${key}`);
  console.log("next: restart Claude Code or run /reload-plugins, then start a new session.");
  console.log("enable package-guard: set packageGuard.enabled to true in ~/.jfrog/agents.json");
}

main().catch((err) => {
  console.error(`install-beta failed: ${err?.stack ?? err}`);
  process.exit(1);
});
