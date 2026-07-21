// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readConfig,
  writeConfig,
  CONFIG_FRESH_MS,
} from "../src/storage/configStore.mjs";
import { createDiskPaths } from "../src/storage/diskPaths.mjs";

const NOW = 1_700_000_000_000;
const WRITER_COUNT = 20;

// Freshness is `now - fetched_at < CONFIG_FRESH_MS`, so exactly at the TTL is
// already stale.
const FRESHNESS_CASES = [
  ["just written", 0, true],
  ["one ms under the TTL", CONFIG_FRESH_MS - 1, true],
  ["exactly at the TTL", CONFIG_FRESH_MS, false],
  ["past the TTL", CONFIG_FRESH_MS + 1, false],
];

// Inputs a safe read must classify as malformed rather than trust or crash on.
const MALFORMED_BODIES = [
  ["not json", "{not json"],
  ["json array", "[]"],
  ["missing fetched_at", JSON.stringify({ enable_trace: true })],
  ["missing enable_trace", JSON.stringify({ fetched_at: NOW })],
  ["enable_trace wrong type", JSON.stringify({ enable_trace: "yes", fetched_at: NOW })],
  ["fetched_at wrong type", JSON.stringify({ enable_trace: true, fetched_at: "soon" })],
  ["fetched_at not finite", JSON.stringify({ enable_trace: true, fetched_at: null })],
];

function readFileReturning(body) {
  return async () => body;
}

function readFileThrowing(code) {
  return async () => {
    const error = new Error(code);
    error.code = code;
    throw error;
  };
}

async function withTempHome(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "configstore-"));
  try {
    await fn(home, createDiskPaths({ home }));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function listTmp(dir) {
  const entries = await fs.readdir(dir);
  return entries.filter((name) => name.endsWith(".tmp"));
}

test("readConfig reports a missing file as a miss, not an error", async () => {
  const result = await readConfig({ readFile: readFileThrowing("ENOENT") });
  assert.deepEqual(result, { ok: false, reason: "missing" });
});

test("readConfig reports a non-ENOENT read failure as unreadable", async () => {
  const result = await readConfig({ readFile: readFileThrowing("EACCES") });
  assert.deepEqual(result, { ok: false, reason: "unreadable" });
});

test("readConfig treats every malformed body as a clean miss", async () => {
  for (const [label, body] of MALFORMED_BODIES) {
    const result = await readConfig({ readFile: readFileReturning(body) });
    assert.deepEqual(result, { ok: false, reason: "malformed" }, label);
  }
});

test("readConfig folds the freshness rule around the 15-minute TTL", async () => {
  for (const [label, ageMs, fresh] of FRESHNESS_CASES) {
    const body = JSON.stringify({ enable_trace: true, fetched_at: NOW - ageMs });
    const result = await readConfig({ readFile: readFileReturning(body), now: NOW });
    assert.equal(result.ok, true, label);
    assert.equal(result.fresh, fresh, label);
    assert.equal(result.enableTrace, true, label);
    assert.equal(result.fetchedAt, NOW - ageMs, label);
  }
});

test("readConfig surfaces enable_trace=false without altering freshness", async () => {
  const body = JSON.stringify({ enable_trace: false, fetched_at: NOW });
  const result = await readConfig({ readFile: readFileReturning(body), now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.enableTrace, false);
  assert.equal(result.fresh, true);
});

test("writeConfig persists a fresh, readable record round-trip", async () => {
  await withTempHome(async (home, paths) => {
    const written = await writeConfig(true, { paths, now: NOW });
    assert.deepEqual(written, { ok: true, fetchedAt: NOW });

    const onDisk = JSON.parse(await fs.readFile(paths.configFile, "utf8"));
    assert.deepEqual(onDisk, { enable_trace: true, fetched_at: NOW });

    const readBack = await readConfig({ paths, now: NOW });
    assert.equal(readBack.ok, true);
    assert.equal(readBack.enableTrace, true);
    assert.equal(readBack.fresh, true);
  });
});

test("writeConfig coerces any non-true enable value to strict false (fail-closed)", async () => {
  await withTempHome(async (home, paths) => {
    await writeConfig("truthy", { paths, now: NOW });
    const onDisk = JSON.parse(await fs.readFile(paths.configFile, "utf8"));
    assert.equal(onDisk.enable_trace, false);
  });
});

test("writeConfig creates the plugin root when it does not exist yet", async () => {
  await withTempHome(async (home, paths) => {
    await fs.rm(paths.root, { recursive: true, force: true });
    const written = await writeConfig(false, { paths, now: NOW });
    assert.equal(written.ok, true);
    assert.equal((await readConfig({ paths, now: NOW })).enableTrace, false);
  });
});

test("writeConfig reports a write fault as a fail-open result, never throwing", async () => {
  await withTempHome(async (home, paths) => {
    const failingWrite = async () => {
      throw new Error("disk full");
    };
    const result = await writeConfig(true, { paths, now: NOW, write: failingWrite });
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof Error);
  });
});

test("concurrent writeConfig calls leave exactly one complete record, no orphan tmp", async () => {
  await withTempHome(async (home, paths) => {
    const writes = Array.from({ length: WRITER_COUNT }, (_, i) =>
      writeConfig(i % 2 === 0, { paths, now: NOW + i }),
    );
    await Promise.all(writes);

    const result = await readConfig({ paths });
    assert.equal(result.ok, true);
    assert.equal(typeof result.enableTrace, "boolean");
    assert.deepEqual(await listTmp(paths.root), []);
  });
});
