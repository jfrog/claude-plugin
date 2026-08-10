#!/usr/bin/env node
// Fast SessionStart hook: register FileChanged watchPaths before the slower
// claude-align-plugin-mcps.mjs (npx) finishes, so mid-session plugin installs
// are watched even while Agent Guard is still downloading.
//
// Kill switch: JF_AGENT_ALIGN_PLUGIN_MCPS_DISABLE=1 → no-op (exit 0, no stdout).

import process from "node:process";

import {
  DISABLE_ENV,
  buildSessionStartWatchPayload,
  isAlignDisabled,
} from "./claude-align-plugin-mcps.mjs";
import { createLogger, setLogContext } from "./core/logger.mjs";
import { readStdin, parseSessionId, detectHarness } from "./core/io.mjs";
import { isMainEntry } from "./core/entry.mjs";

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

  if (isAlignDisabled(env)) {
    log.info("align disabled via env; skip watchPaths", { env: DISABLE_ENV });
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

function isExecutedDirectly() {
  return isMainEntry(import.meta.url);
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    log.error("unexpected failure", { error: err?.message ?? String(err) });
    process.exit(0);
  });
}
