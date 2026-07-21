// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  createDiskPaths,
  PLUGIN_NAME,
  SINGLETON_FILES,
  TOKEN_FILE,
  CONFIG_FILE,
  PRE_PREFIX,
  POST_PREFIX,
  SENDING_PREFIX,
  TMP_SUFFIX,
} from "../src/storage/diskPaths.mjs";

const HOME = "/home/dev";
const SESSION_ID = "cs_abc123";
const TOOL_USE_ID = "toolu_01xyz";
const CUSTOM_PLUGIN = "cursor-plugin";

const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

// (label, value) pairs a path segment must reject to stay inside the root and
// be safe on every target OS (macOS / Linux / Windows).
const UNSAFE_SEGMENTS = [
  // POSIX + universal hazards.
  ["forward slash", "a/b"],
  ["backslash", `a${BACKSLASH}b`],
  ["NUL byte", `a${NUL}b`],
  ["parent traversal", ".."],
  ["current dir", "."],
  ["leading traversal", "../etc/passwd"],
  ["empty string", ""],
  ["non-string", 123],
  // Windows-specific traps a POSIX-only guard would let through.
  ["colon (drive-relative)", "C:foo"],
  ["colon (NTFS alt-data-stream)", "file.json:evil"],
  ["embedded space", "a b"],
  ["trailing space", "foo "],
  ["trailing dot (Windows strips it)", "foo."],
  ["reserved device CON", "CON"],
  ["reserved device lowercase con", "con"],
  ["reserved device NUL", "NUL"],
  ["reserved device COM1", "COM1"],
  ["reserved device LPT9", "LPT9"],
  ["reserved device with extension", "CON.json"],
];

const SAFE_IDS = ["cs_abc123", "toolu_01xyz", "cs-with-dash", "id.with.dots"];

function expectedRoot(home, plugin) {
  return path.join(home, ".jfrog", "agent-hooks", plugin);
}

test("root resolves under ~/.jfrog/agent-hooks/<plugin> with the default plugin", () => {
  const paths = createDiskPaths({ home: HOME });
  assert.equal(paths.root, expectedRoot(HOME, PLUGIN_NAME));
  assert.equal(PLUGIN_NAME, "claude-plugin");
});

test("plugin override changes only the leaf directory", () => {
  const paths = createDiskPaths({ home: HOME, plugin: CUSTOM_PLUGIN });
  assert.equal(paths.root, expectedRoot(HOME, CUSTOM_PLUGIN));
});

test("singletons resolve directly under the root", () => {
  const paths = createDiskPaths({ home: HOME });
  assert.equal(paths.tokenFile, path.join(paths.root, TOKEN_FILE));
  assert.equal(paths.configFile, path.join(paths.root, CONFIG_FILE));
  assert.deepEqual([...SINGLETON_FILES], [TOKEN_FILE, CONFIG_FILE]);
});

test("session folder nests under the root", () => {
  const paths = createDiskPaths({ home: HOME });
  assert.equal(paths.sessionDir(SESSION_ID), path.join(paths.root, SESSION_ID));
});

test("per-tool files carry their prefix inside the session folder", () => {
  const paths = createDiskPaths({ home: HOME });
  const dir = paths.sessionDir(SESSION_ID);
  assert.equal(
    paths.preFile(SESSION_ID, TOOL_USE_ID),
    path.join(dir, `${PRE_PREFIX}${TOOL_USE_ID}.json`),
  );
  assert.equal(
    paths.postFile(SESSION_ID, TOOL_USE_ID),
    path.join(dir, `${POST_PREFIX}${TOOL_USE_ID}.json`),
  );
  assert.equal(
    paths.sendingFile(SESSION_ID, TOOL_USE_ID),
    path.join(dir, `${SENDING_PREFIX}${TOOL_USE_ID}.json`),
  );
});

test("the prefixes and the tmp suffix are distinct and non-empty", () => {
  const prefixes = new Set([PRE_PREFIX, POST_PREFIX, SENDING_PREFIX]);
  assert.equal(prefixes.size, 3);
  assert.ok(TMP_SUFFIX.startsWith("."));
});

test("unsafe path segments are rejected for both session and tool ids", () => {
  const paths = createDiskPaths({ home: HOME });
  for (const [label, value] of UNSAFE_SEGMENTS) {
    assert.throws(() => paths.sessionDir(value), `sessionDir must reject ${label}`);
    assert.throws(
      () => paths.preFile(SESSION_ID, value),
      `preFile must reject ${label} tool id`,
    );
  }
});

test("safe ids are accepted and stay within the session folder", () => {
  const paths = createDiskPaths({ home: HOME });
  for (const id of SAFE_IDS) {
    const dir = paths.sessionDir(id);
    assert.ok(dir.startsWith(paths.root + path.sep));
    assert.ok(!dir.slice(paths.root.length).includes(".."));
  }
});
