// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Transient errors seen when replacing a file another process briefly holds
// open (a reader, antivirus, or the search indexer) — common on Windows,
// effectively never on POSIX. Retrying the rename clears them.
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST"]);

async function renameWithRetry(from, to, rename, retries, delayMs, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= retries || !TRANSIENT_RENAME_CODES.has(error.code)) {
        throw error;
      }
      await sleep(delayMs * (attempt + 1));
    }
  }
}

/**
 * Retry absorbs Windows' transient rename sharing violations. Throws on
 * failure - callers need to know a disk write failed.
 *
 * @returns {Promise<void>}
 * @example
 * await atomicWrite("/path/to/file.json", JSON.stringify(data));
 */
export async function atomicWrite(
  targetPath,
  data,
  {
    mode,
    renameRetries = 10,
    renameRetryDelayMs = 10,
    // Injectable for tests, default to the real fs primitives.
    rename = fs.rename,
    sleep = defaultSleep,
  } = {},
) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmpName = `.${base}.${process.pid}.${crypto
    .randomBytes(4)
    .toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  let handle;
  try {
    handle = await fs.open(tmpPath, "w", mode);
    await handle.writeFile(data);
    // Flush to durable storage before we expose the file via rename.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(
      tmpPath,
      targetPath,
      rename,
      renameRetries,
      renameRetryDelayMs,
      sleep,
    );
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}
