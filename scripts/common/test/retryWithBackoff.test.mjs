// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";

import { retryWithBackoff } from "../http/retryWithBackoff.mjs";

// Well-known HTTP status codes exercised across these tests.
const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500; // non-retryable (deterministic)
const HTTP_BAD_GATEWAY = 502; // retryable transient 5xx
const HTTP_SERVICE_UNAVAILABLE = 503; // retryable transient 5xx
const HTTP_GATEWAY_TIMEOUT = 504; // retryable transient 5xx

// Retry-After delta-seconds sent by the server and the millisecond sleep it
// must translate into.
const RETRY_AFTER_SECONDS = 2;

// A Retry-After far larger than the cap, used to prove it's clamped.
const HUGE_RETRY_AFTER_SECONDS = 3600;
const CAPPED_MAX_DELAY_MS = 3000;

function mockRequest(results) {
  const state = { calls: 0 };
  const fn = async () => {
    const idx = state.calls;
    state.calls += 1;
    return results[Math.min(idx, results.length - 1)];
  };
  return { fn, state };
}

function mockSleep() {
  const calls = [];
  const sleep = async (ms) => {
    calls.push(ms);
  };
  return { sleep, calls };
}

test("retry-then-succeed: fails once (503), succeeds on 2nd", async () => {
  const { fn, state } = mockRequest([
    { ok: true, status: HTTP_SERVICE_UNAVAILABLE, headers: {}, body: "" },
    { ok: true, status: HTTP_OK, headers: {}, body: "yay" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.equal(state.calls, 2);
  assert.equal(calls.length, 1);
});

test("attempt cap: all fail (503) → 3 attempts, no 4th call", async () => {
  const { fn, state } = mockRequest([
    { ok: true, status: HTTP_SERVICE_UNAVAILABLE, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, {
    successStatus: HTTP_OK,
    maxAttempts: 3,
    sleep,
  });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 3);
  assert.equal(state.calls, 3);
  // Sleep only happens between attempts, so 2 sleeps for 3 attempts.
  assert.equal(calls.length, 2);
});

test("successStatus 200 works", async () => {
  const { fn } = mockRequest([
    { ok: true, status: HTTP_OK, headers: {}, body: "" },
  ]);
  const { sleep } = mockSleep();
  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, true);
  assert.equal(result.attempts, 1);
});

test("successStatus 202 works independently", async () => {
  const { fn } = mockRequest([
    { ok: true, status: HTTP_ACCEPTED, headers: {}, body: "" },
  ]);
  const { sleep } = mockSleep();
  const result = await retryWithBackoff(fn, {
    successStatus: HTTP_ACCEPTED,
    sleep,
  });
  assert.equal(result.success, true);
  assert.equal(result.attempts, 1);
});

test("non-retryable 4xx (400) → immediate failure, sleep never called", async () => {
  const { fn, state } = mockRequest([
    { ok: true, status: HTTP_BAD_REQUEST, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 1);
  assert.equal(state.calls, 1);
  assert.equal(calls.length, 0);
});

test("500 is non-retryable (deterministic) → immediate failure, sleep never called", async () => {
  const { fn, state } = mockRequest([
    { ok: true, status: HTTP_SERVER_ERROR, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, {
    successStatus: HTTP_ACCEPTED,
    sleep,
  });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 1);
  assert.equal(state.calls, 1);
  assert.equal(calls.length, 0);
});

test("401 is not retried here (token layer re-mints, not this helper)", async () => {
  const { fn, state } = mockRequest([
    { ok: true, status: HTTP_UNAUTHORIZED, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, {
    successStatus: HTTP_ACCEPTED,
    sleep,
  });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 1);
  assert.equal(state.calls, 1);
  assert.equal(calls.length, 0);
});

test("502/503/504 are retryable transient 5xx", async () => {
  for (const status of [
    HTTP_BAD_GATEWAY,
    HTTP_SERVICE_UNAVAILABLE,
    HTTP_GATEWAY_TIMEOUT,
  ]) {
    const { fn, state } = mockRequest([
      { ok: true, status, headers: {}, body: "" },
      { ok: true, status: HTTP_ACCEPTED, headers: {}, body: "" },
    ]);
    const { sleep } = mockSleep();

    const result = await retryWithBackoff(fn, {
      successStatus: HTTP_ACCEPTED,
      sleep,
    });
    assert.equal(result.success, true, `${status} should retry then succeed`);
    assert.equal(state.calls, 2, `${status} should be attempted twice`);
  }
});

test("Retry-After honored: 429 with retry-after:2 → sleep(2000)", async () => {
  const { fn } = mockRequest([
    {
      ok: true,
      status: HTTP_TOO_MANY_REQUESTS,
      headers: { "retry-after": String(RETRY_AFTER_SECONDS) },
      body: "",
    },
    { ok: true, status: HTTP_OK, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], RETRY_AFTER_SECONDS * 1000);
});

test("Retry-After larger than maxDelayMs is capped at maxDelayMs", async () => {
  const { fn } = mockRequest([
    {
      ok: true,
      status: HTTP_TOO_MANY_REQUESTS,
      headers: { "retry-after": String(HUGE_RETRY_AFTER_SECONDS) },
      body: "",
    },
    { ok: true, status: HTTP_OK, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, {
    successStatus: HTTP_OK,
    maxDelayMs: CAPPED_MAX_DELAY_MS,
    sleep,
  });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], CAPPED_MAX_DELAY_MS);
});

test("invalid-body reason never retried: 1 attempt, immediate failure", async () => {
  const { fn, state } = mockRequest([
    { ok: false, reason: "invalid-body", error: new Error("circular") },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 1);
  assert.equal(state.calls, 1);
  assert.equal(calls.length, 0);
});

test("exponential path: 503 no retry-after uses spec-default base (200ms)", async () => {
  const { fn } = mockRequest([
    { ok: true, status: HTTP_SERVICE_UNAVAILABLE, headers: {}, body: "" },
    { ok: true, status: HTTP_OK, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  // No baseDelayMs override → the beta spec's pinned 200ms base applies.
  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  // Default base is exactly 200ms (beta spec 200 → 400 → 800, no jitter).
  assert.equal(calls[0], 200);
});

test("default backoff follows the spec curve: 4 attempts, sleeps ~200/400/800", async () => {
  const { fn, state } = mockRequest([
    { ok: true, status: HTTP_SERVICE_UNAVAILABLE, headers: {}, body: "" },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });

  assert.equal(result.success, false);
  assert.equal(result.attempts, 4);
  assert.equal(state.calls, 4);
  // 3 retries between 4 attempts, exactly the spec's 200 → 400 → 800 curve.
  assert.deepEqual(calls, [200, 400, 800]);
});

test("invalid-url reason never retried: 1 attempt, immediate failure", async () => {
  const { fn, state } = mockRequest([
    { ok: false, reason: "invalid-url", error: new Error("bad") },
  ]);
  const { sleep, calls } = mockSleep();

  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 1);
  assert.equal(state.calls, 1);
  assert.equal(calls.length, 0);
});

test("network failure retried then exhausted", async () => {
  const { fn, state } = mockRequest([
    { ok: false, reason: "network", error: new Error("ECONNREFUSED") },
  ]);
  const { sleep } = mockSleep();
  const result = await retryWithBackoff(fn, {
    successStatus: HTTP_OK,
    maxAttempts: 2,
    sleep,
  });
  assert.equal(result.success, false);
  assert.equal(result.attempts, 2);
  assert.equal(state.calls, 2);
});

test("throwing requestFn treated as retryable network failure, then succeeds", async () => {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("sync boom");
    }
    return { ok: true, status: HTTP_OK, headers: {}, body: "ok" };
  };
  const { sleep } = mockSleep();

  const result = await retryWithBackoff(fn, { successStatus: HTTP_OK, sleep });
  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test("two concurrent calls don't cross-contaminate attempt counts", async () => {
  const a = mockRequest([
    { ok: true, status: HTTP_SERVICE_UNAVAILABLE, headers: {}, body: "" },
    { ok: true, status: HTTP_OK, headers: {}, body: "" },
  ]);
  const b = mockRequest([
    { ok: true, status: HTTP_SERVICE_UNAVAILABLE, headers: {}, body: "" },
    { ok: true, status: HTTP_SERVICE_UNAVAILABLE, headers: {}, body: "" },
    { ok: true, status: HTTP_OK, headers: {}, body: "" },
  ]);
  const { sleep: sleepA } = mockSleep();
  const { sleep: sleepB } = mockSleep();

  const [ra, rb] = await Promise.all([
    retryWithBackoff(a.fn, { successStatus: HTTP_OK, sleep: sleepA }),
    retryWithBackoff(b.fn, { successStatus: HTTP_OK, sleep: sleepB }),
  ]);

  assert.equal(ra.success, true);
  assert.equal(ra.attempts, 2);
  assert.equal(rb.success, true);
  assert.equal(rb.attempts, 3);
});
