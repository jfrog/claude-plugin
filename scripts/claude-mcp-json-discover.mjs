// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Claude-specific discovery of installed-plugin .mcp.json paths and Agent Guard
// --allow-root directories. Harness entry lives in claude-align-mcp-json.mjs;
// shared rewrite orchestration lives in modules/core/rewrite-mcp-json.mjs.
//
// Discovery ports Agent Guard align_plugin_mcps.go:
//   1. Live marketplace string-source .mcp.json (prefer when present)
//   2. installPath/.mcp.json from installed_plugins.json
//
// Override roots: JF_ALIGN_MCP_JSON_ROOTS=/path/a:/path/b
//   (POSIX: colon/comma; Windows: semicolon/comma — avoids splitting C:\…)
// Claude config root: CLAUDE_CONFIG_DIR (default ~/.claude)

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * OS-delimiter- or comma-separated absolute plugin roots; skips default
 * discovery. POSIX uses `:` / `,`; Windows uses `;` / `,` (not `:` — that
 * would split drive letters like `C:\…`).
 */
export const ROOTS_ENV = "JF_ALIGN_MCP_JSON_ROOTS";
/** Claude Code config root override. Default: `~/.claude`. */
export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/**
 * Plugin root is the parent of `scripts/` (where this file lives).
 * @param {string} [moduleUrl] — import.meta.url of a scripts/*.mjs module
 */
export function resolvePluginRoot(moduleUrl = import.meta.url) {
  const scriptsDir = path.dirname(fileURLToPath(moduleUrl));
  return path.dirname(scriptsDir);
}

/**
 * @param {string} raw
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function parseRootsEnv(raw, platform = process.platform) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const sep = platform === "win32" ? /[;,]/ : /[:,]/;
  return raw
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Claude config root: `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`.
 * @param {{
 *   home?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {string}
 */
export function resolveClaudeConfigDir(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const fromEnv =
    typeof env[CLAUDE_CONFIG_DIR_ENV] === "string"
      ? env[CLAUDE_CONFIG_DIR_ENV].trim()
      : "";
  return fromEnv || path.join(home, ".claude");
}

/**
 * FileChanged watch targets for plugin install metadata.
 * @param {{
 *   home?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {string[]}
 */
export function resolveAlignWatchPaths(opts = {}) {
  const pluginsDir = path.join(resolveClaudeConfigDir(opts), "plugins");
  return [
    path.join(pluginsDir, "installed_plugins.json"),
    path.join(pluginsDir, "known_marketplaces.json"),
  ];
}

/**
 * SessionStart stdout so Claude registers FileChanged watches for plugin
 * install metadata. Owned by `claude-register-align-watch-paths.mjs` (not the
 * slower align/rewrite hook).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function buildSessionStartWatchPayload(env = process.env) {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      watchPaths: resolveAlignWatchPaths({ env }),
    },
  })}\n`;
}

/**
 * Kill switch shared with `modules/core/rewrite-mcp-json.mjs` (`DISABLE_ENV`).
 * Duplicated here so the fast watch-paths hook does not import the rewrite
 * orchestration module graph.
 */
export const REWRITE_DISABLE_ENV = "JF_AGENT_REWRITE_MCP_JSON_DISABLE";

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isAlignRewriteDisabled(env = process.env) {
  return env[REWRITE_DISABLE_ENV] === "1";
}

/**
 * Expand `~` and resolve relative paths against the Claude config dir.
 * @param {string} p
 * @param {string} claudeConfigDir
 * @param {{ home?: string }} [opts]
 * @returns {string}
 */
export function normalizeClaudePath(p, claudeConfigDir, opts = {}) {
  const home = opts.home ?? homedir();
  let raw = typeof p === "string" ? p.trim() : "";
  if (!raw) return "";
  if (raw === "~") {
    raw = home;
  } else if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    raw = path.join(home, raw.slice(2));
  }
  if (!path.isAbsolute(raw)) {
    raw = path.join(claudeConfigDir, raw);
  }
  return path.resolve(raw);
}

/**
 * @param {string} target
 * @param {string} dir
 * @returns {boolean}
 */
function pathWithinDir(target, dir) {
  const absDir = path.resolve(dir);
  const absTarget = path.resolve(target);
  const resolvedDir = resolveExistingSymlinks(absDir);
  const resolvedTarget = resolveExistingSymlinks(absTarget);
  const prefix = resolvedDir.endsWith(path.sep)
    ? resolvedDir
    : resolvedDir + path.sep;
  return resolvedTarget === resolvedDir || resolvedTarget.startsWith(prefix);
}

/**
 * @param {string} p
 * @returns {string}
 */
function resolveExistingSymlinks(p) {
  let rest = "";
  let cur = p;
  for (;;) {
    try {
      return path.join(realpathSync(cur), rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return path.join(cur, rest);
      }
      rest = path.join(path.basename(cur), rest);
      cur = parent;
    }
  }
}

/**
 * @param {string} pluginID
 * @returns {{ pluginName: string, marketplaceName: string }}
 */
