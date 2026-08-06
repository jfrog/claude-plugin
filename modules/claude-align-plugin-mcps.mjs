#!/usr/bin/env node
// Claude Code SessionStart / FileChanged adapter for Agent Guard plugin MCP align.
//
// Usage:
//   node claude-align-plugin-mcps.mjs session-start
//   node claude-align-plugin-mcps.mjs file-changed
//
// Spawns `npx @jfrog/agent-guard --align-plugin-mcps --format hook-…` and
// passthroughs stdout unchanged (watchPaths / systemMessage / additionalContext
// are owned by agent-guard). Never exits non-zero — a failed align must not
// break the Claude session.
//
// On SessionStart failure (or empty agent-guard stdout), still emits a fallback
// watchPaths payload so FileChanged keeps watching plugin install metadata.
//
// Kill switch: JF_AGENT_ALIGN_PLUGIN_MCPS_DISABLE=1 → no-op (exit 0, no stdout).

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createLogger, setLogContext } from "./core/logger.mjs";
import { readStdin, parseSessionId } from "./core/io.mjs";

const HARNESS_ID = "claude_code";
const log = createLogger("align-plugin-mcps");

export const AGENT_GUARD_PACKAGE = "@jfrog/agent-guard";
export const DISABLE_ENV = "JF_AGENT_ALIGN_PLUGIN_MCPS_DISABLE";
export const DEFAULT_AGENT_GUARD_NPM_REGISTRY =
  "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";

/** @type {Readonly<Record<string, string>>} */
export const MODES = Object.freeze({
  "session-start": "hook-session-start",
  "file-changed": "hook-file-changed",
});

export function isAlignDisabled(env = process.env) {
  return env[DISABLE_ENV] === "1";
}

/**
 * Claude plugins metadata directory (`installed_plugins.json`, etc.).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePluginsDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude");
  return path.join(configDir, "plugins");
}

/**
 * Minimal SessionStart JSON so FileChanged can watch plugin install metadata
 * even when agent-guard is unavailable or returns empty stdout.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildSessionStartWatchPayload(env = process.env) {
  const dir = resolvePluginsDir(env);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      watchPaths: [
        path.join(dir, "installed_plugins.json"),
        path.join(dir, "known_marketplaces.json"),
      ],
    },
  });
}

/**
 * Resolve the npm registry used to download @jfrog/agent-guard for this hook.
 * Matches the skill / agent-guard default when JFROG_AGENT_GUARD_REPO is unset.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAgentGuardNpmRegistry(env = process.env) {
  const fromEnv = env.JFROG_AGENT_GUARD_REPO?.trim();
  return fromEnv || DEFAULT_AGENT_GUARD_NPM_REGISTRY;
}

/**
 * @param {string} format — hook-session-start | hook-file-changed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function buildNpxArgs(format, env = process.env) {
  const args = [
    "--yes",
    "--registry",
    resolveAgentGuardNpmRegistry(env),
    AGENT_GUARD_PACKAGE,
    "--align-plugin-mcps",
    "--format",
    format,
  ];

  const project = env.JF_PROJECT?.trim();
  if (project) {
    args.push("--project", project);
  }

  const claudeConfigDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfigDir) {
    args.push("--claude-config-dir", claudeConfigDir);
  }

  // When a private registry is set, also pass it to agent-guard (not only npx).
  const agentGuardRegistry = env.JFROG_AGENT_GUARD_REPO?.trim();
  if (agentGuardRegistry) {
    args.push("--registry", agentGuardRegistry);
  }

  return args;
}

/**
 * @param {string} format
 * @param {{ spawnFn?: typeof spawn, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runAgentGuardAlign(format, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  const env = opts.env ?? process.env;
  const args = buildNpxArgs(format, env);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawnFn("npx", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } catch (err) {
      finish({
        code: 1,
        stdout: "",
        stderr: err?.message ?? String(err),
      });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({
        code: 1,
        stdout,
        stderr: err?.message ?? String(err),
      });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * @param {string | undefined} modeArg
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   spawnFn?: typeof spawn,
 *   writeStdout?: (s: string) => void,
 *   readStdinFn?: () => Promise<string>,
 * }} [deps]
 * @returns {Promise<number>} always 0
 */
export async function runAlignHook(modeArg, deps = {}) {
  const env = deps.env ?? process.env;
  const writeStdout = deps.writeStdout ?? ((s) => process.stdout.write(s));
  const readStdinFn = deps.readStdinFn ?? readStdin;
  const format = MODES[modeArg];
  const isSessionStart = format === "hook-session-start";

  // Drain Claude hook stdin so the parent does not hang on a live pipe.
  const stdinRaw = await readStdinFn();
  setLogContext({ ide: HARNESS_ID, sessionId: parseSessionId(stdinRaw) });

  if (!format) {
    log.warn("unknown mode; no-op", { mode: modeArg ?? "" });
    return 0;
  }

  if (isAlignDisabled(env)) {
    log.info("align disabled via env", { env: DISABLE_ENV });
    return 0;
  }

  const startedAtMs = Date.now();
  const result = await runAgentGuardAlign(format, {
    spawnFn: deps.spawnFn,
    env,
  });
  const durMs = Date.now() - startedAtMs;

  if (result.code !== 0) {
    log.error("align-plugin-mcps failed", {
      format,
      code: result.code,
      stderr: (result.stderr || "").trim().slice(0, 500),
      durMs,
    });
    // Keep FileChanged watching even when npx/agent-guard is unavailable.
    if (isSessionStart) {
      writeStdout(buildSessionStartWatchPayload(env));
    }
    return 0;
  }

  if (result.stdout) {
    writeStdout(result.stdout);
  } else if (isSessionStart) {
    writeStdout(buildSessionStartWatchPayload(env));
  }
  log.info("align-plugin-mcps ok", {
    format,
    bytes: result.stdout.length,
    durMs,
  });
  return 0;
}

async function main() {
  await runAlignHook(process.argv[2]);
  process.exit(0);
}

function isExecutedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    log.error("unexpected failure", { error: err?.message ?? String(err) });
    process.exit(0);
  });
}
