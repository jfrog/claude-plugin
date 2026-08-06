#!/usr/bin/env node
// Claude Code SessionStart / FileChanged adapter for Agent Guard plugin MCP align.
//
// Usage:
//   node claude-align-plugin-mcps.mjs session-start
//   node claude-align-plugin-mcps.mjs file-changed
//
// Spawns `npx @jfrog/agent-guard --align-plugin-mcps --format hook-…` and
// passthroughs stdout unchanged (watchPaths / systemMessage / additionalContext
// are owned by agent-guard). Claude hook stdin is forwarded to agent-guard so
// FileChanged payloads (changed paths, etc.) are available. Never exits
// non-zero — a failed align must not break the Claude session.
//
// On SessionStart failure (or empty agent-guard stdout), still emits a fallback
// watchPaths payload so FileChanged keeps watching plugin install metadata.
//
// The npx child is killed if it exceeds DEFAULT_ALIGN_TIMEOUT_MS (under the
// SessionStart/FileChanged hook timeout in hooks/hooks.json). On POSIX the child
// runs in its own process group so SIGTERM reaches npx and its download
// grandchildren; on Windows we shell-spawn npx.cmd and kill that process.
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
/** Under hooks.json align timeouts (45s) so we can SIGTERM before Claude kills us. */
export const DEFAULT_ALIGN_TIMEOUT_MS = 40_000;

/** @type {Readonly<Record<string, string>>} */
export const MODES = Object.freeze({
  "session-start": "hook-session-start",
  "file-changed": "hook-file-changed",
});

export function isAlignDisabled(env = process.env) {
  return env[DISABLE_ENV] === "1";
}

/**
 * npx is a .cmd shim on Windows and cannot be spawned without a shell / .cmd name.
 * @param {NodeJS.Platform} [platform]
 */
export function resolveNpxCommand(platform = process.platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 */
export function buildNpxSpawnOptions(env, platform = process.platform) {
  const isWin = platform === "win32";
  return {
    stdio: /** @type {const} */ (["pipe", "pipe", "pipe"]),
    env,
    // Resolve npx.cmd via cmd.exe; bare spawn("npx") often ENOENTs on Windows.
    shell: isWin,
    // Own process group on POSIX so timeout can SIGTERM the whole npx tree.
    detached: !isWin,
  };
}

/**
 * Kill npx and (on POSIX) its process-group children after an align timeout.
 * @param {{ pid?: number, kill?: (signal?: string) => boolean }} child
 * @param {{
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 * }} [opts]
 */
export function killAlignChildTree(child, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const killFn = opts.killFn ?? process.kill;

  if (platform !== "win32" && child?.pid) {
    try {
      killFn(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to child.kill when the group is already gone.
    }
  }

  try {
    child?.kill?.("SIGTERM");
  } catch {
    // ignore
  }
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
 * @param {{
 *   spawnFn?: typeof spawn,
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: string,
 *   timeoutMs?: number,
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 * }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runAgentGuardAlign(format, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn;
  const env = opts.env ?? process.env;
  const stdin = opts.stdin ?? "";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ALIGN_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  const args = buildNpxArgs(format, env);
  const command = resolveNpxCommand(platform);
  const spawnOpts = buildNpxSpawnOptions(env, platform);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawnFn(command, args, spawnOpts);
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

    try {
      child.stdin?.end(stdin);
    } catch {
      // Child may already have exited; close/error handlers settle the promise.
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killAlignChildTree(child, {
          platform,
          killFn: opts.killFn,
        });
        finish({
          code: 1,
          stdout,
          stderr: `${stderr ? `${stderr.trim()}\n` : ""}align timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }
  });
}

/**
 * @param {string | undefined} modeArg
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   spawnFn?: typeof spawn,
 *   writeStdout?: (s: string) => void,
 *   readStdinFn?: () => Promise<string>,
 *   timeoutMs?: number,
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 * }} [deps]
 * @returns {Promise<number>} always 0
 */
export async function runAlignHook(modeArg, deps = {}) {
  const env = deps.env ?? process.env;
  const writeStdout = deps.writeStdout ?? ((s) => process.stdout.write(s));
  const readStdinFn = deps.readStdinFn ?? readStdin;
  const format = MODES[modeArg];
  const isSessionStart = format === "hook-session-start";

  // Drain Claude hook stdin so the parent does not hang on a live pipe, then
  // forward it to agent-guard (FileChanged includes the changed path).
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
    stdin: stdinRaw,
    timeoutMs: deps.timeoutMs,
    platform: deps.platform,
    killFn: deps.killFn,
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
