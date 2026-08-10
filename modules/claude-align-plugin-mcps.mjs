#!/usr/bin/env node
// Claude Code SessionStart / FileChanged adapter for Agent Guard plugin MCP align.
//
// Usage:
//   node claude-align-plugin-mcps.mjs session-start
//   node claude-align-plugin-mcps.mjs file-changed
//
// Spawns `npx @jfrog/agent-guard@<pinned> --align-plugin-mcps --format hook-…`
// and passthroughs its stdout (watchPaths / systemMessage / additionalContext
// are owned by agent-guard) once it validates as a JSON object. Claude hook
// stdin is forwarded to agent-guard so FileChanged payloads (changed paths,
// etc.) are available. Never exits non-zero — a failed align must not break the
// Claude session.
//
// On SessionStart failure (empty, malformed, or non-zero agent-guard output),
// still emits a fallback watchPaths payload so FileChanged keeps watching plugin
// install metadata.
//
// The npx child is killed if it exceeds DEFAULT_ALIGN_TIMEOUT_MS (under
// RECOMMENDED_HOOK_TIMEOUT_SEC, with room for the kill grace period). On POSIX
// the child runs in its own process group so SIGTERM reaches npx and its
// download grandchildren; on Windows we shell-spawn npx.cmd and `taskkill /T`
// the tree, since cmd.exe does not cascade signals. A child that ignores the
// first signal is SIGKILLed after DEFAULT_KILL_GRACE_MS.
//
// Kill switch: JF_AGENT_ALIGN_PLUGIN_MCPS_DISABLE=1 → no-op (exit 0, no stdout).

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { createLogger, setLogContext } from "./core/logger.mjs";
import { readStdin, parseSessionId, detectHarness, isCompletePayload } from "./core/io.mjs";
import { isMainEntry } from "./core/entry.mjs";

const HARNESS_ID = "claude_code";
const log = createLogger("align-plugin-mcps");

export const AGENT_GUARD_PACKAGE = "@jfrog/agent-guard";
export const DISABLE_ENV = "JF_AGENT_ALIGN_PLUGIN_MCPS_DISABLE";
export const DEFAULT_AGENT_GUARD_NPM_REGISTRY =
  "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";
/**
 * Pinned so a session start cannot execute whatever the registry currently
 * tags as latest. Bump deliberately; JFROG_AGENT_GUARD_VERSION overrides it
 * (including to "latest") for teams that track their own mirror.
 */
export const DEFAULT_AGENT_GUARD_VERSION = "1.5.1";
/**
 * Recommended Claude `hooks.json` timeout (seconds) for both SessionStart and
 * FileChanged align entries. Plugins own hooks.json — keep their `timeout`
 * at or above this so the module can self-terminate (timeout + kill grace)
 * before Claude kills the hook.
 */
export const RECOMMENDED_HOOK_TIMEOUT_SEC = 15;
/** Under RECOMMENDED_HOOK_TIMEOUT_SEC, leaving room for the kill grace. */
export const DEFAULT_ALIGN_TIMEOUT_MS = 10_000;
/** SIGTERM → SIGKILL escalation window for a child that ignores the first signal. */
export const DEFAULT_KILL_GRACE_MS = 2_000;
/**
 * Recommended FileChanged matcher for installed-plugin metadata. Dots are
 * escaped and the pattern is anchored so Claude's regex mode does not treat
 * `.` as "any character" or match `*.json.bak` suffixes.
 */
export const RECOMMENDED_FILE_CHANGED_MATCHER =
  "(installed_plugins|known_marketplaces)\\.json$";

/** @type {Readonly<Record<string, string>>} */
export const MODES = Object.freeze({
  "session-start": "hook-session-start",
  "file-changed": "hook-file-changed",
});

/**
 * Mode lookup that cannot resolve inherited Object.prototype members
 * ("toString", "constructor", …) into a truthy format.
 * @param {string | undefined} modeArg
 * @returns {string | undefined}
 */
