// Shared Agent Guard `--rewrite-mcp-json` runner for harness adapters.
//
// Harness plugins own path discovery; this module owns discover → project/
// server resolution → Step 0 gating → spawn/timeout, and soft-fail
// orchestration. Server id is resolved once for both the gate and AG --server.
//
// Usage (from a thin Cursor/Claude script next to synced modules/):
//   import { runRewriteMcpJsonPipeline } from "./modules/core/rewrite-mcp-json.mjs";
//   await runRewriteMcpJsonPipeline({
//     discover: () => [...absoluteMcpJsonPaths],
//     allowRoots: [...],
//   });
//
// Kill switch: JF_AGENT_REWRITE_MCP_JSON_DISABLE=1 → soft no-op (exit 0).
// Local binary: JFROG_AGENT_GUARD_BIN=/path/to/agent-guard (skips npx).
// Version pin: JFROG_AGENT_GUARD_VERSION (default DEFAULT_AGENT_GUARD_VERSION).

import { spawn } from "node:child_process";
import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { EXIT_ENABLED, runAgentGuardCheck } from "./agent-guard-check.mjs";
import { createLogger } from "./logger.mjs";

const log = createLogger("rewrite-mcp-json");

export const AGENT_GUARD_PACKAGE = "@jfrog/agent-guard";
/** Must stay identical to scripts/claude-mcp-json-discover.mjs REWRITE_DISABLE_ENV. */
export const DISABLE_ENV = "JF_AGENT_REWRITE_MCP_JSON_DISABLE";
export const AGENT_GUARD_BIN_ENV = "JFROG_AGENT_GUARD_BIN";
/** Optional override for the cross-process rewrite lock file path. */
export const REWRITE_LOCK_PATH_ENV = "JF_REWRITE_MCP_JSON_LOCK_PATH";
const DEFAULT_LOCK_BASENAME = "jfrog-agent-rewrite-mcp-json.lock";

/** @type {{ active: boolean, fd: number | null, path: string | null }} */
const pipelineLock = { active: false, fd: null, path: null };

/** Test helper: clear the in-process rewrite concurrency lock. */
export function resetRewritePipelineLockForTests() {
  if (pipelineLock.fd !== null && pipelineLock.path) {
    releaseRewriteLock(pipelineLock.path, pipelineLock.fd);
  }
  pipelineLock.active = false;
  pipelineLock.fd = null;
  pipelineLock.path = null;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveRewriteLockPath(env = process.env) {
  const override = env[REWRITE_LOCK_PATH_ENV]?.trim();
  if (override) return override;
  return path.join(tmpdir(), DEFAULT_LOCK_BASENAME);
}

/**
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {number | null} lock fd, or null if held by another process
 */
export function tryAcquireRewriteLock(lockPath, staleMs) {
  const maxAge =
    staleMs === undefined
      ? DEFAULT_REWRITE_TIMEOUT_MS + DEFAULT_KILL_GRACE_MS
      : staleMs;
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, `${process.pid}\n`);
    } catch {
      // Best-effort pid record.
    }
    return fd;
  } catch (err) {
    if (err?.code !== "EEXIST") {
      log.warn("rewrite lock open failed; proceeding without lock", {
        error: err?.message ?? String(err),
      });
      return -1; // sentinel: lock unavailable, do not block rewrite
    }
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > maxAge) {
        unlinkSync(lockPath);
        return tryAcquireRewriteLock(lockPath, maxAge);
      }
    } catch {
      // ignore
    }
    return null;
  }
}

/**
 * @param {string} lockPath
 * @param {number} fd
 */
