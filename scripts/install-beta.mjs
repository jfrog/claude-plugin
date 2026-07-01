#!/usr/bin/env node
// Register and install the JFrog beta plugin via Claude Code's marketplace flow.
//
// Usage:
//   node scripts/install-beta.mjs
//   node scripts/install-beta.mjs --repo-path /path/to/claude-plugin
//   node scripts/install-beta.mjs --uninstall
//
// Requires `claude` on PATH (Claude Code CLI). Sets enabledPlugins["jfrog@jfrog-beta"].
// Removes stale manual package-resolution hooks from jfrog-agent-hooks install-local.mjs.

import { readFile, writeFile, mkdir, access, rm } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(HERE, "..");
const SETTINGS = path.join(homedir(), ".claude", "settings.json");
const PLUGIN_NAME = "jfrog";
const DEFAULT_CLONE = path.join(homedir(), ".jfrog", "claude-plugin-beta");
const PLUGINS_DIR = path.join(homedir(), ".claude", "plugins");

const DEFAULT_MARKETPLACE = "jfrog-beta";

// Legacy install-beta wrote absolute paths — remove on uninstall too.
function isJfrogPluginKey(key) {
  return key === PLUGIN_NAME || key.startsWith(`${PLUGIN_NAME}@`);
}

const MANUAL_HOOK_MARKERS = [
  "cursor-session-start.mjs",
  "claude-session-start.mjs",
  "package-resolution/scripts",
  "modules/",
];

function parseArgs(argv) {
  const o = { repoPath: DEFAULT_REPO, uninstall: false, dryRun: false, skipCli: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo-path") o.repoPath = path.resolve(argv[++i] ?? "");
    else if (a === "--uninstall") o.uninstall = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--skip-cli") o.skipCli = true;
    else if (a === "-h" || a === "--help") printUsage(0);
    else printUsage(2, `Unknown argument: ${a}`);
  }
  return o;
}

function printUsage(code, msg) {
  if (msg) console.error(msg + "\n");
  console.log(`Usage:
  node scripts/install-beta.mjs [--repo-path PATH] [--dry-run]
  node scripts/install-beta.mjs --uninstall [--dry-run]

Options:
  --skip-cli   Only update settings.json (skip claude plugin marketplace/install)`);
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

async function readMarketplaceName(repoPath) {
  const marketplacePath = path.join(repoPath, ".claude-plugin", "marketplace.json");
  const data = await readJson(marketplacePath, null);
  if (data?.name && typeof data.name === "string") return data.name;
  return DEFAULT_MARKETPLACE;
}

function pluginKey(marketplace) {
  return `${PLUGIN_NAME}@${marketplace}`;
}

function runClaude(args, dryRun) {
  const cmd = ["claude", ...args].join(" ");
  if (dryRun) {
    console.log(`  [dry-run] ${cmd}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  const result = spawnSync("claude", args, { encoding: "utf8" });
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  if (out.trim()) process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  return result;
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
    if (isJfrogPluginKey(key)) {
      delete enabledPlugins[key];
      changed = true;
    }
  }
  return changed;
}

function shortPath(p) {
  return p.replace(homedir(), "~");
}

async function removePluginCache(marketplace, dryRun) {
  const cacheDir = path.join(PLUGINS_DIR, "cache", marketplace);
  if (!(await exists(cacheDir))) return false;
  if (dryRun) {
    console.log(`  [dry-run] rm -rf ${shortPath(cacheDir)}`);
    return true;
  }
  await rm(cacheDir, { recursive: true, force: true });
  console.log(`  removed cache: ${shortPath(cacheDir)}`);
  return true;
}

async function cmdUninstall(o, cfg, marketplace, key) {
  if (!o.skipCli) {
    console.log("\nclaude plugin uninstall …");
    runClaude(["plugin", "uninstall", key, "-y"], o.dryRun);

    console.log("claude plugin marketplace remove …");
    runClaude(["plugin", "marketplace", "remove", marketplace], o.dryRun);
  }

  console.log("plugin cache …");
  await removePluginCache(marketplace, o.dryRun);

  const settingsChanged = removePluginKeys(cfg.enabledPlugins) || stripManualSessionStart(cfg);
  if (settingsChanged || !o.dryRun) {
    await backup(SETTINGS, o.dryRun);
    await writeJson(SETTINGS, cfg, o.dryRun);
  }

  console.log("\nuninstalled jfrog beta plugin, marketplace, and cache.");
  console.log("restart Claude Code or run /reload-plugins.");

  const cloneHint = (await exists(o.repoPath)) ? o.repoPath : DEFAULT_CLONE;
  if (await exists(cloneHint)) {
    console.log(`\noptional — remove the cloned repo:\n  rm -rf ${shortPath(cloneHint)}`);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const manifest = path.join(o.repoPath, ".claude-plugin", "plugin.json");
  const marketplaceFile = path.join(o.repoPath, ".claude-plugin", "marketplace.json");

  if (o.uninstall) {
    if (!(await exists(manifest)) && o.repoPath === DEFAULT_REPO) {
      o.repoPath = (await exists(DEFAULT_CLONE)) ? DEFAULT_CLONE : o.repoPath;
    }
  } else {
    if (!(await exists(manifest))) {
      throw new Error(`not a Claude plugin root (missing ${manifest})`);
    }
    if (!(await exists(marketplaceFile))) {
      throw new Error(
        `missing ${marketplaceFile} — pull latest feature/package-resolution or main with marketplace manifest`,
      );
    }
  }

  const marketplace = (await exists(marketplaceFile))
    ? await readMarketplaceName(o.repoPath)
    : DEFAULT_MARKETPLACE;
  const key = pluginKey(marketplace);
  const cfg = (await readJson(SETTINGS, {})) ?? {};
  cfg.enabledPlugins ??= {};

  console.log(`plugin root:  ${o.repoPath}`);
  console.log(`marketplace:  ${marketplace}`);
  console.log(`plugin key:   ${key}`);
  console.log(`settings:     ${SETTINGS}`);

  if (o.uninstall) {
    await cmdUninstall(o, cfg, marketplace, key);
    return;
  }

  if (!o.skipCli) {
    console.log("\nclaude plugin marketplace add …");
    const add = runClaude(["plugin", "marketplace", "add", o.repoPath], o.dryRun);
    if (add.status !== 0 && !o.dryRun) {
      throw new Error("claude plugin marketplace add failed (is `claude` on PATH?)");
    }

    console.log("claude plugin install …");
    const inst = runClaude(["plugin", "install", key], o.dryRun);
    if (inst.status !== 0 && !o.dryRun) {
      throw new Error(`claude plugin install ${key} failed`);
    }
  }

  removePluginKeys(cfg.enabledPlugins);
  cfg.enabledPlugins[key] = true;
  stripManualSessionStart(cfg);

  await backup(SETTINGS, o.dryRun);
  await writeJson(SETTINGS, cfg, o.dryRun);

  console.log(`\nenabled: ${key}`);
  console.log("next: restart Claude Code or run /reload-plugins, then start a new session.");
  console.log("verify:  claude plugin list   or   /plugin inside Claude Code");
  console.log("skills:  /jfrog, /jfrog-package-safety-and-download, /jfrog-setup-package-managers");
  console.log("enable Agent Package Resolution: set packageResolution.enabled to true in ~/.jfrog/agents-conf.json");
}

main().catch((err) => {
  console.error(`install-beta failed: ${err?.message ?? err}`);
  process.exit(1);
});
