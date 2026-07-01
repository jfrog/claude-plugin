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

const useColor =
  !process.env.NO_COLOR && (process.env.FORCE_COLOR === "1" || process.stdout.isTTY);

function paint(open, text, close = "\x1b[0m") {
  return useColor ? `${open}${text}${close}` : text;
}

const style = {
  bold: (text) => paint("\x1b[1m", text),
  dim: (text) => paint("\x1b[2m", text),
  title: (text) => paint("\x1b[1m\x1b[36m", text),
  success: (text) => paint("\x1b[32m", text),
  warn: (text) => paint("\x1b[33m", text),
  info: (text) => paint("\x1b[36m", text),
  label: (text) => paint("\x1b[2m", text),
  path: (text) => paint("\x1b[36m", text),
  url: (text) => paint("\x1b[34m", text),
  step: (text) => paint("\x1b[1m\x1b[35m", text),
  code: (text) => paint("\x1b[32m", text),
  error: (text) => paint("\x1b[1m\x1b[31m", text),
  divider: (text) => paint("\x1b[2m", text),
  bullet: (text) => paint("\x1b[33m", "•") + " " + text,
};

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
  if (msg) console.error(style.error(`${msg}\n`));
  console.log(`Usage:
  node scripts/install-beta.mjs [--repo-path PATH] [--dry-run]
  node scripts/install-beta.mjs --uninstall [--dry-run]

Options:
  --skip-cli   Only update settings.json (skip claude plugin marketplace/install)`);
  process.exit(code);
}

function shortPath(p) {
  return p.replace(homedir(), "~");
}

function fmtPath(p) {
  return style.path(shortPath(p));
}

function fmtLine(text) {
  if (text.startsWith("http://") || text.startsWith("https://")) return style.url(text);
  if (text.includes("→") || text.startsWith("~") || text.startsWith("/") || text.startsWith("claude "))
    return style.path(text);
  return text;
}

function blank() {
  console.log("");
}

function heading(title) {
  blank();
  console.log(style.bold(title));
  console.log(style.divider("─".repeat(Math.min(title.length, 72))));
}

function step(n, title, lines = []) {
  console.log(`  ${style.step(String(n))}. ${style.bold(title)}`);
  for (const line of lines) {
    console.log(`     ${fmtLine(line)}`);
  }
}

function bullet(lines) {
  for (const line of lines) {
    console.log(`  ${style.bullet(fmtLine(line))}`);
  }
}

function printInstallHeader({ dryRun }) {
  blank();
  if (dryRun) {
    console.log(style.warn("JFrog Claude Code beta — install preview (dry run)"));
  } else {
    console.log(style.success("✓ ") + style.title("JFrog Claude Code beta — installed"));
  }
}

function printInstallDetails({ repoPath, marketplace, key }) {
  blank();
  console.log(`  ${style.label("Plugin root")}   ${fmtPath(repoPath)}`);
  console.log(`  ${style.label("Marketplace")}   ${style.info(marketplace)}`);
  console.log(`  ${style.label("Plugin key")}    ${style.info(key)}`);
  console.log(`  ${style.label("Settings")}     ${fmtPath(SETTINGS)}`);
}

function printInstallActions({ dryRun, skipCli, repoPath, key, marketplace, settingsUpdated }) {
  heading(dryRun ? "Would run" : "What we did");

  if (skipCli) {
    bullet(["Skip Claude CLI (--skip-cli) — update settings.json only"]);
  } else {
    bullet([
      `claude plugin marketplace add ${shortPath(repoPath)}`,
      `claude plugin install ${key}`,
    ]);
  }

  bullet([
    `Enable ${key} in ${shortPath(SETTINGS)}`,
    `Back up and update ${shortPath(SETTINGS)}`,
    "Remove stale manual SessionStart hooks (legacy install-local.mjs)",
  ]);

  if (!dryRun && settingsUpdated) {
    blank();
    console.log(`  ${style.success("✓")} Settings updated and plugin enabled.`);
  }
}

function printNextSteps() {
  heading("What's next in Claude Code");

  step(1, "Reload plugins", [
    "Restart Claude Code, or run /reload-plugins",
  ]);

  step(2, "Start a new session", [
    "SessionStart hooks run when a new conversation begins",
  ]);

  step(3, "Confirm the plugin loaded", [
    "Run /plugin inside Claude Code",
    "Or from a shell: claude plugin list",
    'Look for "jfrog@jfrog-beta"',
  ]);

  step(4, "Try the skills", [
    "/jfrog",
    "/jfrog-package-safety-and-download",
    "/jfrog-setup-package-managers",
  ]);
}

