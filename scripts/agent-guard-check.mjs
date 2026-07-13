#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// JFrog Agent Guard activation check.
//
// Silent gate used by the Step 0 of every jfrog-mcp-* skill. Determines
// whether the JFrog Agent Guard is enabled for the current environment.
//
// Contract:
//   - exit 0  -> Agent Guard ENABLED  (skill may proceed)
//   - exit !=0 -> Agent Guard DISABLED (skill must silently abort)
//   - a single human-readable reason line is written to stdout for
//     diagnostics only; Step 0 keys off the EXIT CODE, not the text.
//
// Set JF_AGENT_GUARD_DEBUG=true for verbose tracing on stderr.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SETTINGS_PATH =
  "/ml/core/api/v1/administration/account-settings/mcp_gateway_plugin_enabled";
const REQUEST_TIMEOUT_MS = 5000;

const debugEnabled = process.env.JF_AGENT_GUARD_DEBUG === "true";
const debug = (message) => {
  if (debugEnabled) console.error(`[jfrog-agent-guard] ${message}`);
};

// New JFROG_* env vars take precedence over the legacy JF_* names.
const env = (newName, oldName) =>
  process.env[newName] ?? (oldName ? process.env[oldName] : undefined);

const enabled = (reason) => {
  process.stdout.write(`Enabled: ${reason}\n`);
  process.exit(0);
};

const disabled = (reason) => {
  process.stdout.write(`Disabled: ${reason}\n`);
  process.exit(1);
};

// Resolve credentials from Path A (environment variables) or Path B
// (the default JFrog CLI configuration). Returns { baseUrl, token, source }
// or null when neither path yields a usable URL + access token.
function resolveCredentials() {
  // Path A — environment variables.
  const envUrl = env("JFROG_URL", "JF_URL");
  const envToken = env("JFROG_ACCESS_TOKEN", "JF_ACCESS_TOKEN");
  if (envUrl && envToken) {
    debug("Using credentials from environment variables (Path A).");
    return { baseUrl: envUrl, token: envToken, source: "environment variables" };
  }
  debug(
    "Environment credentials incomplete; trying JFrog CLI config (Path B).",
  );

  // Path B — default server from the local JFrog CLI configuration.
  return resolveFromCliConfig();
}

function cliConfigPath() {
  // os.homedir() resolves to %USERPROFILE% on Windows and $HOME elsewhere.
  return path.join(os.homedir(), ".jfrog", "jfrog-cli.conf.v6");
}

function resolveFromCliConfig() {
  const confPath = cliConfigPath();
  let raw;
  try {
    raw = readFileSync(confPath, "utf8");
  } catch {
    debug(`No JFrog CLI config readable at ${confPath}.`);
    return null;
  }

  let conf;
  try {
    conf = JSON.parse(raw);
  } catch {
    debug("JFrog CLI config is not valid JSON.");
    return null;
  }

  const servers = Array.isArray(conf?.servers) ? conf.servers : [];
  if (servers.length === 0) {
    debug("JFrog CLI config contains no servers.");
    return null;
  }

  // Prefer the explicit default; fall back to the sole server when unambiguous.
  const server =
    servers.find((s) => s?.isDefault === true) ??
    (servers.length === 1 ? servers[0] : null);
  if (!server) {
    debug("Multiple JFrog CLI servers and no default; cannot auto-resolve.");
    return null;
  }

  // conf.v6 stores the platform/JPD URL under `url`.
  const baseUrl = server.url ?? server.artifactoryUrl;
  const token = server.accessToken;
  if (!baseUrl) {
    debug("Default JFrog CLI server has no URL.");
    return null;
  }
  if (!token) {
    debug("Default JFrog CLI server has no access token (bearer auth needed).");
    return null;
  }

  const id = server.serverId ?? "default";
  return { baseUrl, token, source: `JF CLI config (server '${id}')` };
}

async function isGatewayPluginEnabled(baseUrl, token) {
  const url = baseUrl.replace(/\/+$/, "") + SETTINGS_PATH;
  debug(`Fetching gateway plugin setting from ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      debug(`Settings request returned HTTP ${response.status}.`);
      return { ok: false, reason: `settings endpoint returned HTTP ${response.status}` };
    }
    const data = await response.json();
    const value = data?.settings?.mcpGatewayPluginEnabled?.value === true;
    debug(`Settings response indicates gateway plugin enabled=${value}.`);
    return value
      ? { ok: true }
      : { ok: false, reason: "mcp_gateway_plugin_enabled returned false" };
  } catch (error) {
    const reason =
      error?.name === "AbortError" ? "timeout" : error?.message ?? "unknown error";
    debug(`Settings request failed: ${reason}`);
    return { ok: false, reason: `settings endpoint unreachable (${reason})` };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const creds = resolveCredentials();
  if (!creds) {
    disabled(
      "JFROG_URL/JF_URL + access token not set and no default JF CLI config found",
    );
  }

  const result = await isGatewayPluginEnabled(creds.baseUrl, creds.token);
  if (result.ok) {
    enabled(`via ${creds.source}`);
  }
  disabled(result.reason);
}

await main();
