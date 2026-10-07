#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Local Shadow AI trigger.
//   node claude-local-shadow-trigger.mjs session_start   runs once (SessionStart hook)
//   node claude-local-shadow-trigger.mjs monitor         runs every hour (plugin monitor)
//
// Flow, stopping at the first result:
//   1. the last successful scan was less than 55 minutes ago -> scanned_recently
//   2. the default jf CLI server has no access token         -> not_logged_in
//   3. ask the backend if scanning is enabled:
//        401 -> not_logged_in, enabled=false -> scanning_disabled, any error -> check_failed
//   4. start `agent-guard --local-shadow-scan` detached      -> scanner_started
// Each run appends its result to ~/.jfrog/shadow/local-shadow-hook.log.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isMainEntry } from "../modules/core/entry.mjs";
import {
  clearPlatformIdentityCache,
  getPlatformIdentity,
  safeErrorMessage,
} from "../modules/core/jf-identity.mjs";
import { skillsProductUserAgent } from "../modules/core/jf-user-agent.mjs";
import {
  AGENT_GUARD_PACKAGE,
  buildNpxSpawnOptions,
  quoteSpawnArgs,
  resolveAgentGuardBin,
  resolveAgentGuardNpmRegistry,
  resolveNpxCommand,
} from "../modules/core/rewrite-mcp-json.mjs";

export const RESULT = Object.freeze({
  SCANNED_RECENTLY: "scanned_recently",
  NOT_LOGGED_IN: "not_logged_in",
  SCANNING_DISABLED: "scanning_disabled",
  CHECK_FAILED: "check_failed",
  SCANNER_STARTED: "scanner_started",
});

export const MONITOR_INTERVAL_MS = 60 * 60 * 1000;
// Shorter than the monitor interval: a scan finishes a few seconds after the
// tick that started it, so at the next tick its success is just under an hour old.
export const MIN_TIME_BETWEEN_SCANS_MS = 55 * 60 * 1000;
export const SCANNING_ENABLED_PATH =
  "/ml/core/api/v1/local-shadow/scanning-enabled";
const REQUEST_TIMEOUT_MS = 5000;
export const HOOK_LOG_FILE = "local-shadow-hook.log";
export const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;
// Owner-only, like the scanner's files in the same directory.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// The scanner's state directory: $JFROG_CLI_HOME_DIR/shadow, or ~/.jfrog/shadow.
export function shadowDir(env) {
  const jfHome =
    env.JFROG_CLI_HOME_DIR?.trim() || path.join(homedir(), ".jfrog");
  return path.join(jfHome, "shadow");
}

// True when receipt.json's lastSuccessAt is less than MIN_TIME_BETWEEN_SCANS_MS old.
// A missing or corrupt receipt, no success yet, or a time in the future returns false.
export function scannedRecently(receiptPath, now) {
  let lastSuccessAt;
  try {
    lastSuccessAt = JSON.parse(readFileSync(receiptPath, "utf8"))?.lastSuccessAt;
  } catch {
    return false;
  }
  const age = now - Date.parse(lastSuccessAt);
  return age >= 0 && age < MIN_TIME_BETWEEN_SCANS_MS;
}

