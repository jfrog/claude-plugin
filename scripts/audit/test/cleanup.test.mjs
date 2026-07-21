// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runGarbageCollection,
  SESSION_MAX_AGE_MS,
} from "../src/storage/cleanup.mjs";
import { createDiskPaths, TOKEN_FILE, CONFIG_FILE } from "../src/storage/diskPaths.mjs";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// mtime offsets relative to NOW, expressed against SESSION_MAX_AGE_MS.
const STALE_MTIME = NOW - (SESSION_MAX_AGE_MS + DAY_MS);
const FRESH_MTIME = NOW - HOUR_MS;
const EXACTLY_AT_MAX_MTIME = NOW - SESSION_MAX_AGE_MS;
const ONE_SECOND_UNDER_MAX_MTIME = NOW - (SESSION_MAX_AGE_MS - 1000);

const LIVE_SESSION = "cs_live";
const STALE_SESSION = "cs_stale";
const STALE_SESSION_B = "cs_stale_b";
const FRESH_SESSION = "cs_fresh";
const TMP_ORPHAN = ".config.json.123.abcd.tmp";
const SEED_FILE = "entry-1.json";

function asDate(epochMs) {
  return new Date(epochMs);
}

async function setMtime(target, epochMs) {
  const when = asDate(epochMs);
  await fs.utimes(target, when, when);
}

// Children are written first, then the folder mtime is pinned LAST so those
// writes don't re-bump it away from the value under test.
async function makeSession(root, name, { dirMtime, files = [[SEED_FILE, dirMtime]] }) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [fileName, fileMtime] of files) {
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, "{}");
    await setMtime(filePath, fileMtime);
  }
  await setMtime(dir, dirMtime);
  return dir;
}

async function makeRootFile(root, name, mtime) {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, "x");
  await setMtime(filePath, mtime);
  return filePath;
}

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function withTempRoot(fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-"));
  const paths = createDiskPaths({ home });
  try {
    await fs.mkdir(paths.root, { recursive: true });
    await fn(paths);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("runGarbageCollection deletes a folder whose mtime is older than the max age", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeSession(paths.root, STALE_SESSION, { dirMtime: STALE_MTIME });

    const summary = await runGarbageCollection({ paths, now: NOW });

    assert.equal(await exists(dir), false);
    assert.deepEqual(summary.reapedSessions, [STALE_SESSION]);
    assert.deepEqual(summary.errors, []);
  });
});

test("runGarbageCollection leaves a folder in place while its mtime is within the max age", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeSession(paths.root, FRESH_SESSION, { dirMtime: FRESH_MTIME });

    const summary = await runGarbageCollection({ paths, now: NOW });

    assert.equal(await exists(dir), true);
    assert.deepEqual(summary.reapedSessions, []);
  });
});

test("runGarbageCollection never deletes the folder named by currentSessionId, even when its mtime is past the max age", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeSession(paths.root, LIVE_SESSION, { dirMtime: STALE_MTIME });

    const summary = await runGarbageCollection({
      paths,
      now: NOW,
      currentSessionId: LIVE_SESSION,
    });

    assert.equal(await exists(dir), true);
    assert.deepEqual(summary.reapedSessions, []);
  });
});

test("runGarbageCollection keeps a folder when a child file mtime is within the max age even though the folder mtime is not", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeSession(paths.root, STALE_SESSION, {
      dirMtime: STALE_MTIME,
      files: [
        ["old.json", STALE_MTIME],
        ["new.json", FRESH_MTIME],
      ],
    });

    const summary = await runGarbageCollection({ paths, now: NOW });

    assert.equal(await exists(dir), true);
    assert.deepEqual(summary.reapedSessions, []);
  });
});

test("runGarbageCollection deletes root .tmp files older than the max age and leaves newer ones", async () => {
  await withTempRoot(async (paths) => {
    const staleTmp = await makeRootFile(paths.root, TMP_ORPHAN, STALE_MTIME);
    const freshTmp = await makeRootFile(paths.root, ".token.json.999.ef.tmp", FRESH_MTIME);

    const summary = await runGarbageCollection({ paths, now: NOW });

    assert.equal(await exists(staleTmp), false);
    assert.equal(await exists(freshTmp), true);
    assert.deepEqual(summary.reapedTmp, [TMP_ORPHAN]);
  });
});

