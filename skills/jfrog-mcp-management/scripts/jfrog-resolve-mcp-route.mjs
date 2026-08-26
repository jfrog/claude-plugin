#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Remote MCP Gateway route resolver.
//
// Gated pre-step for Step 3.5 of the jfrog-mcp-management Install flow. Asks
// the JFrog eligibility endpoint whether a remote MCP can be served by the
// Remote MCP Gateway and, on a yes, emits the exact config entry to write.
// The decision is made once, at add time; it is never re-evaluated at runtime.
//
// Contract (key off the EXIT CODE, never the text):
//   - exit 0 -> route=legacy   (write today's Agent Guard stdio entry)
//   - exit 3 -> route=gateway  (write the emitted `entry=` JSON verbatim)
//   - exit 4 -> route=exists   (entry already configured; write nothing)
//   - any other code -> legacy, so the specific numbers are never load-bearing.
//
// Fails closed to legacy: gate off, non-Claude harness, local MCP, missing
// arguments, unresolvable credentials, non-2XX, unparseable body, missing
// field, network error, timeout, and any unexpected throw all exit 0.
//
// This script decides; it never edits a file. The negative verdict's `reason`
// is deliberately not read, so nothing about WHY an MCP is ineligible reaches
// stdout. Set JF_MCP_ROUTE_DEBUG=true for tracing on stderr; the JFrog access
// token is never printed, traced, or included in any output.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// GET <base>/ai-catalog/mcp-gateway/{project}/{mcp-id}/eligibility
export const ELIGIBILITY_PREFIX = "/ai-catalog/mcp-gateway/";
export const ELIGIBILITY_SUFFIX = "/eligibility";
// The entry the Gateway is reached through: <jpd>/mcp/{project}/{mcp-id}
export const GATEWAY_PREFIX = "/mcp/";
export const REQUEST_TIMEOUT_MS = 5000;

export const EXIT_LEGACY = 0;
export const EXIT_GATEWAY = 3;
export const EXIT_EXISTS = 4;

// Every environment variable this script reads, in one place. The two gate
// keys are exported because they are this feature's contract (see
// references/gateway-routing.md); the rest are internal.
export const ENV_GATE_FLAG = "REMOTE_GW_ELIGIBILITY_ENABLED";
export const ENV_ELIGIBILITY_BASE_URL = "JF_MCP_ELIGIBILITY_BASE_URL";
const ENV_DEBUG = "JF_MCP_ROUTE_DEBUG";
// New JFROG_* names take precedence over the legacy JF_* ones.
const ENV_URL_VARS = ["JFROG_URL", "JF_URL"];
const ENV_TOKEN_VARS = ["JFROG_ACCESS_TOKEN", "JF_ACCESS_TOKEN"];

// Claude Code is the only harness this route is wired for; every other harness
// resolves to legacy. Mirrors the detection signals in
// references/harness-common.md.
const CLAUDE_HARNESS_VARS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
// Claude Code's servers map. Safe to hard-code only because of the scope above.
const CLAUDE_TOP_LEVEL_KEY = "mcpServers";

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @returns {string | undefined}
 */
function envLookup(env, name) {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  return raw.trim() || undefined;
}

/**
 * First of `names` that is set to a non-empty value.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} names
 */
