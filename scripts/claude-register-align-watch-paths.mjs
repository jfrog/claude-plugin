#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Fast SessionStart hook: register FileChanged watchPaths before the slower
// claude-align-mcp-json.mjs (npx) finishes, so mid-session plugin installs are
// watched even while Agent Guard is still downloading.
//
// This hook solely owns watchPaths registration. Kill switch:
// JF_AGENT_REWRITE_MCP_JSON_DISABLE=1 → no-op (exit 0, no stdout).

import process from "node:process";

import { isMainEntry } from "../modules/core/entry.mjs";
import { detectHarness, parseSessionId, readStdin } from "../modules/core/io.mjs";
import { createLogger, setLogContext } from "../modules/core/logger.mjs";
import {
  REWRITE_DISABLE_ENV,
  buildSessionStartWatchPayload,
  isAlignRewriteDisabled,
} from "./claude-mcp-json-discover.mjs";

const HARNESS_ID = "claude_code";
const log = createLogger("register-align-watch-paths");

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   writeStdout?: (s: string) => void,
 *   readStdinFn?: () => Promise<string>,
 * }} [deps]
 * @returns {Promise<number>} always 0
 */
export async function runRegisterWatchPaths(deps = {}) {
  const env = deps.env ?? process.env;
  const writeStdout = deps.writeStdout ?? ((s) => process.stdout.write(s));
  const readStdinFn = deps.readStdinFn ?? readStdin;

  const stdinRaw = await readStdinFn();
  setLogContext({ ide: HARNESS_ID, sessionId: parseSessionId(stdinRaw) });

  const harness = detectHarness(stdinRaw);
  if (harness && harness !== HARNESS_ID) {
    log.info("invoked by another harness; no-op", { harness });
    return 0;
  }

  if (isAlignRewriteDisabled(env)) {
    log.info("rewrite disabled via env; skip watchPaths", {
      env: REWRITE_DISABLE_ENV,
    });
    return 0;
  }

  writeStdout(buildSessionStartWatchPayload(env));
  log.info("registered align watchPaths");
  return 0;
}

async function main() {
  await runRegisterWatchPaths();
  process.exit(0);
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    log.error("unexpected failure", { error: err?.message ?? String(err) });
    process.exit(0);
  });
}
