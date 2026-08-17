// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  DISABLE_ENV,
  REWRITE_LOCK_PATH_ENV,
  assertSafeRewriteIdentifier,
  buildAgentGuardRewriteArgs,
  isSafeRewriteIdentifier,
  parseRewriteMcpJsonResult,
  resetRewritePipelineLockForTests,
  runRewriteMcpJsonPipeline,
} from "../modules/core/rewrite-mcp-json.mjs";
import { REWRITE_DISABLE_ENV } from "./claude-mcp-json-discover.mjs";

/** @type {string[]} */
const tempRoots = [];

after(() => {
  resetRewritePipelineLockForTests();
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test("DISABLE_ENV matches Claude REWRITE_DISABLE_ENV", () => {
  assert.equal(DISABLE_ENV, REWRITE_DISABLE_ENV);
});

test("isSafeRewriteIdentifier accepts project-like keys", () => {
  assert.equal(isSafeRewriteIdentifier("default"), true);
  assert.equal(isSafeRewriteIdentifier("my-proj_1.0"), true);
  assert.equal(isSafeRewriteIdentifier(""), false);
  assert.equal(isSafeRewriteIdentifier("bad;id"), false);
  assert.equal(isSafeRewriteIdentifier("a b"), false);
});

test("assertSafeRewriteIdentifier throws on unsafe values", () => {
  assert.equal(assertSafeRewriteIdentifier("ok", "project"), "ok");
  assert.throws(
    () => assertSafeRewriteIdentifier("x&y", "project"),
    /safe identifier/,
  );
});

test("buildAgentGuardRewriteArgs requires project and paths", () => {
  assert.throws(
    () => buildAgentGuardRewriteArgs({ paths: [], project: "p" }),
    /at least one/,
  );
  assert.throws(
    () =>
      buildAgentGuardRewriteArgs({
        paths: ["/tmp/a.mcp.json"],
        env: {},
      }),
    /requires --project/,
  );
  const args = buildAgentGuardRewriteArgs({
    paths: ["/tmp/a.mcp.json"],
    project: "demo",
    allowRoots: ["/tmp"],
    env: {},
  });
  assert.deepEqual(args.slice(0, 4), [
    "--rewrite-mcp-json",
    "/tmp/a.mcp.json",
    "--project",
    "demo",
  ]);
  assert.ok(args.includes("--allow-root"));
  assert.ok(args.includes("/tmp"));
  assert.ok(args.includes("--format"));
  assert.ok(args.includes("json"));
});

test("parseRewriteMcpJsonResult parses summary objects", () => {
  assert.equal(parseRewriteMcpJsonResult(""), null);
  assert.deepEqual(parseRewriteMcpJsonResult('{"scanned":2,"rewritten":1}'), {
    scanned: 2,
    rewritten: 1,
  });
});

test("runRewriteMcpJsonPipeline soft-skips when disabled", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { [DISABLE_ENV]: "1" },
    discover: () => {
      throw new Error("should not discover");
    },
  });
  assert.equal(result.status, "disabled");
  assert.equal(result.rewritten, 0);
});

test("runRewriteMcpJsonPipeline skips concurrent runs via lock file", async () => {
  resetRewritePipelineLockForTests();
  const root = mkdtempSync(path.join(tmpdir(), "rewrite-lock-"));
  tempRoots.push(root);
  const lockPath = path.join(root, "rewrite.lock");

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let firstEntered = false;

  const first = runRewriteMcpJsonPipeline({
    env: {
      JF_PROJECT: "demo",
      [REWRITE_LOCK_PATH_ENV]: lockPath,
    },
    discover: async () => {
      firstEntered = true;
      await gate;
      return [];
    },
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "forced" }),
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(firstEntered, true);

  const second = await runRewriteMcpJsonPipeline({
    env: {
      JF_PROJECT: "demo",
      [REWRITE_LOCK_PATH_ENV]: lockPath,
    },
    discover: () => ["/should-not-run.mcp.json"],
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "forced" }),
  });
  assert.equal(second.status, "busy");
  assert.equal(second.rewritten, 0);

  release();
  const firstResult = await first;
  assert.equal(firstResult.status, "skipped");
  resetRewritePipelineLockForTests();
});
