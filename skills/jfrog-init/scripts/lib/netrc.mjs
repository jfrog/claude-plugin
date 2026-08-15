// netrc.mjs — writes one `machine` block into ~/.netrc, keeping other hosts.

import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// curl checks HOME before the platform default.
export const NETRC = join(process.env.HOME || homedir(), ".netrc");

// Returns `content` with `host`'s entry removed and every other host untouched.
export function dropNetrcHost(content, host) {
  const kept = [];
  let skipping = false;
  for (const line of content.split("\n")) {
    const [keyword, value] = line.trim().split(/\s+/, 2);
    if (keyword === "machine") skipping = value === host;
    else if (keyword === "default") skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n");
}

// Saves `content` as ~/.netrc.
function replaceNetrc(content) {
  const tmp = `${NETRC}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    renameSync(tmp, NETRC);
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, error: `could not write ${NETRC}: ${err.message}` };
  }
  return { ok: true };
}

// Upserts `host`'s credentials as the first entry curl will match.
export function writeNetrc(host, login, token) {
  for (const [keyword, value] of Object.entries({ machine: host, login, password: token })) {
    if (!/^\S+$/.test(value ?? "")) return { ok: false, error: `invalid netrc ${keyword}` };
  }

  let existing = "";
  try {
    existing = readFileSync(NETRC, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") return { ok: false, error: `could not read ${NETRC}: ${err.message}` };
  }
  const block = `machine ${host}\n  login ${login}\n  password ${token}`;
  return replaceNetrc(`${[block, dropNetrcHost(existing, host).trim()].filter(Boolean).join("\n\n")}\n`);
}
