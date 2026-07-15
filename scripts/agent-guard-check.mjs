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

import { execFileSync } from "node:child_process";
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

function resolveFromCliConfig() {
  // `jf config export` emits the default server as a base64-encoded JSON blob
  // containing url, accessToken, and serverId. We use the CLI rather than
  // reading ~/.jfrog/jfrog-cli.conf.v6 directly because newer CLIs do not
  // persist the access token in that file (and the platform URL may be stored
  // only as an /artifactory-suffixed URL there, which is wrong for /ml/core).
  let exported;
  try {
    exported = execFileSync("jf", ["config", "export"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch (error) {
    debug(
      `'jf config export' failed (jf not on PATH or no server configured): ${error?.message}`,
    );
    return null;
  }

  let cfg;
  try {
    cfg = JSON.parse(Buffer.from(exported, "base64").toString("utf8"));
  } catch (error) {
    debug(`Could not decode the jf config export token: ${error?.message}`);
    return null;
  }

  // `url` is the platform/JPD root — the base the /ml/core settings path needs.
  const baseUrl = cfg?.url;
  const token = cfg?.accessToken;
  if (!baseUrl) {
    debug("Exported JFrog CLI config has no platform URL.");
    return null;
  }
  if (!token) {
    debug("Exported JFrog CLI config has no access token (bearer auth needed).");
    return null;
  }

  const id = cfg?.serverId ?? "default";
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
