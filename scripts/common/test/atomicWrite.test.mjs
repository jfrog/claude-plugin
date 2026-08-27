// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { atomicWrite } from "../storage/atomicWrite.mjs";

// Number of concurrent writers racing to the same path in the concurrency test.
const WRITER_COUNT = 20;

// Restrictive, owner-only permission bits used by the mode-option test.
const RESTRICTED_FILE_MODE = 0o600;

// Sentinel dropped inside the pre-existing target directory so the
// interrupted-write test can prove a failed write left the target untouched.
const SENTINEL_NAME = "keep.txt";
const SENTINEL_CONTENT = "do-not-touch";

// Payload for the Buffer-input test; readback is asserted against it.
const BUFFER_PAYLOAD = "buffer-bytes";

// Rename-error codes exercising the cross-platform retry path.
const TRANSIENT_LOCK_CODE = "EBUSY"; // transient Windows sharing violation
const PERSISTENT_LOCK_CODE = "EPERM"; // never clears
const NON_TRANSIENT_CODE = "EISDIR"; // must fail immediately, no retry

// How many transient failures the flaky rename simulates before succeeding.
const TRANSIENT_FAIL_COUNT = 2;

// Retry budget passed to atomicWrite in the give-up / no-retry tests.
const TEST_RENAME_RETRIES = 3;

// Must mirror MAX_RENAME_RETRIES in atomicWrite.mjs.
const MAX_RENAME_RETRIES = 50;
const OVERSIZED_RENAME_RETRIES = 1000;

// Builds an injectable rename that throws `code` for the first `failCount`
// calls, then delegates to the real fs.rename (Infinity = always throw).
function flakyRename(failCount, code) {
  let calls = 0;
  const rename = async (from, to) => {
    calls += 1;
    if (calls <= failCount) {
      const error = new Error(`${code}: simulated`);
      error.code = code;
      throw error;
    }
    return fs.rename(from, to);
  };
  return { rename, getCalls: () => calls };
}

const noSleep = async () => {};

async function withScratchDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomicwrite-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function listTmpFiles(dir) {
  const entries = await fs.readdir(dir);
  return entries.filter((e) => e.endsWith(".tmp"));
}

test("basic write when target doesn't exist", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    await atomicWrite(target, "hello");
    assert.equal(await fs.readFile(target, "utf8"), "hello");
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("overwrite: A then B → final is B, no orphan .tmp", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    await atomicWrite(target, "AAAA");
    await atomicWrite(target, "BBBB");
    assert.equal(await fs.readFile(target, "utf8"), "BBBB");
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("concurrency: 20 writers to same path → final is exactly one full payload", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    const payloads = Array.from(
      { length: WRITER_COUNT },
      (_, i) => `payload-${i}`,
    );
    await Promise.all(payloads.map((p) => atomicWrite(target, p)));

    const final = await fs.readFile(target, "utf8");
    assert.ok(
      payloads.includes(final),
      `final content ${JSON.stringify(final)} is not one of the payloads`,
    );
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("no torn reads: concurrent reads during writes see only complete values", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    const payloads = Array.from({ length: 10 }, (_, i) => `value-number-${i}`);
    const valid = new Set(payloads);

    let keepReading = true;
    const reader = (async () => {
      while (keepReading) {
        let content;
        try {
          content = await fs.readFile(target, "utf8");
        } catch (error) {
          assert.equal(error.code, "ENOENT");
          continue;
        }
        assert.ok(
          valid.has(content),
          `observed torn/partial read: ${JSON.stringify(content)}`,
        );
      }
    })();

    await Promise.all(payloads.map((p) => atomicWrite(target, p)));
    keepReading = false;
    await reader;

    const final = await fs.readFile(target, "utf8");
    assert.ok(
      valid.has(final),
      `final content ${JSON.stringify(final)} is corrupted/torn`,
    );
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("mode option: 0o600 sets file permission bits (POSIX only)", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX mode bits not meaningful on win32");
    return;
  }
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "restricted.txt");
    await atomicWrite(target, "content", { mode: RESTRICTED_FILE_MODE });
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o777, RESTRICTED_FILE_MODE);
  });
});