export function splitClaudePluginID(pluginID) {
  const i = pluginID.lastIndexOf("@");
  if (i <= 0 || i === pluginID.length - 1) {
    return { pluginName: "", marketplaceName: "" };
  }
  return {
    pluginName: pluginID.slice(0, i),
    marketplaceName: pluginID.slice(i + 1),
  };
}

/**
 * @typedef {{ installLocation: string, sourcePath: string }} KnownMarketplace
 */

/**
 * @param {string} filePath
 * @param {{ readFileSyncFn?: typeof readFileSync }} [deps]
 * @returns {Map<string, KnownMarketplace>}
 */
export function loadKnownMarketplaces(filePath, deps = {}) {
  const readFn = deps.readFileSyncFn ?? readFileSync;
  /** @type {Map<string, KnownMarketplace>} */
  const out = new Map();
  let raw;
  try {
    raw = readFn(filePath, "utf8");
  } catch {
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return out;
  }
  for (const [name, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const installLocation =
      typeof entry.installLocation === "string" ? entry.installLocation : "";
    let sourcePath = "";
    const source = entry.source;
    if (
      source &&
      typeof source === "object" &&
      !Array.isArray(source) &&
      source.source === "directory" &&
      typeof source.path === "string"
    ) {
      sourcePath = source.path;
    }
    out.set(name, { installLocation, sourcePath });
  }
  return out;
}

/**
 * @param {string} marketplaceJSONPath
 * @param {string} pluginName
 * @param {{ readFileSyncFn?: typeof readFileSync }} [deps]
 * @returns {string}
 */
export function marketplacePluginStringSource(
  marketplaceJSONPath,
  pluginName,
  deps = {},
) {
  const readFn = deps.readFileSyncFn ?? readFileSync;
  let raw;
  try {
    raw = readFn(marketplaceJSONPath, "utf8");
  } catch {
    return "";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  const plugins = parsed?.plugins;
  if (!Array.isArray(plugins)) return "";
  for (const p of plugins) {
    if (!p || typeof p !== "object" || p.name !== pluginName) continue;
    if (typeof p.source === "string" && p.source) return p.source;
    return "";
  }
  return "";
}

/**
 * @param {string} marketplaceRoot
 * @param {string} source
 * @returns {string}
 */
export function resolveUnderMarketplaceRoot(marketplaceRoot, source) {
  if (typeof source !== "string" || !source.startsWith("./")) return "";
  const rel = path.normalize(source.slice(2).replaceAll("\\", "/"));
  if (
    !rel ||
    rel === "." ||
    rel.startsWith("..") ||
    rel.includes(`${path.sep}..`)
  ) {
    return "";
  }
  const absRoot = path.resolve(marketplaceRoot);
  const full = path.resolve(absRoot, rel);
  const prefix = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
  if (full !== absRoot && !full.startsWith(prefix)) return "";
  return full;
}

/**
 * @param {string} pluginID
 * @param {Map<string, KnownMarketplace>} marketplaces
 * @param {string} claudeConfigDir
 * @param {{ home?: string, readFileSyncFn?: typeof readFileSync }} [deps]
 * @returns {string}
 */
export function liveMarketplaceMcpJSONPath(
  pluginID,
  marketplaces,
  claudeConfigDir,
  deps = {},
) {
  const { pluginName, marketplaceName } = splitClaudePluginID(pluginID);
  if (!pluginName || !marketplaceName) return "";
  const mp = marketplaces.get(marketplaceName);
  if (!mp) return "";
  const baseRaw = mp.installLocation || mp.sourcePath;
  const base = normalizeClaudePath(baseRaw, claudeConfigDir, {
    home: deps.home,
  });
  if (!base) return "";
  const relSource = marketplacePluginStringSource(
    path.join(base, ".claude-plugin", "marketplace.json"),
    pluginName,
    deps,
  );
  if (!relSource) return "";
  const pluginRoot = resolveUnderMarketplaceRoot(base, relSource);
  if (!pluginRoot) return "";
  return path.join(pluginRoot, ".mcp.json");
}

/**
 * @typedef {{ pluginID: string, installPath: string }} ClaudePluginInstall
 */

/**
 * @param {string} installedPluginsPath
 * @param {{ readFileSyncFn?: typeof readFileSync }} [deps]
 * @returns {ClaudePluginInstall[]}
 */
export function listClaudePluginInstalls(installedPluginsPath, deps = {}) {
  const readFn = deps.readFileSyncFn ?? readFileSync;
  let raw;
  try {
    raw = readFn(installedPluginsPath, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) {
    return [];
  }
  /** @type {ClaudePluginInstall[]} */
  const out = [];
  const keys = Object.keys(plugins).sort();
  for (const pluginID of keys) {
    const installs = plugins[pluginID];
    if (!Array.isArray(installs)) continue;
    /** @type {string[]} */
    const installPaths = [];
    for (const install of installs) {
      if (
        install &&
        typeof install === "object" &&
        typeof install.installPath === "string" &&
        install.installPath
      ) {
        installPaths.push(install.installPath);
      }
    }
    installPaths.sort();
    for (const installPath of installPaths) {
      out.push({ pluginID, installPath });
    }
  }
  return out;
}

/**
 * @param {ClaudePluginInstall} install
 * @param {Map<string, KnownMarketplace>} marketplaces
 * @param {string} claudeConfigDir
 * @param {{ home?: string, readFileSyncFn?: typeof readFileSync }} [deps]
 * @returns {string[]}
 */
export function mcpJSONPathsForInstall(
  install,
  marketplaces,
  claudeConfigDir,
  deps = {},
) {
  /** @type {string[]} */
  const paths = [];
  const live = liveMarketplaceMcpJSONPath(
    install.pluginID,
    marketplaces,
    claudeConfigDir,
    deps,
  );
  if (live) paths.push(live);
  if (install.installPath) {
    const cacheRoot = normalizeClaudePath(
      install.installPath,
      claudeConfigDir,
      { home: deps.home },
    );
    if (cacheRoot) {
      const cache = path.join(cacheRoot, ".mcp.json");
      if (cache !== live) paths.push(cache);
    }
  }
  return paths;
}

/**
 * Allow-roots for Agent Guard rewrite containment.
 * @param {{
 *   home?: string,
 *   env?: NodeJS.ProcessEnv,
 *   moduleUrl?: string,
 *   targets?: string[],
 * }} [opts]
 * @returns {string[]}
 */
export function resolveRewriteAllowRoots(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const claudeConfigDir = resolveClaudeConfigDir({ home, env });
  /** @type {string[]} */
  const roots = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    roots.push(p);
  };

  add(path.join(claudeConfigDir, "plugins"));

  const cacheDir = env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim();
  if (cacheDir) {
    add(normalizeClaudePath(cacheDir, claudeConfigDir, { home }));
  }
  const seedRaw = env.CLAUDE_CODE_PLUGIN_SEED_DIR?.trim();
  if (seedRaw) {
    const seedSep = process.platform === "win32" ? ";" : ":";
    for (const part of seedRaw.split(seedSep)) {
      const trimmed = part.trim();
      if (trimmed) {
        add(normalizeClaudePath(trimmed, claudeConfigDir, { home }));
      }
    }
  }

  for (const root of parseRootsEnv(env[ROOTS_ENV] ?? "")) {
    add(root);
  }
  add(resolvePluginRoot(opts.moduleUrl));
  for (const target of opts.targets ?? []) {
    add(path.dirname(target));
  }
  return roots;
}

/**
 * @param {{
 *   home?: string,
 *   env?: NodeJS.ProcessEnv,
 *   moduleUrl?: string,
 *   includeSelf?: boolean,
 *   existsSyncFn?: typeof existsSync,
 *   readFileSyncFn?: typeof readFileSync,
 *   statSyncFn?: typeof statSync,
 * }} [opts]
 * @returns {string[]}
 */
export function discoverClaudePluginMcpJsonPaths(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const existsFn = opts.existsSyncFn ?? existsSync;
  const readFn = opts.readFileSyncFn ?? readFileSync;
  const statFn = opts.statSyncFn ?? statSync;

  /** @type {string[]} */
  const paths = [];
  const seen = new Set();
  const addExisting = (p) => {
    if (!p || seen.has(p)) return;
    try {
      if (!existsFn(p) || !statFn(p).isFile()) return;
    } catch {
      return;
    }
    seen.add(p);
    paths.push(p);
  };

  const fromEnv = parseRootsEnv(env[ROOTS_ENV] ?? "");
  if (fromEnv.length > 0) {
    for (const root of fromEnv) {
      try {
        if (!existsFn(root) || !statFn(root).isDirectory()) continue;
      } catch {
        continue;
      }
      addExisting(path.join(root, ".mcp.json"));
      // Cursor-style dual name in override roots only.
      addExisting(path.join(root, "mcp.json"));
    }
    return paths;
  }

  const claudeConfigDir = resolveClaudeConfigDir({ home, env });
  const pluginsDir = path.join(claudeConfigDir, "plugins");
  const allowRoots = resolveRewriteAllowRoots({
    home,
    env,
    moduleUrl: opts.moduleUrl,
  });

  const marketplaces = loadKnownMarketplaces(
    path.join(pluginsDir, "known_marketplaces.json"),
    { readFileSyncFn: readFn },
  );
  const installs = listClaudePluginInstalls(
    path.join(pluginsDir, "installed_plugins.json"),
    { readFileSyncFn: readFn },
  );

  for (const install of installs) {
    for (const candidate of mcpJSONPathsForInstall(
      install,
      marketplaces,
      claudeConfigDir,
      { home, readFileSyncFn: readFn },
    )) {
      const abs = path.resolve(candidate);
      if (!allowRoots.some((root) => pathWithinDir(abs, root))) {
        continue;
      }
      addExisting(abs);
    }
  }

  if (opts.includeSelf !== false) {
    addExisting(path.join(resolvePluginRoot(opts.moduleUrl), ".mcp.json"));
  }

  return paths;
}