export function resolveMode(modeArg) {
  if (typeof modeArg !== "string") return undefined;
  return Object.hasOwn(MODES, modeArg) ? MODES[modeArg] : undefined;
}

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

/** cmd.exe metacharacters, which survive Node's arg join under shell: true. */
const WINDOWS_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote one argument for the cmd.exe command line Node builds when spawning
 * with shell: true, which otherwise joins args on spaces with no quoting — so
 * an ordinary path like `C:\Users\John Smith\.claude` arrives split in two.
 *
 * Two layers, in order: CRT quoting so the target program re-splits the arg as
 * one token, then caret escapes so cmd.exe passes those quotes (and any of its
 * own metacharacters) through untouched.
 *
 * @param {string} arg
 * @returns {string}
 */
export function quoteWindowsArg(arg) {
  const value = String(arg ?? "");
  const crtQuoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return crtQuoted.replace(WINDOWS_META_CHARS, "^$1");
}

/**
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function quoteSpawnArgs(args, platform = process.platform) {
  return platform === "win32" ? args.map(quoteWindowsArg) : args;
}

/**
 * Terminate the align child and its download grandchildren after a timeout.
 *
 * POSIX signals the child's own process group. Windows has no process groups
 * to signal and cmd.exe (the immediate child under shell: true) does not
 * cascade a kill to the npx.cmd / node.exe it launched, so the tree is torn
 * down with `taskkill /T`. Either way a child still alive after graceMs is
 * SIGKILLed, and the returned promise settles only once that has happened —
 * the caller must not exit while a stuck npx is still running.
 *
 * @param {{ pid?: number, kill?: (signal?: string) => boolean }} child
 * @param {{
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 *   spawnFn?: typeof spawn,
 *   graceMs?: number,
 *   isAlive?: () => boolean,
 *   waitForExit?: Promise<unknown>,
 * }} [opts]
 * @returns {Promise<void>}
 */
export async function killAlignChildTree(child, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const killFn = opts.killFn ?? process.kill;
  const spawnFn = opts.spawnFn ?? spawn;
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const isAlive = opts.isAlive ?? (() => true);

  const signalChild = (signal) => {
    try {
      child?.kill?.(signal);
    } catch {
      // Already gone.
    }
  };

  const signalTree = (signal) => {
    if (platform === "win32") {
      if (child?.pid) {
        try {
          spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
          return;
        } catch {
          // taskkill unavailable — fall through to the direct kill.
        }
      }
      signalChild(signal);
      return;
    }

    if (child?.pid) {
      try {
        killFn(-child.pid, signal);
        return;
      } catch {
        // Fall through to child.kill when the group is already gone.
      }
    }
    signalChild(signal);
  };

  signalTree("SIGTERM");

  if (graceMs <= 0 || !isAlive()) return;
  await waitForExitOrTimeout(opts.waitForExit, graceMs);
  if (!isAlive()) return;

  log.warn("align child ignored SIGTERM; escalating to SIGKILL", { graceMs });
  signalTree("SIGKILL");
}

/**
 * @param {Promise<unknown> | undefined} exited
 * @param {number} graceMs
 */
