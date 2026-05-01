#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const debug = (msg) => {
  if (process.env.JF_MCP_GATEWAY_DEBUG) {
    process.stderr.write(`[jfrog-plugin] ${msg}\n`);
  }
};

const root = process.env.CLAUDE_PLUGIN_ROOT;
if (!root) {
  process.exit(0);
}

function shouldInject() {
  const force = process.env.JF_MCP_GATEWAY_FORCE_ENABLE;
  if (force === "true") {
    debug("JF_MCP_GATEWAY_FORCE_ENABLE=true -> injecting (skip entitlement)");
    return true;
  }
  if (force === "false") {
    debug("JF_MCP_GATEWAY_FORCE_ENABLE=false -> skipping (skip entitlement)");
    return false;
  }

  const registry =
    process.env.JFROG_MCP_GATEWAY_REPO ||
    "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";

  debug(`spawning gateway --should-inject (registry=${registry})`);
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "--registry",
      registry,
      "@jfrog/mcp-gateway",
      "--should-inject",
    ],
    {
      encoding: "utf8",
      timeout: 25_000,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error) {
    debug(`spawn error: ${result.error.message} -> skipping`);
    return false;
  }
  if (result.status === 0) {
    debug("gateway: entitled -> injecting");
    return true;
  }
  debug(
    `gateway exit ${result.status} (3 = not entitled, other = error) -> skipping`,
  );
  return false;
}

if (!shouldInject()) {
  process.exit(0);
}

const templatePath = path.join(root, "templates", "jfrog-mcp-management.md");
let template;
try {
  template = readFileSync(templatePath, "utf8");
} catch {
  process.exit(0);
}

const notice =
  "JFrog MCP Gateway: when adding, removing, or listing MCP servers, " +
  "follow the rules below. Do not invent your own approach; do not call " +
  "the JFrog catalog API directly.\n\n";

const payload = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: notice + template,
  },
};

process.stdout.write(JSON.stringify(payload));