test("interrupted write (rename fails) → throws, orphan .tmp removed, target untouched", async () => {
  await withScratchDir(async (dir) => {
    // A pre-existing directory at the target path makes the final rename()
    // fail (a file cannot be renamed onto a directory) — the temp file is
    // fully written first, so this exercises the failure/cleanup path.
    const target = path.join(dir, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, SENTINEL_NAME), SENTINEL_CONTENT);

    await assert.rejects(atomicWrite(target, "new-data"));

    assert.deepEqual(await listTmpFiles(dir), []);
    assert.equal(
      await fs.readFile(path.join(target, SENTINEL_NAME), "utf8"),
      SENTINEL_CONTENT,
    );
  });
});

test("race with varying-size JSON payloads → final parses to one complete object, no orphan .tmp", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "state.json");
    // Deliberately different-sized JSON per writer: a non-atomic (torn) write
    // would leave structurally invalid or mixed JSON that fails to parse.
    const writers = Array.from({ length: WRITER_COUNT }, (_, i) => ({
      id: i,
      filler: "x".repeat(i),
    }));
    const serialized = writers.map((writer) => JSON.stringify(writer));

    await Promise.all(serialized.map((json) => atomicWrite(target, json)));

    const raw = await fs.readFile(target, "utf8");
    const parsed = JSON.parse(raw); // throws if the file is corrupted/torn
    assert.ok(
      writers.some((w) => w.id === parsed.id && w.filler === parsed.filler),
      `final object ${raw} is not exactly one writer's complete payload`,
    );
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("rename retries transient lock errors (Windows) then succeeds", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    const { rename, getCalls } = flakyRename(
      TRANSIENT_FAIL_COUNT,
      TRANSIENT_LOCK_CODE,
    );

    await atomicWrite(target, "final", { rename, sleep: noSleep });

    assert.equal(getCalls(), TRANSIENT_FAIL_COUNT + 1);
    assert.equal(await fs.readFile(target, "utf8"), "final");
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("rename gives up after a persistent lock error, cleans temp", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    const { rename } = flakyRename(Infinity, PERSISTENT_LOCK_CODE);

    await assert.rejects(
      atomicWrite(target, "x", {
        rename,
        sleep: noSleep,
        renameRetries: TEST_RENAME_RETRIES,
      }),
    );
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("renameRetries above the hard cap is clamped to MAX_RENAME_RETRIES", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    const { rename, getCalls } = flakyRename(Infinity, TRANSIENT_LOCK_CODE);

    await assert.rejects(
      atomicWrite(target, "x", {
        rename,
        sleep: noSleep,
        renameRetries: OVERSIZED_RENAME_RETRIES,
      }),
    );

    // Clamped budget: MAX_RENAME_RETRIES retries + 1 initial attempt.
    assert.equal(getCalls(), MAX_RENAME_RETRIES + 1);
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("rename does not retry a non-transient error", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.txt");
    const { rename, getCalls } = flakyRename(Infinity, NON_TRANSIENT_CODE);

    await assert.rejects(
      atomicWrite(target, "x", {
        rename,
        sleep: noSleep,
        renameRetries: TEST_RENAME_RETRIES,
      }),
    );
    assert.equal(getCalls(), 1);
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});

test("Buffer payload is written verbatim, no orphan .tmp", async () => {
  await withScratchDir(async (dir) => {
    const target = path.join(dir, "file.bin");
    await atomicWrite(target, Buffer.from(BUFFER_PAYLOAD));
    assert.equal(await fs.readFile(target, "utf8"), BUFFER_PAYLOAD);
    assert.deepEqual(await listTmpFiles(dir), []);
  });
});
