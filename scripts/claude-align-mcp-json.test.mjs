// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  CLAUDE_CONFIG_DIR_ENV,
  REWRITE_DISABLE_ENV,
  ROOTS_ENV,
} from "./claude-mcp-json-discover.mjs";
import {
  RECOMMENDED_FILE_CHANGED_MATCHER,
  RECOMMENDED_HOOK_TIMEOUT_SEC,
  isKnownMode,
  runClaudeAlignMcpJson,
} from "./claude-align-mcp-json.mjs";
import { runRegisterWatchPaths } from "./claude-register-align-watch-paths.mjs";
import { OUTCOME } from "../modules/core/rewrite-mcp-json.mjs";

const HOOKS_JSON_PATH = path.resolve(import.meta.dirname, "../hooks/hooks.json");

/** @type {string[]} */
const tempRoots = [];

/**
 * @param {string[]} segments
 * @returns {string}
 */
function tempDir(...segments) {
  const root = mkdtempSync(path.join(tmpdir(), "claude-align-"));
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

function readHooksJson() {
  return JSON.parse(readFileSync(HOOKS_JSON_PATH, "utf8"));
}

/** @returns {unknown[]} */
function alignHookEntries() {
  const hooks = readHooksJson().hooks ?? {};
  return Object.values(hooks)
    .flat()
    .flatMap((matcherEntry) => matcherEntry.hooks ?? [])
    .filter((hook) =>
      String(hook.command ?? "").includes("claude-align-mcp-json.mjs"),
    );
}

test("isKnownMode accepts session-start and file-changed", () => {
  assert.equal(isKnownMode("session-start"), true);
  assert.equal(isKnownMode("file-changed"), true);
  assert.equal(isKnownMode("other"), false);
  assert.equal(isKnownMode(undefined), false);
});

test("recommended FileChanged matcher only matches the two plugin metadata files", () => {
  const re = new RegExp(RECOMMENDED_FILE_CHANGED_MATCHER);
  assert.ok(re.test("/cfg/plugins/installed_plugins.json"));
  assert.ok(re.test("/cfg/plugins/known_marketplaces.json"));
  assert.ok(!re.test("/cfg/plugins/installed_pluginsXjson"));
  assert.ok(!re.test("/cfg/plugins/installed_plugins.json.bak"));
});

test("hooks.json FileChanged matcher matches RECOMMENDED_FILE_CHANGED_MATCHER", () => {
  assert.equal(
    readHooksJson().hooks.FileChanged[0].matcher,
    RECOMMENDED_FILE_CHANGED_MATCHER,
  );
});

test("hooks.json align timeouts match RECOMMENDED_HOOK_TIMEOUT_SEC", () => {
  const entries = alignHookEntries();
  assert.ok(entries.length >= 2, "expected SessionStart and FileChanged align hooks");
  for (const entry of entries) {
    assert.equal(entry.timeout, RECOMMENDED_HOOK_TIMEOUT_SEC);
  }
});

test("runClaudeAlignMcpJson no-ops on unknown mode", async () => {
  let called = false;
  const code = await runClaudeAlignMcpJson("nope", {
    readStdinFn: async () => "",
    runRewriteMcpJsonPipelineFn: async () => {
      called = true;
      return { exitCode: 0, outcome: OUTCOME.DISABLED, reason: "" };
    },
    writeStdout: () => {},
  });
  assert.equal(code, 0);
  assert.equal(called, false);
});

test("runClaudeAlignMcpJson no-ops when harness is not claude_code", async () => {
  let called = false;
  const code = await runClaudeAlignMcpJson("session-start", {
    readStdinFn: async () =>
      JSON.stringify({ session_id: "s1", cursor_version: "1.0.0" }),
    runRewriteMcpJsonPipelineFn: async () => {
      called = true;
      return { exitCode: 0, outcome: OUTCOME.DISABLED, reason: "" };
    },
    writeStdout: () => {},
  });
  assert.equal(code, 0);
  assert.equal(called, false);
});

test("runClaudeAlignMcpJson passes discovered paths and does not emit watchPaths", async () => {
  const configDir = tempDir("claude-pipeline");
  const installRoot = path.join(configDir, "plugins", "cache", "mp", "a", "1.0.0");
  mkdirSync(installRoot, { recursive: true });
  const mcpPath = path.join(installRoot, ".mcp.json");
  writeFileSync(mcpPath, "{}");
  writeFileSync(
    path.join(configDir, "plugins", "installed_plugins.json"),
    JSON.stringify({ plugins: { "a@mp": [{ installPath: installRoot }] } }),
  );

  /** @type {{ paths?: string[], allowRoots?: string[] }} */
  const captured = {};
  /** @type {string} */
  let stdout = "";
  const code = await runClaudeAlignMcpJson("session-start", {
    env: {
      [CLAUDE_CONFIG_DIR_ENV]: configDir,
      [ROOTS_ENV]: installRoot,
    },
    readStdinFn: async () =>
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    runRewriteMcpJsonPipelineFn: async (opts) => {
      const paths = await opts.discover();
      captured.paths = paths;
      captured.allowRoots =
        typeof opts.allowRoots === "function"
          ? opts.allowRoots(paths)
          : opts.allowRoots;
      return { exitCode: 0, outcome: OUTCOME.SKIPPED_CURRENT, reason: "" };
    },
    writeStdout: (s) => {
      stdout += s;
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(captured.paths, [mcpPath]);
  assert.ok(captured.allowRoots?.includes(path.join(configDir, "plugins")));
  assert.equal(stdout, "");
});

test("runClaudeAlignMcpJson emits reload hint when outcome is rewritten", async () => {
  let stdout = "";
  const code = await runClaudeAlignMcpJson("session-start", {
    env: { [CLAUDE_CONFIG_DIR_ENV]: tempDir("reload") },
    readStdinFn: async () =>
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    runRewriteMcpJsonPipelineFn: async () => ({
      exitCode: 0,
      outcome: OUTCOME.REWRITTEN,
      reason: "",
    }),
    writeStdout: (s) => {
      stdout += s;
    },
  });
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(
    payload.hookSpecificOutput.additionalContext,
    /\/reload-plugins/,
  );
  assert.match(
    payload.hookSpecificOutput.additionalContext,
    /JFrog Agent Guard secured your plugins' MCP servers/,
  );
  assert.doesNotMatch(
    payload.hookSpecificOutput.additionalContext,
    /\d+ files? updated/,
  );
});

test("runClaudeAlignMcpJson does not emit reload when outcome is not rewritten", async () => {
  let stdout = "";
  const code = await runClaudeAlignMcpJson("session-start", {
    env: { [CLAUDE_CONFIG_DIR_ENV]: tempDir("no-reload") },
    readStdinFn: async () =>
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    runRewriteMcpJsonPipelineFn: async () => ({
      exitCode: 0,
      outcome: OUTCOME.SKIPPED_GATE,
      reason: "Disabled: test",
    }),
    writeStdout: (s) => {
      stdout += s;
    },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

test("runClaudeAlignMcpJson file-changed emits reload hint without watchPaths", async () => {
  let stdout = "";
  let called = false;
  const code = await runClaudeAlignMcpJson("file-changed", {
    env: { [CLAUDE_CONFIG_DIR_ENV]: tempDir("fc") },
    readStdinFn: async () =>
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "FileChanged",
        transcript_path: "/t",
      }),
    runRewriteMcpJsonPipelineFn: async () => {
      called = true;
      return {
        exitCode: 0,
        outcome: OUTCOME.REWRITTEN,
        reason: "",
      };
    },
    writeStdout: (s) => {
      stdout += s;
    },
  });
  assert.equal(code, 0);
  assert.equal(called, true);
  const payload = JSON.parse(stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, "FileChanged");
  assert.match(
    payload.hookSpecificOutput.additionalContext,
    /\/reload-plugins/,
  );
  assert.match(
    payload.hookSpecificOutput.additionalContext,
    /JFrog Agent Guard secured your plugins' MCP servers/,
  );
  assert.equal(payload.hookSpecificOutput.watchPaths, undefined);
});

test("runRegisterWatchPaths emits watchPaths and respects kill switch", async () => {
  const configDir = tempDir("watch");
  let stdout = "";
  const code = await runRegisterWatchPaths({
    env: { [CLAUDE_CONFIG_DIR_ENV]: configDir },
    readStdinFn: async () =>
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    writeStdout: (s) => {
      stdout += s;
    },
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes("installed_plugins.json"));

  stdout = "";
  const disabled = await runRegisterWatchPaths({
    env: {
      [CLAUDE_CONFIG_DIR_ENV]: configDir,
      [REWRITE_DISABLE_ENV]: "1",
    },
    readStdinFn: async () =>
      JSON.stringify({
        session_id: "s1",
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    writeStdout: (s) => {
      stdout += s;
    },
  });
  assert.equal(disabled, 0);
  assert.equal(stdout, "");
});
