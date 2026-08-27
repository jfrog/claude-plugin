// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  CLAUDE_CONFIG_DIR_ENV,
  ROOTS_ENV,
  buildSessionStartWatchPayload,
  discoverClaudePluginMcpJsonPaths,
  parseRootsEnv,
  resolveAlignWatchPaths,
  resolveClaudeConfigDir,
  resolvePluginRoot,
  resolveRewriteAllowRoots,
} from "./claude-mcp-json-discover.mjs";

/** @type {string[]} */
const tempRoots = [];

/**
 * @param {string[]} segments
 * @returns {string}
 */
function tempDir(...segments) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-discover-"));
  tempRoots.push(root);
  const full = path.join(root, ...segments);
  mkdirSync(full, { recursive: true });
  return full;
}

after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/**
 * @param {string} configDir
 * @param {Record<string, unknown>} installed
 * @param {Record<string, unknown>} [known]
 */
function writePluginManifests(configDir, installed, known) {
  const pluginsDir = path.join(configDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify(installed),
  );
  if (known) {
    writeFileSync(
      path.join(pluginsDir, "known_marketplaces.json"),
      JSON.stringify(known),
    );
  }
}

test("parseRootsEnv splits POSIX and Windows delimiters", () => {
  assert.deepEqual(parseRootsEnv("/a:/b,/c", "linux"), ["/a", "/b", "/c"]);
  assert.deepEqual(parseRootsEnv("C:\\a;D:\\b,E:\\c", "win32"), [
    "C:\\a",
    "D:\\b",
    "E:\\c",
  ]);
  assert.deepEqual(parseRootsEnv("C:\\plugins", "win32"), ["C:\\plugins"]);
  assert.deepEqual(parseRootsEnv("  ", "linux"), []);
});

test("resolveClaudeConfigDir prefers CLAUDE_CONFIG_DIR", () => {
  const home = "/home/user";
  assert.equal(
    resolveClaudeConfigDir({ home, env: {} }),
    path.join(home, ".claude"),
  );
  assert.equal(
    resolveClaudeConfigDir({
      home,
      env: { [CLAUDE_CONFIG_DIR_ENV]: "/custom/claude" },
    }),
    "/custom/claude",
  );
});

test("resolvePluginRoot is parent of scripts/", () => {
  const scriptsDir = path.join("/tmp/plugin", "scripts");
  const moduleUrl = pathToFileURL(
    path.join(scriptsDir, "claude-mcp-json-discover.mjs"),
  ).href;
  assert.equal(resolvePluginRoot(moduleUrl), path.join("/tmp/plugin"));
});

test("resolveAlignWatchPaths points at installed_plugins and known_marketplaces", () => {
  const configDir = "/cfg/claude";
  assert.deepEqual(resolveAlignWatchPaths({ env: { [CLAUDE_CONFIG_DIR_ENV]: configDir } }), [
    path.join(configDir, "plugins", "installed_plugins.json"),
    path.join(configDir, "plugins", "known_marketplaces.json"),
  ]);
});

test("buildSessionStartWatchPayload emits Claude watchPaths", () => {
  const configDir = "/tmp/claude-cfg";
  const payload = JSON.parse(
    buildSessionStartWatchPayload({
      [CLAUDE_CONFIG_DIR_ENV]: configDir,
    }),
  );
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.deepEqual(payload.hookSpecificOutput.watchPaths, [
    path.join(configDir, "plugins", "installed_plugins.json"),
    path.join(configDir, "plugins", "known_marketplaces.json"),
  ]);
});

test("discoverClaudePluginMcpJsonPaths finds installPath .mcp.json", () => {
  const configDir = tempDir("claude-install");
  const installRoot = path.join(configDir, "plugins", "cache", "mp", "demo", "1.0.0");
  mkdirSync(installRoot, { recursive: true });
  const mcpPath = path.join(installRoot, ".mcp.json");
  writeFileSync(mcpPath, "{}");

  writePluginManifests(configDir, {
    plugins: {
      "demo@mp": [{ installPath: installRoot }],
    },
  });

  const paths = discoverClaudePluginMcpJsonPaths({
    home: "/unused",
    env: { [CLAUDE_CONFIG_DIR_ENV]: configDir },
    includeSelf: false,
  });
  assert.deepEqual(paths, [mcpPath]);
});