export function releaseRewriteLock(lockPath, fd) {
  if (fd >= 0) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

/**
 * @typedef {{
 *   status: 'disabled' | 'busy' | 'skipped' | 'blocked' | 'failed' | 'ok',
 *   rewritten: number,
 *   scanned?: number,
 *   reason?: string,
 * }} RewritePipelineResult
 */

/**
 * @param {Partial<RewritePipelineResult> & { status: RewritePipelineResult['status'] }} partial
 * @returns {RewritePipelineResult}
 */
function pipelineResult(partial) {
  return {
    rewritten: 0,
    ...partial,
  };
}
/**
 * Default npm registry for `npx @jfrog/agent-guard` during mcp.json rewrite.
 *
 * Exception to the usual "no runtime hard-dep on releases.jfrog.io" bundling
 * rule: package-resolution hooks are fully vendored, but Agent Guard's MCP
 * rewrite intentionally fetches `@jfrog/agent-guard` at session start via
 * npx from the public `coding-agents-npm` channel (override with
 * JFROG_AGENT_GUARD_REPO / JFROG_AGENT_GUARD_BIN). See .cursor/rules/bundling.mdc.
 */
export const DEFAULT_AGENT_GUARD_NPM_REGISTRY =
  "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";
/**
 * Pinned so a session start cannot execute whatever the registry currently
 * tags as latest. Bump deliberately; JFROG_AGENT_GUARD_VERSION overrides
 * (including "latest").
 */
export const DEFAULT_AGENT_GUARD_VERSION = "1.6.0";
/** Shared budget for rewriting all discovered files in one hook invocation. */
export const DEFAULT_REWRITE_TIMEOUT_MS = 35_000;
/** SIGTERM → SIGKILL escalation window for a child that ignores the first signal. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

export function isRewriteDisabled(env = process.env) {
  return env[DISABLE_ENV] === "1";
}

/**
 * True when JFROG_URL/JF_URL + access token are set — AG reads env directly,
 * so callers must omit `--server`.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function hasJfrogUrlTokenEnv(env = process.env) {
  const url = env.JFROG_URL?.trim() || env.JF_URL?.trim();
  const token = env.JFROG_ACCESS_TOKEN?.trim() || env.JF_ACCESS_TOKEN?.trim();
  return Boolean(url && token);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Scan mcp.json files for an existing Agent Guard `_JF_ARGS` project= value.
 * @param {string[]} mcpPaths
 * @param {{ readFileSyncFn?: typeof readFileSync }} [opts]
 * @returns {string}
 */
export function scanMcpJsonForProject(mcpPaths, opts = {}) {
  const readFn = opts.readFileSyncFn ?? readFileSync;
  for (const mcpPath of mcpPaths ?? []) {
    const servers = readMcpServers(mcpPath, readFn);
    if (!servers) continue;
    for (const entry of Object.values(servers)) {
      if (!isPlainObject(entry)) continue;
      const envBlock = entry.env;
      if (!isPlainObject(envBlock)) continue;
      const jfArgs = envBlock._JF_ARGS;
      if (typeof jfArgs !== "string") continue;
      const match = /(?:^|&)project=([^&]*)/.exec(jfArgs);
      const project = match?.[1]?.trim();
      if (project) return project;
    }
  }
  return "";
}

/**
 * Scan mcp.json files for an existing Agent Guard `--server <id>` in args.
 * @param {string[]} mcpPaths
 * @param {{ readFileSyncFn?: typeof readFileSync }} [opts]
 * @returns {string}
 */
export function scanMcpJsonForServerId(mcpPaths, opts = {}) {
  const readFn = opts.readFileSyncFn ?? readFileSync;
  for (const mcpPath of mcpPaths ?? []) {
    const servers = readMcpServers(mcpPath, readFn);
    if (!servers) continue;
    for (const entry of Object.values(servers)) {
      if (!isPlainObject(entry)) continue;
      const args = entry.args;
      if (!Array.isArray(args)) continue;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--server" && typeof args[i + 1] === "string") {
          const id = args[i + 1].trim();
          if (id) return id;
        }
      }
    }
  }
  return "";
}

/**
 * @param {string} mcpPath
 * @param {typeof readFileSync} readFn
 * @returns {Record<string, unknown> | null}
 */
function readMcpServers(mcpPath, readFn) {
  try {
    const raw = readFn(mcpPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
      return null;
    }
    return /** @type {Record<string, unknown>} */ (parsed.mcpServers);
  } catch {
    return null;
  }
}

/**
 * Resolve JFrog project key: env → existing AG `_JF_ARGS` → "".
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   mcpPaths?: string[],
 *   readFileSyncFn?: typeof readFileSync,
 * }} [opts]
 * @returns {string}
 */