function envFirst(env, names) {
  return names.map((name) => envLookup(env, name)).find(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {(message: string) => void} [debug]
 */
function makeDebug(env, debug) {
  if (typeof debug === "function") return debug;
  const enabled = envLookup(env, ENV_DEBUG) === "true";
  return (message) => {
    if (enabled) console.error(`[jfrog-mcp-route] ${message}`);
  };
}

/**
 * Accepts `--flag value` and `--flag=value`. An unknown flag is ignored, and a
 * flag whose value is missing (or is itself another flag) stays undefined so
 * the caller falls through to legacy rather than building a URL from garbage.
 *
 * @param {string[]} [argv]
 */
export function parseArgs(argv = []) {
  const FLAGS = {
    "--mcp": "mcp",
    "--project": "project",
    "--server": "server",
    "--config": "config",
  };
  /** @type {{ mcp?: string, project?: string, server?: string, config?: string, remote: boolean }} */
  const parsed = { remote: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") {
      parsed.remote = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const key = FLAGS[eq === -1 ? arg : arg.slice(0, eq)];
    if (!key) continue;

    if (eq === -1) {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.startsWith("--")) continue;
      parsed[key] = next.trim() || undefined;
      i += 1;
    } else {
      parsed[key] = arg.slice(eq + 1).trim() || undefined;
    }
  }
  return parsed;
}

/**
 * Reduce a JFrog URL to the platform root: drop trailing slashes and a
 * trailing `/artifactory`, which is how users commonly export JFROG_URL but is
 * the wrong base for both `/ai-catalog` and `/mcp`.
 *
 * @param {string} url
 */
export function normalizeRoot(url) {
  return String(url ?? "")
    .replace(/\/+$/, "")
    .replace(/\/artifactory$/, "");
}

/**
 * `{project}` and `{mcp-id}` are substituted RAW, with no percent-encoding, to
 * match how Agent Guard already carries the same two values (see
 * references/harness-common.md). An id containing `/` therefore spans more
 * than one path segment, which is what the Gateway's own URL grammar expects.
 *
 * @param {string} base
 * @param {string} project
 * @param {string} mcpId
 */
export function buildEligibilityUrl(base, project, mcpId) {
  return `${normalizeRoot(base)}${ELIGIBILITY_PREFIX}${project}/${mcpId}${ELIGIBILITY_SUFFIX}`;
}

/**
 * The entry always points at the resolved server's real JPD — never at
 * JF_MCP_ELIGIBILITY_BASE_URL, which only says where the question was asked.
 *
 * @param {string} jpdUrl
 * @param {string} project
 * @param {string} mcpId
 */
export function buildGatewayEntry(jpdUrl, project, mcpId) {
  return {
    type: "http",
    url: `${normalizeRoot(jpdUrl)}${GATEWAY_PREFIX}${project}/${mcpId}`,
  };
}

/**
 * Resolve the JPD URL + bearer token for the server the legacy entry would
 * target. Deliberately identical in shape to the Step 0 gate's resolution
 * (modules/core/agent-guard-check.mjs): with an explicit server ID, that jf
 * server first and env second; without one, env first and the default jf
 * server second. Preserving that order matters here — on the `JFROG_URL`+token
 * env path the skill passes no `--server`, and falling straight to the CLI's
 * default server could build a Gateway URL for a different JPD than the one
 * the user is actually authenticated against.
 *
 * @param {{
 *   serverId?: string,
 *   env: NodeJS.ProcessEnv,
 *   execFileSyncFn?: typeof execFileSync,
 *   debug: (message: string) => void,
 * }} opts
 * @returns {{ jpdUrl: string, token: string } | null}
 */
export function resolveCredentials(opts) {
  const { env, debug } = opts;
  const execFn = opts.execFileSyncFn ?? execFileSync;
  const serverId = opts.serverId?.trim() || undefined;

  if (serverId) {
    const fromCli = exportJfServer(serverId, execFn, debug);
    if (fromCli) return fromCli;
    debug("Server ID did not resolve via jf config; trying env credentials.");
  }

  const envUrl = envFirst(env, ENV_URL_VARS);
  const envToken = envFirst(env, ENV_TOKEN_VARS);
  if (envUrl && envToken) {
    debug("Using credentials from environment variables.");
    return { jpdUrl: envUrl, token: envToken };
  }

  if (serverId) return null;
  return exportJfServer(undefined, execFn, debug);
}

/**
 * `jf config export [server ID]` emits the server as base64-encoded JSON
 * carrying url, accessToken, and serverId. The CLI is used rather than reading
 * ~/.jfrog/jfrog-cli.conf.v6 because newer CLIs do not persist the access
 * token in that file.
 *
 * @param {string | undefined} serverId
 * @param {typeof execFileSync} execFn
 * @param {(message: string) => void} debug
 */
function exportJfServer(serverId, execFn, debug) {
  const args = serverId
    ? ["config", "export", serverId]
    : ["config", "export"];
  let exported;
  try {
    exported = execFn("jf", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch (error) {
    debug(`'jf config export' failed: ${error?.message}`);
    return null;
  }

  let cfg;
  try {
    cfg = JSON.parse(Buffer.from(exported, "base64").toString("utf8"));
  } catch (error) {
    debug(`Could not decode the jf config export token: ${error?.message}`);
    return null;
  }

  const jpdUrl = cfg?.url;
  const token = cfg?.accessToken;
  if (!jpdUrl || !token) {
    debug("Exported jf config is missing the platform URL or access token.");
    return null;
  }
  return { jpdUrl, token };
}

/**
 * Ask the Gateway whether it could serve this MCP. Only an explicit 2XX
 * carrying `"eligible": true` is a yes; the negative verdict's `reason` is
 * never read, so it cannot leak into stdout or a log line.
 *
 * @param {{
 *   url: string,
 *   token: string,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   debug: (message: string) => void,
 * }} opts
 * @returns {Promise<{ eligible: boolean, detail: string }>}
 */
export async function checkEligibility(opts) {
  const { url, token, debug } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  debug(`Requesting eligibility from ${url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    // Per the eligibility contract, any non-2XX means the check did not run
    // (404 unknown MCP, 403 not permitted, 429 rate limited, 503 registry
    // down) — none of which is a Gateway verdict.
    if (!response.ok) {
      debug(`Eligibility request returned HTTP ${response.status}.`);
      return { eligible: false, detail: `http-${response.status}` };
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      debug(`Eligibility response was not JSON: ${error?.message}`);
      return { eligible: false, detail: "unparseable-body" };
    }
    // Strictly `eligible`. An earlier draft of the design used
    // `gatewayEligible`; accepting both would route real traffic on the
    // strength of a contract that never shipped.
    if (data?.eligible === true) return { eligible: true, detail: "eligible" };
    if (data?.eligible === false) {
      debug("Gateway reported the MCP as not eligible.");
      return { eligible: false, detail: "not-eligible" };
    }
    debug("Eligibility response carried no boolean 'eligible' field.");
    return { eligible: false, detail: "missing-field" };
  } catch (error) {
    const detail = error?.name === "AbortError" ? "timeout" : "request-failed";
    debug(`Eligibility request failed: ${detail}`);
    return { eligible: false, detail };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Is this MCP already in the target config? Runs ONLY after a positive
 * verdict, so the legacy path keeps behaving exactly as it does today (it has
 * no duplicate check). A missing or unreadable file counts as "not present" —
 * the write in Step 4 creates it.
 *
 * @param {{
 *   configPath: string,
 *   mcpId: string,
 *   readFileSyncFn?: typeof readFileSync,
 *   debug: (message: string) => void,
 * }} opts
 */
export function entryExists(opts) {
  const { configPath, mcpId, debug } = opts;
  const readFn = opts.readFileSyncFn ?? readFileSync;
  try {
    const servers = JSON.parse(readFn(configPath, "utf8"))?.[
      CLAUDE_TOP_LEVEL_KEY
    ];
    return Boolean(servers) && Object.hasOwn(servers, mcpId);
  } catch (error) {
    debug(`Could not read the target config: ${error?.message}`);
    return false;
  }
}

/**
 * Resolve the route without exiting the process.
 *
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   fetchFn?: typeof fetch,
 *   execFileSyncFn?: typeof execFileSync,
 *   readFileSyncFn?: typeof readFileSync,
 *   timeoutMs?: number,
 *   debug?: (message: string) => void,
 * }} [opts]
 * @returns {Promise<{ code: number, lines: string[] }>}
 */
export async function resolveMcpRoute(opts = {}) {
  const env = opts.env ?? process.env;
  const debug = makeDebug(env, opts.debug);
  const legacy = (detail) => {
    debug(`Route resolved to legacy (${detail}).`);
    return { code: EXIT_LEGACY, lines: ["route=legacy", `detail=${detail}`] };
  };

  try {
    // Two-key gate, checked before anything else so a disabled gate reads no
    // credentials and touches no network.
    if (envLookup(env, ENV_GATE_FLAG) !== "true") {
      return legacy("gate-disabled");
    }
    const baseOverride = envLookup(env, ENV_ELIGIBILITY_BASE_URL);
    if (!baseOverride) return legacy("no-eligibility-base");

    if (!CLAUDE_HARNESS_VARS.some((name) => envLookup(env, name))) {
      return legacy("not-claude-harness");
    }

    const args = parseArgs(opts.argv ?? []);
    // Local MCPs never reach the Gateway. The skill passes --remote from the
    // `--inspect` output it already read; the endpoint is the real authority,
    // so an omitted flag can only cost a Gateway route, never grant one.
    if (!args.remote) return legacy("not-remote");
    if (!args.mcp || !args.project || !args.config) {
      return legacy("missing-args");
    }

    const creds = resolveCredentials({
      serverId: args.server,
      env,
      execFileSyncFn: opts.execFileSyncFn,
      debug,
    });
    if (!creds) return legacy("no-credentials");

    const verdict = await checkEligibility({
      url: buildEligibilityUrl(baseOverride, args.project, args.mcp),
      token: creds.token,
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs,
      debug,
    });
    if (!verdict.eligible) return legacy(verdict.detail);

    // Only now, with the verdict in hand: a remote-but-ineligible duplicate
    // must still behave exactly as it does today.
    if (
      entryExists({
        configPath: args.config,
        mcpId: args.mcp,
        readFileSyncFn: opts.readFileSyncFn,
        debug,
      })
    ) {
      return { code: EXIT_EXISTS, lines: ["route=exists", `mcp=${args.mcp}`] };
    }

    const entry = buildGatewayEntry(creds.jpdUrl, args.project, args.mcp);
    debug(`Route resolved to gateway (${entry.url}).`);
    return {
      code: EXIT_GATEWAY,
      lines: ["route=gateway", `entry=${JSON.stringify(entry)}`],
    };
  } catch (error) {
    debug(`Unexpected error: ${error?.stack ?? error?.message ?? error}`);
    return legacy("unexpected-error");
  }
}

/** Self-contained entrypoint check: a plugin install directory is often a
 * symlink, and Node resolves the main entry to its real path, so compare
 * against both. */
function isMainEntry(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    const resolved = path.resolve(entry);
    let real = resolved;
    try {
      real = realpathSync(resolved);
    } catch {
      // Entry may not exist on disk (e.g. a virtual entrypoint); use as-is.
    }
    return (
      moduleUrl === pathToFileURL(real).href ||
      moduleUrl === pathToFileURL(resolved).href
    );
  } catch {
    return false;
  }
}

async function main() {
  const result = await resolveMcpRoute({ argv: process.argv.slice(2) });
  process.stdout.write(`${result.lines.join("\n")}\n`);
  process.exit(result.code);
}

if (isMainEntry(import.meta.url)) {
  main().catch(() => {
    // Any escape from resolveMcpRoute's own guard still has to read as legacy.
    process.stdout.write("route=legacy\ndetail=unexpected-error\n");
    process.exit(EXIT_LEGACY);
  });
}
