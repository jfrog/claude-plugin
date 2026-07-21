// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { promises as fs } from "node:fs";
import path from "node:path";

import { createDiskPaths, TMP_SUFFIX } from "./diskPaths.mjs";

// Age-based cleanup window: a session folder older than this is removed.
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A session folder's liveness is the most recent activity in it. Any write,
 * rename, or delete inside the folder bumps either a child's mtime or the
 * folder's own mtime, so the max of both resets the clock - a still-active
 * session is never seen as stale. Falls back to the folder mtime when empty or
 * unreadable.
 *
 * KNOWN LIMITATION: some filesystems (certain SMB/CIFS/FAT mounts, incl.
 * Windows network drives) do not reliably bump directory mtime on content
 * changes, so a live session there could be misjudged. A planned fix is a
 * heartbeat.json re-stamped on each write so liveness reads a content
 * timestamp rather than filesystem mtime.
 */
async function newestActivityMs(dir, { readdir, stat }) {
  let folderMs;
  try {
    folderMs = (await stat(dir)).mtimeMs;
  } catch {
    // Can't even stat the folder - report it as maximally fresh so a folder we
    // can't inspect is never wrongly reaped.
    return Number.POSITIVE_INFINITY;
  }

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return folderMs;
  }

  let newest = folderMs;
  for (const name of names) {
    try {
      const childMs = (await stat(path.join(dir, name))).mtimeMs;
      if (childMs > newest) newest = childMs;
    } catch {
      // A child removed mid-scan can't make the folder look older; skip it.
    }
  }
  return newest;
}

/**
 * The 7-day age-based GC, run as the last step of every Stop. Reaps stale
 * `<session_id>/` folders and orphaned `.tmp` staging files (keyed on mtime),
 * never the currently-live session and never the root singletons
 * (token/config), whatever their age. Never throws: a per-entry failure is
 * collected and the sweep continues.
 *
 * @returns {Promise<{
 *   reapedSessions: string[],
 *   reapedTmp: string[],
 *   errors: Array<{ name: string, error: Error }>,
 * }>}
 * @example
 * await runGarbageCollection({ currentSessionId: "cs_live" });
 */
export async function runGarbageCollection({
  paths = createDiskPaths(),
  now = Date.now(),
  currentSessionId,
  maxAgeMs = SESSION_MAX_AGE_MS,
  readdir = fs.readdir,
  stat = fs.stat,
  remove = fs.rm,
} = {}) {
  const summary = { reapedSessions: [], reapedTmp: [], errors: [] };

  let entries;
  try {
    entries = await readdir(paths.root, { withFileTypes: true });
  } catch {
    return summary; // no root yet (or unreadable) - nothing to reap
  }

  for (const entry of entries) {
    const target = path.join(paths.root, entry.name);
    try {
      if (entry.isDirectory()) {
        // Never touch the currently-live session.
        if (entry.name === currentSessionId) continue;
        const activityMs = await newestActivityMs(target, { readdir, stat });
        if (now - activityMs >= maxAgeMs) {
          await remove(target, { recursive: true, force: true });
          summary.reapedSessions.push(entry.name);
        }
      } else if (entry.name.endsWith(TMP_SUFFIX)) {
        const mtimeMs = (await stat(target)).mtimeMs;
        if (now - mtimeMs >= maxAgeMs) {
          await remove(target, { force: true });
          summary.reapedTmp.push(entry.name);
        }
      }
      // Anything else at root (singletons, unknown files) stays untouched.
    } catch (error) {
      summary.errors.push({ name: entry.name, error });
    }
  }

  return summary;
}