export function resolveRewriteProject(env = process.env, opts = {}) {
  const fromEnv = env.JF_PROJECT?.trim() || env.JFROG_PROJECT?.trim() || "";
  if (fromEnv) return fromEnv;
  return scanMcpJsonForProject(opts.mcpPaths ?? [], {
    readFileSyncFn: opts.readFileSyncFn,
  });
}

/**
 * Resolve server ID for gate + rewrite (same priority both places):
 * omit when URL+token env → existing AG `--server` in mcp.json →
 * `serverIdHint` → JF_SERVER / JFROG_SERVER_ID → "".
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   mcpPaths?: string[],
 *   readFileSyncFn?: typeof readFileSync,
 *   serverIdHint?: string,
 * }} [opts]
 * @returns {string}
 */
export function resolveRewriteServerId(env = process.env, opts = {}) {
  if (hasJfrogUrlTokenEnv(env)) return "";
  const fromMcp = scanMcpJsonForServerId(opts.mcpPaths ?? [], {
    readFileSyncFn: opts.readFileSyncFn,
  });
  if (fromMcp) return fromMcp;
  const hint = opts.serverIdHint?.trim();
  if (hint) return hint;
  return env.JF_SERVER?.trim() || env.JFROG_SERVER_ID?.trim() || "";
}

/**
 * @param {NodeJS.Platform} [platform]
 */
