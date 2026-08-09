#!/usr/bin/env node
// Register the JFrog unified Claude agent-plugin marketplace with Claude
// Code for the default `jf` server. Token stays in-process, never on disk.
//
// Usage: node jfrog-add-claude-marketplace.mjs
//
// Exit 0 -> success
// Exit 1 -> no default jf server, no access token, or marketplace add failed
// Exit 3 -> required CLI missing

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NETRC = join(homedir(), ".netrc");
const MP_PATH = "/ml/core/api/v1/ai-registry/agent-plugins/custom/marketplace/claude-marketplace.json";
const MP_PREFIXES = ["", "/bridge-client"]; // SaaS first, then self-hosted

function fail(msg, code = 1) {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function commandExists(bin) {
  const win = process.platform === "win32";
  try {
    execFileSync(win ? "where" : "command", win ? [bin] : ["-v", bin], { stdio: "ignore", shell: !win });
    return true;
  } catch {
    return false;
  }
}

// Silent `jf` invocation. Returns stdout on success, null on non-zero exit.
function runJf(args) {
  try {
    return execFileSync("jf", args, { encoding: "utf8" });
  } catch {
    return null;
  }
}

// Reads the default server's config. `jf config export` (no arg) emits a
// base64-encoded JSON blob. Decoding stays in memory, token never on disk.
function readDefaultConfig() {
  const out = runJf(["config", "export"]);
  if (!out) return null;
  const b64 = out.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Falls back to the token's subject when `.user` is missing from the config.
// Subject looks like "jfac@<jpd>/users/<u>".
function readUsernameFromToken() {
  const out = runJf(["api", "/access/api/v1/tokens/me"]);
  if (!out) return "";
  try {
    const subject = JSON.parse(out).subject || "";
    const marker = "/users/";
    const idx = subject.lastIndexOf(marker);
    return idx >= 0 ? subject.slice(idx + marker.length) : "";
  } catch {
    return "";
  }
}

// Drops the `machine <host>` block from netrc content.
function netrcDropHost(content, host) {
  const out = [];
  let skip = false;
  for (const line of content.split("\n")) {
    const [first, second] = line.trim().split(/\s+/, 2);
    if (first === "machine" && second === host) {
      skip = true;
      continue;
    }
    if (first === "machine" || first === "default") skip = false;
    if (!skip) out.push(line);
  }
  return out.join("\n");
}

// ---------- main ----------

for (const cmd of ["jf", "claude"]) {
  if (!commandExists(cmd)) fail(`ERROR: ${cmd} not on PATH`, 3);
}

const cfg = readDefaultConfig();
if (!cfg) fail("ERROR: no default jf server. Run 'jf login' or 'jf config use <sid>'.");

const SID = cfg.serverId || "";
const TOKEN = cfg.accessToken || "";
const rawUrl = (cfg.url || "").replace(/\/+$/, "");
const [, scheme = "", base = ""] = rawUrl.match(/^([^:]+):\/\/(.*)$/) || [];
const host = base.split("/")[0] || "";

const LOGIN = cfg.user || (TOKEN ? readUsernameFromToken() : "");

if (!TOKEN || !LOGIN) {
  fail(`ERROR: missing access token or username for '${SID}'. Run 'jf login'`);
}
if (!SID || !scheme || !host) {
  fail("ERROR: could not parse default jf server URL.");
}

// Atomic netrc rewrite: strip any prior block for this host, append fresh.
let existing = "";
try { existing = readFileSync(NETRC, "utf8"); } catch { /* first-time users */ }
const kept = netrcDropHost(existing, host).replace(/\n+$/, "");
const block = `machine ${host}\n  login ${LOGIN}\n  password ${TOKEN}\n`;
const next = kept ? `${kept}\n\n${block}` : block;
const tmp = `${NETRC}.${process.pid}.${Date.now()}.tmp`;
try {
  writeFileSync(tmp, next, { mode: 0o600 });
  renameSync(tmp, NETRC);
} catch (err) {
  try { unlinkSync(tmp); } catch { /* nothing to clean */ }
  fail(`ERROR: could not write ${NETRC}: ${err.message}`);
}

// Try SaaS path first, then self-hosted (Bridge Client). First success wins.
let lastOut = "";
for (const prefix of MP_PREFIXES) {
  const url = `${scheme}://${encodeURIComponent(LOGIN)}:${encodeURIComponent(TOKEN)}@${base}${prefix}${MP_PATH}`;
  const r = spawnSync("claude", ["plugin", "marketplace", "add", url], { encoding: "utf8" });
  lastOut = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.status === 0) {
    process.stdout.write(lastOut);
    process.exit(0);
  }
}
process.stderr.write(lastOut);
process.exit(1);
