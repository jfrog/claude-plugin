// claude-config.mjs — keeps the marketplace token out of Claude Code's saved URL.

import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Both hold the token: `claude`'s fetch cache, and its settings declaration.
function marketplaceFiles() {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return [join(dir, "plugins", "known_marketplaces.json"), join(dir, "settings.json")];
}

function withoutCredentials(url) {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

// Atomic, owner-only for the token, and keeps any symlink.
function replaceFile(file, content) {
  const target = realpathSync(file);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Any project scope of the same marketplace, since each carries its own copy.
function moveCredentials(source, target) {
  if (source?.source !== "url" || !source.url) return false;
  const saved = new URL(source.url);
  if (saved.origin !== target.origin || saved.pathname !== target.pathname || !saved.password) return false;
  source.headers = { Authorization: `Bearer ${decodeURIComponent(saved.password)}` };
  source.url = withoutCredentials(source.url);
  return true;
}

// No CLI flag sets a header, so the entries `claude` saved are edited in place.
export function moveTokenToHeader(url) {
  const target = new URL(url);
  for (const file of marketplaceFiles()) {
    try {
      const config = JSON.parse(readFileSync(file, "utf8"));
      const entries = config.extraKnownMarketplaces || config;
      let moved = false;
      for (const entry of Object.values(entries)) {
        if (moveCredentials(entry?.source, target)) moved = true;
      }
      if (moved) replaceFile(file, `${JSON.stringify(config, null, 2)}\n`);
    } catch {
      // Best effort: `claude` keeps working from the URL it saved.
    }
  }
}
