// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { readHookPayload } from "../hookIo/readHookPayload.mjs";

// A timeout comfortably longer than these in-memory streams take to end, so it
// never fires — used by every test that supplies a complete payload.
const READ_TIMEOUT_MS = 1000;

test("valid JSON across multiple chunks → parsed payload", async () => {
  const stream = new PassThrough();
  const promise = readHookPayload({ stream, timeoutMs: READ_TIMEOUT_MS });

  const payload = { id: "abc", name: "example" };
  const text = JSON.stringify(payload);
  stream.write(text.slice(0, 5));
  stream.write(text.slice(5));
  stream.end();

  const result = await promise;
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, payload);
});

test("empty / whitespace-only input → reason empty", async () => {
  const stream = new PassThrough();
  const promise = readHookPayload({ stream, timeoutMs: READ_TIMEOUT_MS });
  stream.write("   \n  ");
  stream.end();

  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
});

test("malformed JSON → reason invalid-json", async () => {
  const stream = new PassThrough();
  const promise = readHookPayload({ stream, timeoutMs: READ_TIMEOUT_MS });
  stream.write("{ not valid json ");
  stream.end();

  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-json");
  assert.ok(result.error);
});

test("slow stdin never ends within timeout → reason timeout, resolves promptly", async () => {
  const stream = new PassThrough();
  const start = Date.now();
  const promise = readHookPayload({ stream, timeoutMs: 50 });
  // Write partial data but never .end().
  stream.write("{\"partial\":");

  const result = await promise;
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.ok(elapsed < 500, `expected prompt resolution, took ${elapsed}ms`);
});

test("stream error event → reason stream-error", async () => {
  const stream = new PassThrough();
  const promise = readHookPayload({ stream, timeoutMs: READ_TIMEOUT_MS });
  stream.emit("error", new Error("kaboom"));

  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stream-error");
  assert.ok(result.error);
});

test("un-Bufferable chunk on end → reason stream-error, resolves not rejects", async () => {
  const stream = new PassThrough();
  const promise = readHookPayload({ stream, timeoutMs: READ_TIMEOUT_MS });
  // A bare number can't be Buffer-ified: Buffer.from(42) throws
  // TypeError [ERR_INVALID_ARG_TYPE]. Emit directly to bypass PassThrough's
  // own chunk validation and force the decode-path catch.
  stream.emit("data", 42);
  stream.emit("end");

  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stream-error");
  assert.ok(result.error);
});

test("late events after resolution don't throw, don't change result, no unhandled rejection", async () => {
  const stream = new PassThrough();
  const result = await readHookPayload({ stream, timeoutMs: 30 });
  assert.equal(result.reason, "timeout");

  // Fire late data/end events on the same stream; our listeners should be
  // gone, so these must not throw and must not mutate the resolved value.
  assert.doesNotThrow(() => {
    stream.write("late data");
    stream.emit("data", Buffer.from("more"));
    stream.end();
  });

  // Give the event loop a tick to surface any accidental unhandled rejection.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(result.reason, "timeout");
});
