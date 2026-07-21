#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Thin SessionStart / FileChanged hook wrapper.
// All rewrite logic lives in Agent Guard: --align-plugin-mcps
//
// Resolution (same conventions as jfrog-mcp-management):
//   project: JF_PROJECT, or existing _JF_ARGS (resolved inside Agent Guard)
//   server:  existing --server in MCP configs (Agent Guard), or omit when JFROG_URL is set
//   registry: JFROG_AGENT_GUARD_REPO, else public coding-agents default
//
// Gating matches inject-instructions.mjs: skip when Agent Guard is disabled for
// the tenant (unless JF_AGENT_GUARD_FORCE_ENABLE=true).

import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_REGISTRY =
  "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";

const debugEnabled = process.env.JF_AGENT_GUARD_DEBUG === "true";
const debug = (message) => {
  if (debugEnabled) console.error(message);
};

const env = (newName, oldName) => process.env[newName] ?? process.env[oldName];

function readStdinJson() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function pluginsDir() {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
  return path.join(configDir, "plugins");
}

function sessionStartWatchPayload() {
  const dir = pluginsDir();
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      watchPaths: [
        path.join(dir, "installed_plugins.json"),
        path.join(dir, "known_marketplaces.json"),
      ],
      additionalContext:
        "JFrog Agent Guard aligns installed plugin MCP configs (cache installPath and marketplace string-source roots) to launch via @jfrog/agent-guard. Run /reload-plugins so Claude reconnects plugin MCPs with the updated Agent Guard config.",
    },
  });
}

function resolveCredentials() {
  const baseUrl = env("JFROG_URL", "JF_URL");
  const token = env("JFROG_ACCESS_TOKEN", "JF_ACCESS_TOKEN");
  if (baseUrl && token) {
    return { baseUrl, token };
  }
  let configToken;
  try {
    configToken = execFileSync("jf", ["config", "export"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return null;
  }
  try {
    const cfg = JSON.parse(Buffer.from(configToken, "base64").toString("utf8"));
    if (!cfg?.url || !cfg?.accessToken) return null;
    return { baseUrl: cfg.url, token: cfg.accessToken };
  } catch {
    return null;
  }
}

async function isAgentGuardEnabledViaSettings() {
  const credentials = resolveCredentials();
  if (!credentials) return false;
  const url =
    credentials.baseUrl.replace(/\/+$/, "") +
    "/ml/core/api/v1/administration/account-settings/mcp_gateway_plugin_enabled";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.settings?.mcpGatewayPluginEnabled?.value === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function resolveAgentGuardInvocation() {
  const registry = process.env.JFROG_AGENT_GUARD_REPO ?? DEFAULT_REGISTRY;
  return {
    command: "npx",
    prefixArgs: ["--yes", "--registry", registry, "@jfrog/agent-guard"],
  };
}

async function main() {
  const input = readStdinJson();
  const eventName = input.hook_event_name ?? "SessionStart";
  const isSessionStart = eventName === "SessionStart";
  const format = isSessionStart ? "hook-session-start" : "hook-file-changed";

  if (env("_JF_AGENT_GUARD_FORCE_DISABLE") === "true") {
    debug("Force-disable set; skipping align");
    process.stdout.write(isSessionStart ? sessionStartWatchPayload() : "{}\n");
    return;
  }

  const forceEnabled = process.env.JF_AGENT_GUARD_FORCE_ENABLE === "true";
  if (!forceEnabled && !(await isAgentGuardEnabledViaSettings())) {
    debug("Agent Guard not enabled; skipping align");
    // Still register watchPaths on SessionStart so enabling later mid-session works
    // once settings flip (next FileChanged / session).
    process.stdout.write(isSessionStart ? sessionStartWatchPayload() : "{}\n");
    return;
  }

  const { command, prefixArgs } = resolveAgentGuardInvocation();
  const args = [...prefixArgs, "--align-plugin-mcps", "--format", format];

  if (process.env.JF_PROJECT) {
    args.push("--project", process.env.JF_PROJECT);
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    args.push("--claude-config-dir", process.env.CLAUDE_CONFIG_DIR);
  }
  if (process.env.JFROG_AGENT_GUARD_REPO) {
    args.push("--registry", process.env.JFROG_AGENT_GUARD_REPO);
  }

  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
  });

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    console.error(
      `[align-plugin-mcps] failed to spawn ${command}: ${result.error.message}`,
    );
    process.stdout.write(isSessionStart ? sessionStartWatchPayload() : "{}\n");
    return;
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    console.error(
      `[align-plugin-mcps] agent-guard exited ${result.status}: ${detail}`,
    );
    process.stdout.write(isSessionStart ? sessionStartWatchPayload() : "{}\n");
    return;
  }

  if (isSessionStart) {
    process.stdout.write(result.stdout || sessionStartWatchPayload());
  } else {
    process.stdout.write(result.stdout || "{}\n");
  }
}

main().catch((error) => {
  console.error(`[align-plugin-mcps] ${error?.message ?? error}`);
  process.stdout.write("{}\n");
  process.exit(0);
});