test("discoverClaudePluginMcpJsonPaths prefers live marketplace string-source over installPath", () => {
  const configDir = tempDir("claude-live");
  const marketplaceRoot = path.join(configDir, "plugins", "marketplaces", "local-mp");
  const livePluginRoot = path.join(marketplaceRoot, "plugins", "demo");
  mkdirSync(livePluginRoot, { recursive: true });
  mkdirSync(path.join(marketplaceRoot, ".claude-plugin"), { recursive: true });
  const liveMcp = path.join(livePluginRoot, ".mcp.json");
  writeFileSync(liveMcp, "{}");
  writeFileSync(
    path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      plugins: [{ name: "demo", source: "./plugins/demo" }],
    }),
  );

  const cacheRoot = path.join(configDir, "plugins", "cache", "local-mp", "demo", "1.0.0");
  mkdirSync(cacheRoot, { recursive: true });
  const cacheMcp = path.join(cacheRoot, ".mcp.json");
  writeFileSync(cacheMcp, "{}");

  writePluginManifests(
    configDir,
    {
      plugins: {
        "demo@local-mp": [{ installPath: cacheRoot }],
      },
    },
    {
      "local-mp": { installLocation: marketplaceRoot },
    },
  );

  const paths = discoverClaudePluginMcpJsonPaths({
    home: "/unused",
    env: { [CLAUDE_CONFIG_DIR_ENV]: configDir },
    includeSelf: false,
  });
  assert.deepEqual(paths, [liveMcp, cacheMcp]);
});

test("discoverClaudePluginMcpJsonPaths skips missing .mcp.json files", () => {
  const configDir = tempDir("claude-missing");
  const installRoot = path.join(configDir, "plugins", "cache", "mp", "gone", "1.0.0");
  mkdirSync(installRoot, { recursive: true });

  writePluginManifests(configDir, {
    plugins: {
      "gone@mp": [{ installPath: installRoot }],
    },
  });

  const paths = discoverClaudePluginMcpJsonPaths({
    home: "/unused",
    env: { [CLAUDE_CONFIG_DIR_ENV]: configDir },
    includeSelf: false,
  });
  assert.deepEqual(paths, []);
});

test("discoverClaudePluginMcpJsonPaths honors JF_ALIGN_MCP_JSON_ROOTS override", () => {
  const override = tempDir("override-root");
  const mcpPath = path.join(override, ".mcp.json");
  writeFileSync(mcpPath, "{}");

  const paths = discoverClaudePluginMcpJsonPaths({
    home: "/unused",
    env: { [ROOTS_ENV]: override },
    includeSelf: false,
  });
  assert.deepEqual(paths, [mcpPath]);
});

test("discoverClaudePluginMcpJsonPaths includes hosting plugin .mcp.json", () => {
  const configDir = tempDir("claude-self");
  writePluginManifests(configDir, { plugins: {} });

  const selfRoot = tempDir("self-plugin");
  const selfMcp = path.join(selfRoot, ".mcp.json");
  writeFileSync(selfMcp, "{}");
  const moduleUrl = pathToFileURL(
    path.join(selfRoot, "scripts", "claude-mcp-json-discover.mjs"),
  ).href;

  const paths = discoverClaudePluginMcpJsonPaths({
    home: "/unused",
    env: { [CLAUDE_CONFIG_DIR_ENV]: configDir },
    moduleUrl,
    includeSelf: true,
  });
  assert.deepEqual(paths, [selfMcp]);
});

test("resolveRewriteAllowRoots includes plugins dir and optional cache/seed", () => {
  const configDir = tempDir("claude-allow");
  const pluginsDir = path.join(configDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const cacheDir = tempDir("extra-cache");
  const seedDir = tempDir("seed");

  const roots = resolveRewriteAllowRoots({
    home: "/unused",
    env: {
      [CLAUDE_CONFIG_DIR_ENV]: configDir,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: cacheDir,
      CLAUDE_CODE_PLUGIN_SEED_DIR: seedDir,
    },
    targets: [path.join(pluginsDir, "cache", "x", ".mcp.json")],
  });

  assert.ok(roots.includes(pluginsDir));
  assert.ok(roots.includes(cacheDir));
  assert.ok(roots.includes(seedDir));
  assert.ok(roots.includes(path.join(pluginsDir, "cache", "x")));
});