function printOptionalConfig() {
  heading("Optional — route installs through Artifactory");

  console.log(`  ${style.label("Edit")} ${fmtPath(path.join(homedir(), ".jfrog", "agents-conf.json"))}:`);
  blank();
  console.log(`    ${style.code('{ "packageResolution": { "enabled": true } }')}`);
  blank();
  console.log(`  ${style.dim("Open a new session after changing this file.")}`);
}

function printTroubleshooting() {
  heading("If something goes wrong");

  bullet([
    "Ensure the Claude Code CLI is installed: claude --version",
    "If marketplace add fails, check that `claude` is on your PATH",
    "More detail: AGENT-PACKAGE-RESOLUTION-BETA.md in this repo",
  ]);
}

function printUninstallHeader({ dryRun }) {
  blank();
  if (dryRun) {
    console.log(style.warn("JFrog Claude Code beta — uninstall preview (dry run)"));
  } else {
    console.log(style.success("✓ ") + style.title("JFrog Claude Code beta — uninstalled"));
  }
}

function printUninstallDetails({ marketplace, key, cloneHint }) {
  blank();
  console.log(`  ${style.label("Plugin key")}    ${style.info(key)}`);
  console.log(`  ${style.label("Marketplace")}   ${style.info(marketplace)}`);
  console.log(`  ${style.label("Settings")}     ${fmtPath(SETTINGS)}`);

  heading("What we removed");
  bullet([
    `claude plugin uninstall ${key}`,
    `claude plugin marketplace remove ${marketplace}`,
    `Plugin cache under ${shortPath(path.join(PLUGINS_DIR, "cache", marketplace))}`,
    `Enabled plugin entry from ${shortPath(SETTINGS)}`,
    "Legacy manual SessionStart hooks (if present)",
  ]);

  heading("What's next in Claude Code");
  step(1, "Reload plugins", ["Restart Claude Code, or run /reload-plugins"]);

  if (cloneHint) {
    heading("Optional cleanup");
    console.log(`  ${style.dim("Remove the cloned repo if you no longer need it:")}`);
    console.log(`  ${style.code(`rm -rf ${shortPath(cloneHint)}`)}`);
  }
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
  if (dryRun) return dst;
  await writeFile(dst, await readFile(file, "utf8"));
  console.log(`  ${style.dim("Backup")} ${fmtPath(dst)}`);
  return dst;
}

async function writeJson(file, data, dryRun) {
  const text = JSON.stringify(data, null, 2) + "\n";
  if (dryRun) return;
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
  if (dryRun) return { status: 0, stdout: "", stderr: "" };
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

async function removePluginCache(marketplace, dryRun) {
  const cacheDir = path.join(PLUGINS_DIR, "cache", marketplace);
  if (!(await exists(cacheDir))) return false;
  if (dryRun) return true;
  await rm(cacheDir, { recursive: true, force: true });
  console.log(`  ${style.success("✓")} Removed cache ${fmtPath(cacheDir)}`);
  return true;
}

async function cmdUninstall(o, cfg, marketplace, key) {
  printUninstallHeader({ dryRun: o.dryRun });

  if (!o.skipCli) {
    runClaude(["plugin", "uninstall", key, "-y"], o.dryRun);
    runClaude(["plugin", "marketplace", "remove", marketplace], o.dryRun);
  }

  await removePluginCache(marketplace, o.dryRun);

  const settingsChanged = removePluginKeys(cfg.enabledPlugins) || stripManualSessionStart(cfg);
  if (settingsChanged || !o.dryRun) {
    await backup(SETTINGS, o.dryRun);
    await writeJson(SETTINGS, cfg, o.dryRun);
  }

  const cloneHint = (await exists(o.repoPath)) ? o.repoPath : DEFAULT_CLONE;
  printUninstallDetails({
    marketplace,
    key,
    cloneHint: (await exists(cloneHint)) ? cloneHint : null,
  });
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

  if (o.uninstall) {
    await cmdUninstall(o, cfg, marketplace, key);
    return;
  }

  printInstallHeader({ dryRun: o.dryRun });
  printInstallDetails({ repoPath: o.repoPath, marketplace, key });

  if (!o.skipCli) {
    const add = runClaude(["plugin", "marketplace", "add", o.repoPath], o.dryRun);
    if (add.status !== 0 && !o.dryRun) {
      throw new Error("claude plugin marketplace add failed (is `claude` on PATH?)");
    }

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

  printInstallActions({
    dryRun: o.dryRun,
    skipCli: o.skipCli,
    repoPath: o.repoPath,
    key,
    marketplace,
    settingsUpdated: true,
  });

  printNextSteps();
  printOptionalConfig();
  if (!o.dryRun) {
    printTroubleshooting();
  } else {
    blank();
    console.log(`  ${style.info("Re-run without --dry-run to install for real.")}`);
  }
}

main().catch((err) => {
  console.error(`\n${style.error("Install failed:")} ${err?.message ?? err}`);
  process.exit(1);
});
