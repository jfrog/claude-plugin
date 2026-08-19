#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Claude SessionStart / FileChanged adapter: invoke the shared Agent Guard
// rewrite pipeline with Claude plugin .mcp.json discovery.
//
// Usage:
//   node claude-align-mcp-json.mjs session-start
//   node claude-align-mcp-json.mjs file-changed
//
// Path discovery: claude-mcp-json-discover.mjs
// Orchestration / Step 0 / spawn: modules/core/rewrite-mcp-json.mjs
//
// Kill switch: JF_AGENT_REWRITE_MCP_JSON_DISABLE=1 → soft no-op (exit 0).
// Never exits non-zero — a failed rewrite must not break the Claude session.
//
// watchPaths registration is owned by claude-register-align-watch-paths.mjs.
// When rewrite updates files, this hook emits additionalContext asking the
// user to run /reload-plugins.

import { existsSync } from "node:fs";
import process from "node:process";

import { isMainEntry } from "../modules/core/entry.mjs";
import { detectHarness, parseSessionId, readStdin } from "../modules/core/io.mjs";
import { createLogger, setLogContext } from "../modules/core/logger.mjs";
import {
  OUTCOME,
  runRewriteMcpJsonPipeline,
} from "../modules/core/rewrite-mcp-json.mjs";
import {
  discoverClaudePluginMcpJsonPaths,
  resolveRewriteAllowRoots,
} from "./claude-mcp-json-discover.mjs";

const HARNESS_ID = "claude_code";
const log = createLogger("align-mcp-json");

/** Recommended Claude hooks.json timeout (seconds) for SessionStart + FileChanged.
 * Internal rewrite budget ≈ jf config export (2s) + gate fetch (5s) +
 * DEFAULT_REWRITE_TIMEOUT_MS (35s) + DEFAULT_KILL_GRACE_MS (2s) ≈ 44s.
 * 60s keeps ~16s of margin so Claude does not kill the hook first.
 */
export const RECOMMENDED_HOOK_TIMEOUT_SEC = 60;

/**
 * Recommended FileChanged matcher for installed-plugin metadata. Dots are
 * escaped and the pattern is anchored so Claude's regex mode does not treat
 * `.` as "any character" or match `*.json.bak` suffixes.
 */
export const RECOMMENDED_FILE_CHANGED_MATCHER =
  "(installed_plugins|known_marketplaces)\\.json$";

/** @type {ReadonlySet<string>} */
export const MODES = Object.freeze(new Set(["session-start", "file-changed"]));

const RELOAD_HINT =
  "JFrog Agent Guard secured your plugins' MCP servers. Run /reload-plugins to reconnect.";

/**
 * @param {string | undefined} modeArg
 * @returns {boolean}
 */
export function isKnownMode(modeArg) {
  return typeof modeArg === "string" && MODES.has(modeArg);
}

/**
 * @param {string} modeArg
 * @returns {string}
 */
export function buildReloadPluginsPayload(modeArg) {
  const hookEventName =
    modeArg === "file-changed" ? "FileChanged" : "SessionStart";
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext: RELOAD_HINT,
    },
  })}\n`;
}

/**
 * Thin harness entry: detect Claude Code, discover paths, run shared pipeline.
 * @param {string | undefined} modeArg
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   home?: string,
 *   readStdinFn?: typeof readStdin,
 *   runRewriteMcpJsonPipelineFn?: typeof runRewriteMcpJsonPipeline,
 *   writeStdout?: (s: string) => void,
 *   existsSyncFn?: typeof existsSync,
 *   mcpJsonPath?: string,
 *   timeoutMs?: number,
 *   graceMs?: number,
 *   spawnFn?: unknown,
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 *   runAgentGuardCheckFn?: unknown,
 *   readFileSyncFn?: unknown,
 * }} [deps]
 * @returns {Promise<number>} always 0
 */
export async function runClaudeAlignMcpJson(modeArg, deps = {}) {
  const env = deps.env ?? process.env;
  const readStdinFn = deps.readStdinFn ?? readStdin;
  const pipelineFn =
    deps.runRewriteMcpJsonPipelineFn ?? runRewriteMcpJsonPipeline;
  const writeStdout = deps.writeStdout ?? ((s) => process.stdout.write(s));

  const stdinRaw = await readStdinFn();
  setLogContext({ ide: HARNESS_ID, sessionId: parseSessionId(stdinRaw) });

  const harness = detectHarness(stdinRaw);
  if (harness && harness !== HARNESS_ID) {
    log.info("invoked by another harness; no-op", { harness });
    return 0;
  }

  if (!isKnownMode(modeArg)) {
    log.warn("unknown mode; no-op", { mode: modeArg ?? "" });
    return 0;
  }

  const existsFn = deps.existsSyncFn ?? existsSync;

  const result = await pipelineFn({
    env,
    discover: () => {
      if (deps.mcpJsonPath) {
        return existsFn(deps.mcpJsonPath) ? [deps.mcpJsonPath] : [];
      }
      return discoverClaudePluginMcpJsonPaths({
        home: deps.home,
        env,
        moduleUrl: import.meta.url,
        existsSyncFn: existsFn,
        readFileSyncFn: deps.readFileSyncFn,
      });
    },
    allowRoots: (paths) =>
      resolveRewriteAllowRoots({
        home: deps.home,
        env,
        moduleUrl: import.meta.url,
        targets: paths,
      }),
    spawnFn: deps.spawnFn,
    timeoutMs: deps.timeoutMs,
    graceMs: deps.graceMs,
    platform: deps.platform,
    killFn: deps.killFn,
    runAgentGuardCheckFn: deps.runAgentGuardCheckFn,
    readFileSyncFn: deps.readFileSyncFn,
  });

  if (result?.outcome === OUTCOME.REWRITTEN) {
    writeStdout(buildReloadPluginsPayload(modeArg));
  }

  return 0;
}

async function main() {
  await runClaudeAlignMcpJson(process.argv[2]);
  process.exit(0);
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    log.error("unexpected failure", { error: err?.message ?? String(err) });
    process.exit(0);
  });
}