export function resolveNpxCommand(platform = process.platform) {
  return platform === "win32" ? "npx.cmd" : "npx";
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 * @param {{ local?: boolean }} [opts]
 */
export function buildNpxSpawnOptions(
  env,
  platform = process.platform,
  opts = {},
) {
  const isWin = platform === "win32";
  const useShell = isWin && !opts.local;
  return {
    stdio: /** @type {const} */ (["pipe", "pipe", "pipe"]),
    env,
    // Pin cmd.exe — shell: true would honor ComSpec (e.g. PowerShell).
    shell: useShell ? "cmd.exe" : false,
    detached: !isWin,
  };
}

/**
 * Safe grammar for JF project keys / server IDs passed on a Windows cmd.exe
 * command line (and as a general injection guard on all platforms).
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeRewriteIdentifier(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value ?? ""));
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {string}
 * @throws {Error} when value is not a safe identifier
 */
export function assertSafeRewriteIdentifier(value, label = "identifier") {
  const trimmed = String(value ?? "").trim();
  if (!isSafeRewriteIdentifier(trimmed)) {
    throw new Error(
      `rewrite-mcp-json ${label} must be a safe identifier (A-Za-z0-9._-): ${JSON.stringify(trimmed)}`,
    );
  }
  return trimmed;
}

/**
 * Quote a single argv token for Node spawn under shell: "cmd.exe".
 * Uses cmd.exe rules: wrap in ", double embedded quotes, escape % as %%.
 * CRT-style backslash-escaping is NOT safe under cmd.exe (a quote can break
 * out and leave metacharacters like & executable).
 * @param {string} arg
 * @returns {string}
 * @throws {Error} when the arg contains CR/LF
 */
export function quoteWindowsArg(arg) {
  const value = String(arg ?? "");
  if (/[\r\n]/.test(value)) {
    throw new Error("Windows spawn arg must not contain CR/LF");
  }
  // Neutralize %VAR% expansion, then double any embedded quotes for cmd.exe.
  const escaped = value.replace(/%/g, "%%").replace(/"/g, '""');
  return `"${escaped}"`;
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
export async function killRewriteChildTree(child, opts = {}) {
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
          const killer = spawnFn(
            "taskkill",
            ["/pid", String(child.pid), "/T", "/F"],
            { stdio: "ignore" },
          );
          killer?.on?.("error", () => {});
          return;
        } catch {
          // fall through
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

  log.warn("rewrite child ignored SIGTERM; escalating to SIGKILL", {
    graceMs,
  });
  signalTree("SIGKILL");
}

/**
 * @param {Promise<unknown> | undefined} exited
 * @param {number} graceMs
 */
function waitForExitOrTimeout(exited, graceMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs);
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
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAgentGuardNpmRegistry(env = process.env) {
  const fromEnv = env.JFROG_AGENT_GUARD_REPO?.trim();
  return fromEnv || DEFAULT_AGENT_GUARD_NPM_REGISTRY;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAgentGuardSpec(env = process.env) {
  const version =
    env.JFROG_AGENT_GUARD_VERSION?.trim() || DEFAULT_AGENT_GUARD_VERSION;
  return `${AGENT_GUARD_PACKAGE}@${version}`;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | undefined}
 */
export function resolveAgentGuardBin(env = process.env) {
  return env[AGENT_GUARD_BIN_ENV]?.trim() || undefined;
}

/**
 * @param {{
 *   paths: string[],
 *   project?: string,
 *   serverId?: string,
 *   allowRoots?: string[],
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {string[]}
 * @throws {Error} when project is missing or paths are empty
 */
export function buildAgentGuardRewriteArgs(opts) {
  const env = opts.env ?? process.env;
  const paths = opts.paths ?? [];
  if (paths.length === 0) {
    throw new Error("rewrite-mcp-json requires at least one mcp.json path");
  }
  const project =
    opts.project?.trim() || resolveRewriteProject(env, { mcpPaths: paths });
  if (!project) {
    throw new Error("rewrite-mcp-json requires --project (or JF_PROJECT)");
  }
  assertSafeRewriteIdentifier(project, "project");

  const args = ["--rewrite-mcp-json", ...paths, "--project", project];

  const server =
    opts.serverId !== undefined
      ? opts.serverId.trim()
      : resolveRewriteServerId(env, { mcpPaths: paths });
  if (server) {
    assertSafeRewriteIdentifier(server, "server");
    args.push("--server", server);
  }

  const agentGuardRegistry = env.JFROG_AGENT_GUARD_REPO?.trim();
  if (agentGuardRegistry) {
    args.push("--registry", agentGuardRegistry);
  }

  for (const root of opts.allowRoots ?? []) {
    if (root) args.push("--allow-root", root);
  }

  args.push("--format", "json");
  return args;
}

/**
 * @param {{
 *   paths: string[],
 *   project?: string,
 *   serverId?: string,
 *   allowRoots?: string[],
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {string[]}
 */
export function buildNpxArgs(opts) {
  const env = opts.env ?? process.env;
  return [
    "--yes",
    "--registry",
    resolveAgentGuardNpmRegistry(env),
    resolveAgentGuardSpec(env),
    ...buildAgentGuardRewriteArgs(opts),
  ];
}

/**
 * @param {{
 *   paths: string[],
 *   project?: string,
 *   serverId?: string,
 *   allowRoots?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 * }} opts
 * @returns {{ command: string, args: string[], local: boolean }}
 */
export function resolveAgentGuardCommand(opts) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const bin = resolveAgentGuardBin(env);
  if (bin) {
    return {
      command: bin,
      args: buildAgentGuardRewriteArgs(opts),
      local: true,
    };
  }
  return {
    command: resolveNpxCommand(platform),
    args: buildNpxArgs(opts),
    local: false,
  };
}

/**
 * Spawn Agent Guard `--rewrite-mcp-json`. AG writes files; stdout is JSON
 * summary when `--format json` is passed.
 * @param {{
 *   paths: string[],
 *   project?: string,
 *   serverId?: string,
 *   allowRoots?: string[],
 *   spawnFn?: typeof spawn,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   graceMs?: number,
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 * }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runAgentGuardRewriteMcpJson(opts) {
  const spawnFn = opts.spawnFn ?? spawn;
  const env = opts.env ?? process.env;
  const timeoutMs =
    opts.timeoutMs === undefined ? DEFAULT_REWRITE_TIMEOUT_MS : opts.timeoutMs;
  const platform = opts.platform ?? process.platform;

  let command;
  let args;
  let spawnOpts;
  try {
    const resolved = resolveAgentGuardCommand({
      paths: opts.paths,
      project: opts.project,
      serverId: opts.serverId,
      allowRoots: opts.allowRoots,
      env,
      platform,
    });
    command = resolved.command;
    spawnOpts = buildNpxSpawnOptions(env, platform, { local: resolved.local });
    args = spawnOpts.shell
      ? quoteSpawnArgs(resolved.args, platform)
      : resolved.args;
  } catch (err) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: err?.message ?? String(err),
    });
  }

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

    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
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
      if (timedOut) return;
      finish({ code: code ?? 1, stdout, stderr });
    });

    child.stdin?.on?.("error", () => {});
    try {
      child.stdin?.end();
    } catch {
      // Child may already have exited.
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const finishTimedOut = () => {
          finish({
            code: 1,
            stdout,
            stderr: `${stderr ? `${stderr.trim()}\n` : ""}rewrite timed out after ${timeoutMs}ms`,
          });
        };
        killRewriteChildTree(child, {
          platform,
          killFn: opts.killFn,
          spawnFn,
          graceMs: opts.graceMs,
          isAlive: () => !exited,
          waitForExit: exitedPromise,
        }).then(finishTimedOut, finishTimedOut);
      }, timeoutMs);
    }
  });
}

/**
 * @param {string} raw
 * @returns {{ scanned?: number, rewritten?: number, files?: string[], errors?: string[], dryRun?: boolean } | null}
 */
export function parseRewriteMcpJsonResult(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Strip userinfo from URLs before logging.
 * @param {string} text
 * @returns {string}
 */
export function redactUrlCredentials(text) {
  return String(text ?? "").replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
    "$1***@",
  );
}

/**
 * Orchestration: kill switch → discover → project/server → Step 0 gate →
 * rewrite. Server id is resolved once and reused for both the gate and AG
 * `--server`. Soft-fail: never throws for expected skip/block/fail paths.
 * Cross-process file lock (+ in-process guard) returns `{ status: "busy" }`
 * so SessionStart + FileChanged cannot rewrite the same files in parallel.
 * Harness adapters supply discovery + allow-roots.
 *
 * @param {{
 *   discover: () => string[] | Promise<string[]>,
 *   allowRoots?: string[] | ((paths: string[]) => string[]),
 *   env?: NodeJS.ProcessEnv,
 *   spawnFn?: typeof spawn,
 *   timeoutMs?: number,
 *   graceMs?: number,
 *   platform?: NodeJS.Platform,
 *   killFn?: (pid: number, signal?: string) => true,
 *   runAgentGuardCheckFn?: typeof runAgentGuardCheck,
 *   readFileSyncFn?: typeof readFileSync,
 *   serverIdHint?: string,
 * }} opts
 * @returns {Promise<RewritePipelineResult>}
 */
export async function runRewriteMcpJsonPipeline(opts) {
  const env = opts.env ?? process.env;
  const checkFn = opts.runAgentGuardCheckFn ?? runAgentGuardCheck;

  if (isRewriteDisabled(env)) {
    log.info("rewrite disabled via env", { env: DISABLE_ENV });
    return pipelineResult({ status: "disabled" });
  }

  if (pipelineLock.active) {
    log.info("rewrite already in progress; soft no-op");
    return pipelineResult({ status: "busy" });
  }

  const lockPath = resolveRewriteLockPath(env);
  const staleMs =
    (opts.timeoutMs === undefined ? DEFAULT_REWRITE_TIMEOUT_MS : opts.timeoutMs) +
    (opts.graceMs === undefined ? DEFAULT_KILL_GRACE_MS : opts.graceMs);
  const lockFd = tryAcquireRewriteLock(lockPath, staleMs);
  if (lockFd === null) {
    log.info("rewrite lock held; soft no-op", { lockPath });
    return pipelineResult({ status: "busy" });
  }

  pipelineLock.active = true;
  pipelineLock.fd = lockFd >= 0 ? lockFd : null;
  pipelineLock.path = lockFd >= 0 ? lockPath : null;

  try {
    return await runRewriteMcpJsonPipelineLocked(opts, env, checkFn);
  } finally {
    if (lockFd >= 0) {
      releaseRewriteLock(lockPath, lockFd);
    }
    pipelineLock.active = false;
    pipelineLock.fd = null;
    pipelineLock.path = null;
  }
}

/**
 * @param {Parameters<typeof runRewriteMcpJsonPipeline>[0]} opts
 * @param {NodeJS.ProcessEnv} env
 * @param {typeof runAgentGuardCheck} checkFn
 * @returns {Promise<RewritePipelineResult>}
 */
async function runRewriteMcpJsonPipelineLocked(opts, env, checkFn) {
  let paths;
  try {
    paths = await opts.discover();
  } catch (err) {
    log.error("discover failed; soft no-op", {
      error: err?.message ?? String(err),
    });
    return pipelineResult({
      status: "failed",
      reason: err?.message ?? String(err),
    });
  }

  if (!Array.isArray(paths) || paths.length === 0) {
    log.info("no mcp.json files found; skip rewrite");
    return pipelineResult({ status: "skipped", reason: "no mcp.json files" });
  }

  const project = resolveRewriteProject(env, {
    mcpPaths: paths,
    readFileSyncFn: opts.readFileSyncFn,
  });
  if (!project) {
    log.info("rewrite skipped; missing JF_PROJECT", {});
    return pipelineResult({ status: "skipped", reason: "missing JF_PROJECT" });
  }
  if (!isSafeRewriteIdentifier(project)) {
    log.info("rewrite skipped; unsafe JF_PROJECT", {});
    return pipelineResult({ status: "skipped", reason: "unsafe JF_PROJECT" });
  }

  const serverId = resolveRewriteServerId(env, {
    mcpPaths: paths,
    readFileSyncFn: opts.readFileSyncFn,
    serverIdHint: opts.serverIdHint,
  });
  if (serverId && !isSafeRewriteIdentifier(serverId)) {
    log.info("rewrite skipped; unsafe server id", {});
    return pipelineResult({ status: "skipped", reason: "unsafe server id" });
  }

  const gate = await checkFn({
    serverId: serverId || undefined,
    env,
  });
  if (gate.code !== EXIT_ENABLED) {
    log.info("agent-guard check blocked rewrite; soft no-op", {
      code: gate.code,
      reason: redactUrlCredentials(gate.reason ?? ""),
    });
    return pipelineResult({
      status: "blocked",
      reason: redactUrlCredentials(gate.reason ?? ""),
    });
  }

  const allowRoots =
    typeof opts.allowRoots === "function"
      ? opts.allowRoots(paths)
      : (opts.allowRoots ?? []);

  log.info("rewrite-mcp-json targets", {
    count: paths.length,
    allowRoots: allowRoots.length,
  });

  const budgetMs =
    opts.timeoutMs === undefined ? DEFAULT_REWRITE_TIMEOUT_MS : opts.timeoutMs;
  const startedAtMs = Date.now();
  const result = await runAgentGuardRewriteMcpJson({
    paths,
    project,
    serverId,
    allowRoots,
    env,
    spawnFn: opts.spawnFn,
    timeoutMs: budgetMs,
    graceMs: opts.graceMs,
    platform: opts.platform,
    killFn: opts.killFn,
  });
  const durMs = Date.now() - startedAtMs;

  if (result.code !== 0) {
    log.error("rewrite-mcp-json failed", {
      code: result.code,
      stderr: redactUrlCredentials((result.stderr || "").trim()).slice(0, 500),
      durMs,
    });
    return pipelineResult({
      status: "failed",
      reason: redactUrlCredentials((result.stderr || "").trim()).slice(0, 200),
    });
  }

  const summary = parseRewriteMcpJsonResult(result.stdout);
  const rewritten =
    typeof summary?.rewritten === "number" ? summary.rewritten : 0;
  const scanned = typeof summary?.scanned === "number" ? summary.scanned : undefined;
  if (summary) {
    log.info("rewrite-mcp-json ok", {
      scanned: summary.scanned,
      rewritten: summary.rewritten,
      errors: summary.errors?.length ?? 0,
      durMs,
    });
  } else {
    log.info("rewrite-mcp-json ok; no JSON summary", { durMs });
  }

  return pipelineResult({
    status: "ok",
    rewritten,
    scanned,
  });
}
