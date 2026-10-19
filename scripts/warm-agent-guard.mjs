#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Pre-warms the npx cache with the latest @jfrog/agent-guard. Runs from an async
// SessionStart hook, so it never delays the session. It resolves ONLINE: it is the
// only thing that pulls a newly published agent-guard into the cache, which is what
// makes the governed hooks' --prefer-offline safe. `--version` exits before mode
// selection, so it needs no credentials and has no side effects. The hook string is
// only `node` plus this file, so it runs on Windows without Git Bash. It always
// exits 0: a failed pre-warm is only a cold cache, never a failed session.

import { spawn } from "node:child_process";
import process from "node:process";

import { isMainEntry } from "../modules/core/entry.mjs";
import { quoteWindowsArg, registryFrom } from "./enforce-skill.mjs";

/**
 * Spawn plan for `npx @jfrog/agent-guard --version`. npm keeps its default retries
 * and fetch timeout: the hook is async with a 180s budget, so retrying through a
 * flaky network costs nobody anything. JFROG_AGENT_GUARD_VERSION is ignored.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 * }} [opts]
 */
export function resolveWarmSpawn(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const args = ["--yes", "--registry", registryFrom(env), "@jfrog/agent-guard", "--version"];

  const windows = platform === "win32";
  return {
    command: windows ? "npx.cmd" : "npx",
    args: windows ? args.map(quoteWindowsArg) : args,
    shell: windows ? "cmd.exe" : false,
    env: { ...env },
  };
}

function main() {
  /** @type {ReturnType<typeof resolveWarmSpawn>} */
  let plan;
  try {
    plan = resolveWarmSpawn({ env: process.env, platform: process.platform });
  } catch {
    process.exit(0);
  }

  /** @type {ReturnType<typeof spawn>} */
  let child;
  try {
    child = spawn(plan.command, plan.args, {
      env: plan.env,
      shell: plan.shell,
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    process.exit(0);
  }

  child.on("error", () => {
    process.exit(0);
  });
  child.on("exit", () => {
    process.exit(0);
  });
}

if (isMainEntry(import.meta.url)) {
  main();
}
