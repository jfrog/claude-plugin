// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Pure transport shim for the Skill/Read/UserPromptExpansion governance hook. It contains
// NO governance logic — all enforcement decisions live in agent-guard. This wrapper only:
//   1. reads the hook event JSON from stdin,
//   2. spawns `agent-guard --enforce-skill ...` (PATH first, npx as a cross-platform fallback),
//   3. forwards the child's stdout/stderr back to Claude Code byte-for-byte,
//   4. maps the child's outcome to an exit code Claude Code understands.
//
// Exists because the shell one-liner it replaces runs under PowerShell on a Windows machine
// without Git Bash, where `${VAR:-default}`, `||`, `command -v`, and `/dev/null` are not valid
// syntax — a parse error there exits 1, and PreToolUse treats any non-zero-but-2 exit as
// non-blocking, so governance silently fails OPEN. Exec form + this Node wrapper (node.exe is a
// real binary on every platform) is the documented cross-platform-safe pattern.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY = "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";

// Read the hook event payload from stdin, synchronously and completely. An empty or unreadable
// stdin (e.g. no piped input at all) is treated as an empty buffer rather than crashing — the
// downstream agent-guard call is responsible for deciding what an empty payload means.
function readStdin() {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

// Absolute path to request-waiver.mjs, derived from CLAUDE_PLUGIN_ROOT when Claude Code has set
// it, falling back to this script's own location (scripts/enforce-skill.mjs -> plugin root is
// the parent of scripts/) so the wrapper also works when invoked directly for debugging.
function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.dirname(scriptDir);
}

function buildArgs() {
  const waiverHelper = path.join(resolvePluginRoot(), "scripts", "governance", "request-waiver.mjs");
  return ["--enforce-skill", "--client", "claude-code", "--waiver-helper", waiverHelper];
}

// Forward a child's captured output to our own stdout/stderr, byte-for-byte. Never merge the
// two streams: npx writes progress to stderr, and mixing that into stdout would corrupt the
// JSON response Claude Code expects.
function forward(result) {
  if (result.stdout && result.stdout.length) process.stdout.write(result.stdout);
  if (result.stderr && result.stderr.length) process.stderr.write(result.stderr);
}

function runAgentGuard(input, args) {
  return spawnSync("agent-guard", args, {
    input,
    encoding: "buffer",
    // On Windows an npm-installed agent-guard is a .cmd shim, which cannot be spawned without
    // a shell. On other platforms the real binary needs no shell.
    shell: process.platform === "win32",
  });
}

function runNpxFallback(input, args) {
  const registry = process.env.JFROG_AGENT_GUARD_REPO || DEFAULT_REGISTRY;
  // npx is itself a shim (a .cmd on Windows, a shell script elsewhere) that cannot reliably be
  // spawned in exec form, so this path always goes through a shell.
  return spawnSync("npx", ["--yes", "--registry", registry, "@jfrog/agent-guard", ...args], {
    input,
    encoding: "buffer",
    shell: true,
  });
}

// An agent-guard that predates --enforce-skill is the failure a user is most likely to hit and
// least likely to diagnose: the flag is simply unknown to it, so it falls through to the MCP
// loader and exits 1 with an unrelated-looking error, and every skill invocation then blocks.
// Naming that possibility in our own message is the difference between a one-line fix and a
// mystery.
const UPGRADE_HINT =
  "If every skill is being blocked, the agent-guard being invoked may predate --enforce-skill support — upgrade @jfrog/agent-guard.";

// Exit 0 only when a child process actually ran and exited 0 (its stdout carries the decision;
// empty stdout means "allow"). Every other outcome — a non-zero child exit, a spawn error, or no
// runnable agent-guard at all — must exit 2: only exit code 2 blocks a PreToolUse hook, so
// anything else (e.g. exit 1) would silently fail OPEN.
function main() {
  const input = readStdin();
  const args = buildArgs();

  const direct = runAgentGuard(input, args);

  // A spawn error (e.g. ENOENT) means "agent-guard is not on PATH" — fall back to npx. A
  // non-zero exit code from a process that DID run is a genuine agent-guard failure and must
  // fail closed, not silently retry via npx.
  if (direct.error) {
    const fallback = runNpxFallback(input, args);
    forward(fallback);
    if (!fallback.error && fallback.status === 0) {
      process.exit(0);
    }
    if (fallback.error) {
      process.stderr.write(
        `enforce-skill.mjs: agent-guard not found on PATH and npx fallback failed to spawn (${fallback.error.message}); blocking.\n`,
      );
    } else {
      process.stderr.write(
        `enforce-skill.mjs: npx fallback for agent-guard exited ${fallback.status}; blocking. ${UPGRADE_HINT}\n`,
      );
    }
    process.exit(2);
  }

  forward(direct);
  if (direct.status === 0) {
    process.exit(0);
  }
  process.stderr.write(
    `enforce-skill.mjs: agent-guard exited ${direct.status}; blocking. ${UPGRADE_HINT}\n`,
  );
  process.exit(2);
}

try {
  main();
} catch (error) {
  // Any unexpected exception must still fail closed.
  process.stderr.write(`enforce-skill.mjs: unexpected error: ${error?.stack ?? error}\n`);
  process.exit(2);
}