function waitForExitOrTimeout(exited, graceMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    timer.unref?.();
    exited?.then(
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
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
 * The exact `npx` package spec to execute, pinned by default so the version
 * this hook runs on every session start is the one that was reviewed.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAgentGuardSpec(env = process.env) {
  const version = env.JFROG_AGENT_GUARD_VERSION?.trim() || DEFAULT_AGENT_GUARD_VERSION;
  return `${AGENT_GUARD_PACKAGE}@${version}`;
}

/**
 * Agent-guard output is written to Claude verbatim, so it must at least be a
 * JSON object — npm noise or a malformed release would otherwise break the
 * session instead of falling back.
 * @param {string} raw
 */
export function isValidAlignPayload(raw) {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
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
    resolveAgentGuardSpec(env),
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
 *   graceMs?: number,
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
  const args = quoteSpawnArgs(buildNpxArgs(format, env), platform);
  const command = resolveNpxCommand(platform);
  const spawnOpts = buildNpxSpawnOptions(env, platform);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exited = false;
    let timedOut = false;
    let markExited = () => {};
    const exitedPromise = new Promise((r) => {
      markExited = r;
    });
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
      exited = true;
      markExited();
      finish({
        code: 1,
        stdout,
        stderr: err?.message ?? String(err),
      });
    });
    child.on("close", (code) => {
      exited = true;
      markExited();
      // The timeout path owns the result once it has started killing the tree.
      if (timedOut) return;
      finish({ code: code ?? 1, stdout, stderr });
    });

    try {
      child.stdin?.end(stdin);
    } catch {
      // Child may already have exited; close/error handlers settle the promise.
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const finishTimedOut = () => {
          finish({
            code: 1,
            stdout,
            stderr: `${stderr ? `${stderr.trim()}\n` : ""}align timed out after ${timeoutMs}ms`,
          });
        };
        killAlignChildTree(child, {
          platform,
          killFn: opts.killFn,
          spawnFn,
          graceMs: opts.graceMs,
          isAlive: () => !exited,
          waitForExit: exitedPromise,
          // A kill that itself fails must still settle the align.
        }).then(finishTimedOut, finishTimedOut);
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
 *   graceMs?: number,
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 * }} [deps]
 * @returns {Promise<number>} always 0
 */
export async function runAlignHook(modeArg, deps = {}) {
  const env = deps.env ?? process.env;
  const writeStdout = deps.writeStdout ?? ((s) => process.stdout.write(s));
  const readStdinFn = deps.readStdinFn ?? readStdin;
  const format = resolveMode(modeArg);
  const isSessionStart = format === "hook-session-start";

  // Drain Claude hook stdin so the parent does not hang on a live pipe, then
  // forward it to agent-guard (FileChanged includes the changed path).
  const stdinRaw = await readStdinFn();
  setLogContext({ ide: HARNESS_ID, sessionId: parseSessionId(stdinRaw) });

  const harness = detectHarness(stdinRaw);
  if (harness && harness !== HARNESS_ID) {
    log.info("invoked by another harness; no-op", { harness });
    return 0;
  }

  if (!format) {
    log.warn("unknown mode; no-op", { mode: modeArg ?? "" });
    return 0;
  }

  if (isAlignDisabled(env)) {
    log.info("align disabled via env", { env: DISABLE_ENV });
    return 0;
  }

  // Only hand agent-guard a payload we know is whole: readStdin() settles on an
  // idle gap, so a partial read would arrive as a silently truncated payload.
  // Aligning without it is degraded but correct; aligning on half of it is not.
  const stdinForChild = !stdinRaw || isCompletePayload(stdinRaw) ? stdinRaw : "";
  if (stdinRaw && !stdinForChild) {
    log.warn("hook stdin was incomplete; aligning without it", {
      bytes: stdinRaw.length,
    });
  }

  const startedAtMs = Date.now();
  const result = await runAgentGuardAlign(format, {
    spawnFn: deps.spawnFn,
    env,
    stdin: stdinForChild,
    timeoutMs: deps.timeoutMs,
    graceMs: deps.graceMs,
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

  if (isValidAlignPayload(result.stdout)) {
    writeStdout(result.stdout);
    log.info("align-plugin-mcps ok", {
      format,
      bytes: result.stdout.length,
      durMs,
    });
    return 0;
  }

  if (result.stdout) {
    log.error("align-plugin-mcps returned non-JSON stdout; discarding", {
      format,
      stdout: result.stdout.trim().slice(0, 200),
      durMs,
    });
  }
  if (isSessionStart) {
    writeStdout(buildSessionStartWatchPayload(env));
  }
  return 0;
}

async function main() {
  await runAlignHook(process.argv[2]);
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
