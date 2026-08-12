#!/usr/bin/env node
// check-environment.mjs — Cached JFrog CLI environment check
//
// Checks if jf is installed and its version, using a 24h-TTL cache
// at ${JFROG_CLI_HOME_DIR:-$HOME/.jfrog}/skills-cache/jfrog-skill-state.json
// to avoid redundant checks. The skills-cache/ dir holds only this file and
// the OneModel schema cache — not temp API output.
//
// Usage:
//   node check-environment.mjs [<model-slug>] [--force]
//
// stdout: bare JFROG_CLI_USER_AGENT value (one line) — agent captures it
//         and runs `export JFROG_CLI_USER_AGENT='<v>'` once at the top of
//         every bash invocation that calls jf
// stderr: JSON state (informational, also written to cache file)
//
// Exit codes:
//   0 — cache fresh, CLI ready
//   1 — cache refreshed, CLI ready
//   2 — jf not installed
//   3 — jf below MIN_CLI_VERSION (required for `jf api`)

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/util.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const JFROG_HOME = process.env.JFROG_CLI_HOME_DIR || join(homedir(), ".jfrog");
const CACHE_DIR = join(JFROG_HOME, "skills-cache");
const CACHE_FILE = join(CACHE_DIR, "jfrog-skill-state.json");
const DEFAULT_TTL_HOURS = 24;

// Minimum jf CLI version required by this skill. `jf api` (the generic
// authenticated REST pass-through used by nearly every reference in this
// skill) landed in 2.100.0; older CLIs fail with "unknown command: api".
const MIN_CLI_VERSION = "2.100.0";

