// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { promises as fs } from "node:fs";
import path from "node:path";

import { atomicWrite } from "../../../common/storage/atomicWrite.mjs";
import { createDiskPaths } from "./diskPaths.mjs";

// The cached enable gate is fresh for 15 minutes.
export const CONFIG_FRESH_MS = 15 * 60 * 1000;

// `fetched_at` is stored as epoch milliseconds, so freshness is pure
// arithmetic. This is an internal cache file.
function isValidRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.enable_trace === "boolean" &&
    typeof value.fetched_at === "number" &&
    Number.isFinite(value.fetched_at)
  );
}

/**
 * Read the cached enable gate, never throwing. A missing, unreadable, or
 * malformed file is reported as a discriminated miss so the caller (Pre) can
 * decide to refetch. Freshness is folded in: `fresh` is true only when the
 * record is under {@link CONFIG_FRESH_MS} old.
 *
 * @returns {Promise<
 *   | { ok: true, enableTrace: boolean, fetchedAt: number, fresh: boolean }
 *   | { ok: false, reason: "missing" | "unreadable" | "malformed" }
 * >}
 * @example
 * const cfg = await readConfig();
 * if (cfg.ok && cfg.fresh) useCached(cfg.enableTrace);
 */
export async function readConfig({
  paths = createDiskPaths(),
  now = Date.now(),
  readFile = fs.readFile,
} = {}) {
  let raw;
  try {
    raw = await readFile(paths.configFile, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: error.code === "ENOENT" ? "missing" : "unreadable",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isValidRecord(parsed)) {
    return { ok: false, reason: "malformed" };
  }

  return {
    ok: true,
    enableTrace: parsed.enable_trace,
    fetchedAt: parsed.fetched_at,
    fresh: now - parsed.fetched_at < CONFIG_FRESH_MS,
  };
}

/**
 * Persist the enable gate via the shared atomic write (no torn read for a
 * concurrent {@link readConfig}). Ensures the plugin root exists first, and
 * reports failure as a discriminated result instead of throwing, so a write
 * fault degrades fail-open.
 *
 * @returns {Promise<{ ok: true, fetchedAt: number } | { ok: false, error: Error }>}
 * @example
 * await writeConfig(true); // caches enable_trace=true, stamped now
 */
export async function writeConfig(
  enableTrace,
  { paths = createDiskPaths(), now = Date.now(), write = atomicWrite } = {},
) {
  const record = { enable_trace: enableTrace === true, fetched_at: now };
  try {
    await fs.mkdir(path.dirname(paths.configFile), { recursive: true });
    await write(paths.configFile, JSON.stringify(record));
    return { ok: true, fetchedAt: now };
  } catch (error) {
    return { ok: false, error };
  }
}