test("runGarbageCollection never deletes the root token and config files, regardless of their age", async () => {
  await withTempRoot(async (paths) => {
    const token = await makeRootFile(paths.root, TOKEN_FILE, STALE_MTIME);
    const config = await makeRootFile(paths.root, CONFIG_FILE, STALE_MTIME);

    const summary = await runGarbageCollection({ paths, now: NOW });

    assert.equal(await exists(token), true);
    assert.equal(await exists(config), true);
    assert.deepEqual(summary.reapedSessions, []);
    assert.deepEqual(summary.reapedTmp, []);
  });
});

test("runGarbageCollection deletes a folder whose age equals the max age and keeps one a second younger", async () => {
  await withTempRoot(async (paths) => {
    const atMax = await makeSession(paths.root, STALE_SESSION, {
      dirMtime: EXACTLY_AT_MAX_MTIME,
    });
    const underMax = await makeSession(paths.root, FRESH_SESSION, {
      dirMtime: ONE_SECOND_UNDER_MAX_MTIME,
    });

    const summary = await runGarbageCollection({ paths, now: NOW });

    assert.equal(await exists(atMax), false);
    assert.equal(await exists(underMax), true);
    assert.deepEqual(summary.reapedSessions, [STALE_SESSION]);
  });
});

test("runGarbageCollection returns an empty summary when the root directory does not exist", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cleanup-noroot-"));
  const paths = createDiskPaths({ home });
  try {
    const summary = await runGarbageCollection({ paths, now: NOW });
    assert.deepEqual(summary, { reapedSessions: [], reapedTmp: [], errors: [] });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("runGarbageCollection leaves a folder in place when stat throws for it", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeSession(paths.root, STALE_SESSION, { dirMtime: STALE_MTIME });
    const stat = async (target) => {
      if (target === dir) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return fs.stat(target);
    };

    const summary = await runGarbageCollection({ paths, now: NOW, stat });

    assert.equal(await exists(dir), true);
    assert.deepEqual(summary.reapedSessions, []);
  });
});

test("runGarbageCollection uses the folder own mtime when its contents cannot be read", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeSession(paths.root, STALE_SESSION, { dirMtime: STALE_MTIME });
    const readdir = async (target, opts) => {
      if (target === dir) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return fs.readdir(target, opts);
    };

    const summary = await runGarbageCollection({ paths, now: NOW, readdir });

    assert.equal(await exists(dir), false);
    assert.deepEqual(summary.reapedSessions, [STALE_SESSION]);
  });
});

test("runGarbageCollection records a per-folder deletion failure and still deletes the rest", async () => {
  await withTempRoot(async (paths) => {
    const dirA = await makeSession(paths.root, STALE_SESSION, { dirMtime: STALE_MTIME });
    const dirB = await makeSession(paths.root, STALE_SESSION_B, { dirMtime: STALE_MTIME });

    const remove = async (target, opts) => {
      if (target === dirA) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      return fs.rm(target, opts);
    };

    const summary = await runGarbageCollection({ paths, now: NOW, remove });

    assert.equal(await exists(dirA), true);
    assert.equal(await exists(dirB), false);
    assert.deepEqual(summary.reapedSessions, [STALE_SESSION_B]);
    assert.equal(summary.errors.length, 1);
    assert.equal(summary.errors[0].name, STALE_SESSION);
  });
});

test("two concurrent runGarbageCollection calls both complete without error and delete every expired folder", async () => {
  await withTempRoot(async (paths) => {
    const stale = await makeSession(paths.root, STALE_SESSION, { dirMtime: STALE_MTIME });
    const staleB = await makeSession(paths.root, STALE_SESSION_B, { dirMtime: STALE_MTIME });
    const live = await makeSession(paths.root, LIVE_SESSION, { dirMtime: STALE_MTIME });

    const [first, second] = await Promise.all([
      runGarbageCollection({ paths, now: NOW, currentSessionId: LIVE_SESSION }),
      runGarbageCollection({ paths, now: NOW, currentSessionId: LIVE_SESSION }),
    ]);

    assert.equal(await exists(stale), false);
    assert.equal(await exists(staleB), false);
    assert.equal(await exists(live), true);
    assert.deepEqual(first.errors, []);
    assert.deepEqual(second.errors, []);
  });
});

// ---------------------------------------------------------------------------
// Real-filesystem behaviour: a directory's mtime advances when its contents
// change, and a folder is kept when either its own mtime or a child file's
// mtime is within the max age. These tests hit the REAL filesystem (no mocked
// stat/readdir) so they fail loudly if the host filesystem behaves otherwise.
// ---------------------------------------------------------------------------

const OLD_AGE_MS = SESSION_MAX_AGE_MS + DAY_MS; // comfortably past SESSION_MAX_AGE_MS

