#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Async SessionStart hook: puts the pinned Agent Guard in the npx cache, so the
// skill-governance hooks (--prefer-offline) don't download it on a Read.
// `--version` needs no credentials and has no side effects. Always exits 0.

import { spawn } from "node:child_process";
import process from "node:process";

import {
  GOVERNANCE_AGENT_GUARD_SPEC,
  quoteSpawnArgs,
  resolveAgentGuardNpmRegistry,
  resolveNpxCommand,
} from "../modules/core/rewrite-mcp-json.mjs";

try {
  const args = ["--yes", "--registry", resolveAgentGuardNpmRegistry(), GOVERNANCE_AGENT_GUARD_SPEC, "--version"];
  const child = spawn(resolveNpxCommand(), quoteSpawnArgs(args), {
    // cmd.exe, not shell: true, which would honor ComSpec (e.g. PowerShell).
    shell: process.platform === "win32" ? "cmd.exe" : false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => process.exit(0));
  child.on("close", () => process.exit(0));
} catch {
  process.exit(0);
}