// Pins stdio so a failing/logging `jf` subprocess can't leak output to
// this script's own stderr (Node's execFileSync default is to echo the
// child's stderr live to the parent) — see jfrog-login-register-session.mjs's
// jfApi()-adjacent helper for the full rationale.
function execFileOpts(timeoutMs) {
  return {
    encoding: "utf8",
    timeout: timeoutMs,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function parseVersionParts(str) {
  const m = String(str).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Returns true if `a` is strictly less than `b` (plain X.Y.Z numeric
// comparison — jf CLI versions never carry a pre-release suffix on a
// stable release). Unparseable input is treated as not-older here;
// callers that pass "unknown" already gate on that string separately.
function versionLt(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

function emitMinVersionError(version) {
  process.stderr.write(
    JSON.stringify({
      error: `jf CLI ${version} is below minimum ${MIN_CLI_VERSION} required by this skill (needed for 'jf api'). See references/jfrog-cli-install-upgrade.md.`,
    }) + "\n"
  );
}

function isCacheFresh() {
  if (!existsSync(CACHE_FILE)) return false;
  const cache = readCache();
  if (!cache) return false;
  const checkedAt = cache.checked_at;
  const ttlHours = typeof cache.ttl_hours === "number" ? cache.ttl_hours : 24;
  if (!checkedAt) return false;
  const checkedMs = Date.parse(checkedAt);
  if (Number.isNaN(checkedMs)) return false;
  const ageMs = Date.now() - checkedMs;
  return ageMs < ttlHours * 3600 * 1000;
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

// Symlink-safe temp-file-then-rename, same pattern as
// jfrog-init/scripts/jfrog-state-file.mjs's saveState() — an intentional
// small improvement over the shell version's plain `>` redirect, not a
// contract change (only the on-disk write mechanism changes).
function writeCacheAtomic(state) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o644, flag: "wx" });
    chmodSync(tmp, 0o644);
    renameSync(tmp, CACHE_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, already renamed, or not ours to remove.
    }
    throw err;
  }
}

function resolveJfPath() {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const names =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => "jf" + ext.toLowerCase())
      : ["jf"];
  for (const dir of dirs) {
    for (const name of names) {
      const full = join(dir, name);
      try {
        accessSync(full, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return full;
      } catch {
        // Not in this PATH entry — keep looking.
      }
    }
  }
  return "";
}

// Best-effort, non-blocking: any failure (network, parse) just leaves this
// "unknown", same as the original's curl-based probe.
async function fetchLatestVersion() {
  try {
    const res = await fetch("https://releases.jfrog.io/artifactory/jfrog-cli/v2-jf/", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return "unknown";
    const text = await res.text();
    const versions = [...text.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
    if (!versions.length) return "unknown";
    versions.sort((a, b) => {
      const pa = parseVersionParts(a);
      const pb = parseVersionParts(b);
      for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
      }
      return 0;
    });
    return versions[versions.length - 1];
  } catch {
    return "unknown";
  }
}

async function checkCli() {
  const cliPath = resolveJfPath();
  if (!cliPath) {
    process.stderr.write(JSON.stringify({ cli_installed: false }) + "\n");
    return { installed: false };
  }

  let cliVersion = "unknown";
  try {
    const out = execFileSync(cliPath, ["--version"], execFileOpts(10_000));
    const m = out.match(/\d+\.\d+\.\d+/);
    if (m) cliVersion = m[0];
  } catch {
    cliVersion = "unknown";
  }

  const latestVersion = await fetchLatestVersion();
  const meetsMinimum = cliVersion !== "unknown" && !versionLt(cliVersion, MIN_CLI_VERSION);

  const state = {
    checked_at: new Date().toISOString().split(".")[0] + "Z",
    ttl_hours: DEFAULT_TTL_HOURS,
    cli_installed: true,
    cli_path: cliPath,
    cli_version: cliVersion,
    minimum_version: MIN_CLI_VERSION,
    meets_minimum_version: meetsMinimum,
    latest_version_available: latestVersion,
  };

  writeCacheAtomic(state);
  process.stderr.write(JSON.stringify(state) + "\n");
  return { installed: true, state };
}

// Detect the calling harness from environment signals. Returns one of:
// claude, cursor, gemini, goose, copilot, codex, opencode, unknown — or ""
// when no agent signal is present (direct CLI/CI invocation).
// Naming matches the JFrog CLI's DetectExecutionContext() vocabulary.
// Devin Desktop is not detected here — see harness-common.md (agent identity
// + VSCODE_IPC_HOOK). The TERM_PROGRAM=vscode editor hint is also table-only.
function detectHarness(modelSlug) {
  const env = process.env;
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.CURSOR_AGENT || env.CURSOR_CLI || env.CURSOR_TRACE_ID) return "cursor";
  if (env.GEMINI_CLI) return "gemini";
  if (env.GOOSE_TERMINAL) return "goose";
  if (env.COPILOT_CLI) return "copilot";
  if (env.CODEX_CI || env.CODEX_THREAD_ID || env.CODEX_SANDBOX) return "codex";
  if (env.OPENCODE) return "opencode";
  if (env.AGENT || modelSlug) return "unknown";
  return "";
}

// Parses `version:` from SKILL.md's YAML frontmatter (the block between the
// first and second `---` lines).
function readSkillVersion() {
  try {
    const content = readFileSync(join(SKILL_ROOT, "SKILL.md"), "utf8");
    const lines = content.split("\n");
    let dashCount = 0;
    for (const line of lines) {
      if (line.trim() === "---") {
        dashCount++;
        if (dashCount >= 2) break;
        continue;
      }
      if (dashCount === 1) {
        const m = line.match(/^\s*version:\s*(.+?)\s*$/);
        if (m) return m[1].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // No SKILL.md, or unreadable — fall through to "unknown".
  }
  return "unknown";
}

// Emit the skill-level user agent string to stdout.
function emitSkillEnv(modelSlug, cliVersion) {
  const skillVersion = readSkillVersion();
  const harness = detectHarness(modelSlug);
  const metaParts = [];
  if (harness) metaParts.push(`tool=${harness}`);
  if (modelSlug) metaParts.push(`model=${modelSlug}`);
  let ua = `jfrog-skills/${skillVersion}`;
  if (metaParts.length) ua += ` (${metaParts.join("; ")})`;
  ua += ` jfrog-cli-go/${cliVersion}`;
  process.stdout.write(ua + "\n");
}

export async function main(argv) {
  let force = false;
  let modelSlug = "";
  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
    } else if (!modelSlug) {
      modelSlug = arg;
    }
  }

  if (!force && isCacheFresh()) {
    const cache = readCache();
    process.stderr.write(JSON.stringify(cache) + "\n");
    // Re-evaluate the minimum on every run so a bumped MIN_CLI_VERSION is
    // enforced without waiting for the 24h cache to expire.
    const cachedVersion = (cache && cache.cli_version) || "unknown";
    if (cachedVersion !== "unknown" && versionLt(cachedVersion, MIN_CLI_VERSION)) {
      emitMinVersionError(cachedVersion);
      return 3;
    }
    emitSkillEnv(modelSlug, cachedVersion);
    return 0;
  }

  const result = await checkCli();
  if (!result.installed) {
    return 2;
  }

  const refreshedVersion = result.state.cli_version || "unknown";
  if (refreshedVersion !== "unknown" && versionLt(refreshedVersion, MIN_CLI_VERSION)) {
    emitMinVersionError(refreshedVersion);
    return 3;
  }
  emitSkillEnv(modelSlug, refreshedVersion);
  return 1;
}

// Sets process.exitCode rather than calling process.exit() — a forced
// exit can truncate a still-draining stdout write if output is piped.
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