// A folder + seed file(s), all pinned old relative to `at` (the folder pinned
// LAST so the seed writes don't re-bump it away from the value under test).
async function makeOldSession(root, name, at, seedFiles = ["file-a.json"]) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const fileName of seedFiles) {
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, "{}");
    await setMtime(filePath, at - OLD_AGE_MS);
  }
  await setMtime(dir, at - OLD_AGE_MS);
  return dir;
}

// --- a directory's own mtime moves forward on structural activity ----------

test("adding a file to a directory advances the directory own mtime", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeOldSession(paths.root, "cs_add", Date.now());
    const before = (await fs.stat(dir)).mtimeMs;
    await fs.writeFile(path.join(dir, "added.json"), "{}");
    const after = (await fs.stat(dir)).mtimeMs;
    assert.ok(after > before, `folder mtime must advance on add (before=${before}, after=${after})`);
  });
});

test("renaming a file inside a directory advances the directory own mtime", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeOldSession(paths.root, "cs_rename", Date.now());
    const before = (await fs.stat(dir)).mtimeMs;
    await fs.rename(
      path.join(dir, "file-a.json"),
      path.join(dir, "file-a-renamed.json"),
    );
    const after = (await fs.stat(dir)).mtimeMs;
    assert.ok(after > before, `folder mtime must advance on rename (before=${before}, after=${after})`);
  });
});

test("deleting a file inside a directory advances the directory own mtime", async () => {
  await withTempRoot(async (paths) => {
    const dir = await makeOldSession(paths.root, "cs_del", Date.now(), [
      "file-a.json",
      "file-b.json",
    ]);
    const before = (await fs.stat(dir)).mtimeMs;
    await fs.rm(path.join(dir, "file-b.json"));
    const after = (await fs.stat(dir)).mtimeMs;
    assert.ok(after > before, `folder mtime must advance on delete (before=${before}, after=${after})`);
  });
});

// --- a folder with an old mtime is kept once its contents change -----------
// Each run carries an untouched twin as a control - it MUST be removed, so a
// no-op "activity" can never make the test pass by accident.

async function assertActivityKeepsFolder(touchedName, activity) {
  await withTempRoot(async (paths) => {
    const now = Date.now();
    const touched = await makeOldSession(paths.root, touchedName, now, [
      "file-a.json",
      "file-b.json",
    ]);
    const control = await makeOldSession(paths.root, "cs_control", now);

    await activity(touched); // bumps `touched`'s mtime to real wall-clock now

    const summary = await runGarbageCollection({ paths, now });

    assert.equal(await exists(touched), true, "touched folder must survive");
    assert.equal(await exists(control), false, "control (no activity) must be removed");
    assert.deepEqual(summary.reapedSessions, ["cs_control"]);
  });
}

test("runGarbageCollection keeps a folder past the max age after a file is added to it", async () => {
  await assertActivityKeepsFolder("cs_add_touched", (dir) =>
    fs.writeFile(path.join(dir, "added.json"), "{}"),
  );
});

test("runGarbageCollection keeps a folder past the max age after a file in it is renamed", async () => {
  await assertActivityKeepsFolder("cs_rename_touched", (dir) =>
    fs.rename(
      path.join(dir, "file-a.json"),
      path.join(dir, "file-a-renamed.json"),
    ),
  );
});

test("runGarbageCollection keeps a folder past the max age after a file is deleted from it", async () => {
  await assertActivityKeepsFolder("cs_del_touched", (dir) =>
    fs.rm(path.join(dir, "file-b.json")),
  );
});

// An in-place content edit may advance only the child file's mtime, not the
// folder's, on some filesystems. This asserts the child mtime advances and
// that the folder is still kept via that child mtime.
test("runGarbageCollection keeps a folder past the max age when a child file is edited in place", async () => {
  await withTempRoot(async (paths) => {
    const now = Date.now();
    const touched = await makeOldSession(paths.root, "cs_edit_touched", now);
    const control = await makeOldSession(paths.root, "cs_control", now);
    const file = path.join(touched, "file-a.json");

    const beforeChild = (await fs.stat(file)).mtimeMs;
    await fs.appendFile(file, "\n{}"); // in-place content edit, no rename
    const afterChild = (await fs.stat(file)).mtimeMs;
    assert.ok(afterChild > beforeChild, "child file mtime must advance on in-place edit");

    const summary = await runGarbageCollection({ paths, now });

    assert.equal(await exists(touched), true, "in-place-edited folder must survive via child mtime");
    assert.equal(await exists(control), false);
    assert.deepEqual(summary.reapedSessions, ["cs_control"]);
  });
});
