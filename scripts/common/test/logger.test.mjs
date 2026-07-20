// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";

import { logToStderr, createLogger } from "../hookIo/logger.mjs";

// Capture stderr/stdout writes for the duration of `fn`, restoring the
// originals afterward. Returns { err: [...], out: [...] }.
async function captureStreams(fn) {
  const origErr = process.stderr.write;
  const origOut = process.stdout.write;
  const err = [];
  const out = [];
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
  }
  return { err, out };
}

test("logToStderr writes to stderr, never stdout", async () => {
  const { err, out } = await captureStreams(() => {
    logToStderr("hello");
  });
  assert.deepEqual(err, ["hello\n"]);
  assert.deepEqual(out, []);
});

test("object messages are JSON-stringified; strings pass through", async () => {
  const { err } = await captureStreams(() => {
    logToStderr({ a: 1, b: "two" });
    logToStderr("plain string");
  });
  assert.equal(err[0], JSON.stringify({ a: 1, b: "two" }) + "\n");
  assert.equal(err[1], "plain string\n");
});

test("circular message does not throw; falls back to a non-empty string", async () => {
  const circular = {};
  circular.self = circular;
  let captured;
  const { err } = await captureStreams(() => {
    assert.doesNotThrow(() => logToStderr(circular));
  });
  captured = err[0];
  assert.ok(err.length === 1, "expected exactly one stderr write");
  assert.equal(typeof captured, "string");
  // The String(message) fallback yields "[object Object]\n", not empty.
  assert.ok(captured.trim().length > 0, "expected a non-empty fallback string");
});

test("createLogger('pre') prefixes with [pre]", async () => {
  const { err, out } = await captureStreams(() => {
    const log = createLogger("pre");
    log("started");
    log({ x: 1 });
  });
  assert.equal(err[0], "[pre] started\n");
  assert.equal(err[1], `[pre] ${JSON.stringify({ x: 1 })}\n`);
  assert.deepEqual(out, []);
});

test("createLogger() with no prefix adds no brackets", async () => {
  const { err } = await captureStreams(() => {
    const log = createLogger();
    log("bare");
  });
  assert.equal(err[0], "bare\n");
});