// Asks the backend whether scanning is enabled for this account.
// Returns the trigger result: scanner_started when enabled, otherwise why not.
async function checkScanningEnabled(baseUrl, token, fetchFn) {
  const root = baseUrl.replace(/\/+$/, "").replace(/\/artifactory$/, "");
  const failed = (detail) => ({
    result: RESULT.CHECK_FAILED,
    error: `scanning enabled: ${detail}`,
  });

  let response;
  let body;
  try {
    response = await fetchFn(root + SCANNING_ENABLED_PATH, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": skillsProductUserAgent(),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = response.ok ? await response.json() : null;
  } catch (err) {
    return failed(safeErrorMessage(err));
  }

  if (response.status === 401) {
    return { result: RESULT.NOT_LOGGED_IN, error: "token rejected (HTTP 401)" };
  }
  if (!response.ok) return failed(`HTTP ${response.status}`);
  if (body?.enabled === true) return { result: RESULT.SCANNER_STARTED };
  if (body?.enabled === false) return { result: RESULT.SCANNING_DISABLED };
  return failed("response has no boolean 'enabled'");
}

// Starts `agent-guard --local-shadow-scan` in the background. Resolves as soon as
// the OS has started the process; it never waits for the scan to finish.
// Detached so it outlives this process; no stdio, because anything a monitor
// prints reaches the session. JFROG_AGENT_GUARD_BIN runs a local binary.
// --prefer-offline uses the agent-guard the SessionStart pre-warm keeps cached,
// like the plugin's other agent-guard hooks; it downloads only on a cold cache.
async function startScanner(env, platform, spawnFn) {
  const bin = resolveAgentGuardBin(env);
  const command = bin ?? resolveNpxCommand(platform);
  const args = bin
    ? ["--local-shadow-scan"]
    : quoteSpawnArgs(
        [
          "--yes",
          "--prefer-offline",
          "--registry",
          resolveAgentGuardNpmRegistry(env),
          AGENT_GUARD_PACKAGE,
          "--local-shadow-scan",
        ],
        platform,
      );
  const child = spawnFn(command, args, {
    ...buildNpxSpawnOptions(env, platform, { local: Boolean(bin) }),
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

// Appends one JSON line to the trigger log. When the log reaches HOOK_LOG_MAX_BYTES
// it's renamed to <log>.1 (replacing the old backup) and a new log starts.
// Never throws: a logging failure must not affect the session.
export function appendHookLog(logPath, entry) {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true, mode: DIR_MODE });
    try {
      if (statSync(logPath).size >= HOOK_LOG_MAX_BYTES) {
        renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // No log yet, or another session rotated it first.
    }
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    appendFileSync(logPath, `${line}\n`, { mode: FILE_MODE });
  } catch {
    // ignore
  }
}

// Steps 1-4 of the flow at the top of this file. Returns what gets logged:
// { result } on success, or { result, error } when a step failed.
async function runChecksAndStartScanner({ env, now, getIdentityFn, fetchFn, spawnFn, platform }) {
  if (scannedRecently(path.join(shadowDir(env), "receipt.json"), now)) {
    return { result: RESULT.SCANNED_RECENTLY };
  }

  const { identity } = getIdentityFn();
  if (identity?.auth?.kind !== "bearer" || !identity.auth.token) {
    return { result: RESULT.NOT_LOGGED_IN };
  }

  const outcome = await checkScanningEnabled(identity.url, identity.auth.token, fetchFn);
  if (outcome.result !== RESULT.SCANNER_STARTED) return outcome;

  try {
    await startScanner(env, platform, spawnFn);
  } catch (err) {
    return {
      result: RESULT.CHECK_FAILED,
      error: `start scanner: ${safeErrorMessage(err)}`,
    };
  }
  return outcome;
}

// One trigger run: the checks, then one line in local-shadow-hook.log.
// trigger is session_start or monitor; it's only recorded in the log line.
export async function runLocalShadowTrigger(trigger, {
  env = process.env,
  now = Date.now(),
  getIdentityFn = getPlatformIdentity,
  fetchFn = fetch,
  spawnFn = spawn,
  platform = process.platform,
} = {}) {
  const outcome = await runChecksAndStartScanner({
    env, now, getIdentityFn, fetchFn, spawnFn, platform,
  });
  appendHookLog(path.join(shadowDir(env), HOOK_LOG_FILE), { trigger, ...outcome });
}

if (isMainEntry(import.meta.url)) {
  const trigger = process.argv[2];
  if (trigger === "monitor") {
    // No run at start: the SessionStart hook covers it.
    setInterval(() => {
      // The jf identity is cached per process; drop it to pick up a re-login.
      clearPlatformIdentityCache();
      runLocalShadowTrigger(trigger).catch(() => {});
    }, MONITOR_INTERVAL_MS);
  } else {
    runLocalShadowTrigger(trigger)
      .catch(() => {})
      .finally(() => process.exit(0));
  }
}
