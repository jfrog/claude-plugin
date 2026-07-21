// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The base URL is resolved from the JFROG_URL env var first, else the jf CLI
// config. The Audit service paths below are compiled into the hook.
export const JFROG_URL_ENV_NAME = "JFROG_URL";
export const CONFIGURATION_URL_PATH = "/v1/configuration";
export const TRACES_URL_PATH = "/v1/traces";

const JF_CLI_CONF_RELATIVE = [".jfrog", "jfrog-cli.conf.v6"];

function defaultConfPath() {
  return path.join(os.homedir(), ...JF_CLI_CONF_RELATIVE);
}

function isBlank(value) {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * HTTPS is required and the URL must carry no userinfo (a bearer token rides
 * every call). Returns the origin so the compiled endpoint paths stay fixed
 * regardless of any path or query on the configured base.
 */
function validateBase(candidate) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "not-https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "has-credentials" };
  }
  if (parsed.hostname === "") {
    return { ok: false, reason: "invalid-url" };
  }
  return { ok: true, origin: parsed.origin };
}

async function baseFromCliConfig(confPath, readFile) {
  let raw;
  try {
    raw = await readFile(confPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason:
        error.code === "ENOENT"
          ? "cli-config-missing"
          : "cli-config-unreadable",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "cli-config-malformed" };
  }

  const servers = parsed && parsed.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    return { ok: false, reason: "cli-config-empty" };
  }
  if (servers.length === 1) {
    return {
      ok: true,
      candidate: servers[0] && servers[0].url,
      source: "cli-config",
    };
  }

  const defaults = servers.filter(
    (server) => server && server.isDefault === true,
  );
  if (defaults.length !== 1) {
    return { ok: false, reason: "cli-config-ambiguous" };
  }
  return { ok: true, candidate: defaults[0].url, source: "cli-config" };
}

/**
 * Own the base URL and every Audit endpoint URL in one place. Resolves
 * JFROG_URL first, else the jf CLI config, validates the result (HTTPS, no
 * embedded credentials, well-formed host), and appends the compiled Audit
 * paths. Any unset/blank/invalid/ambiguous input degrades to a fail-closed
 * "tracing off" result - it never throws.
 *
 * @returns {Promise<
 *   | { ok: true, baseUrl: string, configUrl: string, tracesUrl: string, source: "env" | "cli-config" }
 *   | { ok: false, reason: string }
 * >}
 * @example
 * const urls = await resolveAuditUrls();
 * if (urls.ok) fetch(urls.configUrl);
 */
export async function resolveAuditUrls({
  env = process.env,
  confPath = defaultConfPath(),
  readFile = fs.readFile,
} = {}) {
  let candidate;
  let source;

  if (!isBlank(env[JFROG_URL_ENV_NAME])) {
    candidate = env[JFROG_URL_ENV_NAME].trim();
    source = "env";
  } else {
    const fromCli = await baseFromCliConfig(confPath, readFile);
    if (!fromCli.ok) return fromCli;
    if (isBlank(fromCli.candidate)) return { ok: false, reason: "invalid-url" };
    candidate = fromCli.candidate.trim();
    source = fromCli.source;
  }

  const validated = validateBase(candidate);
  if (!validated.ok) return validated;

  return {
    ok: true,
    baseUrl: validated.origin,
    configUrl: validated.origin + CONFIGURATION_URL_PATH,
    tracesUrl: validated.origin + TRACES_URL_PATH,
    source,
  };
}
