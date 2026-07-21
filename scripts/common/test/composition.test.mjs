// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { httpRequest } from "../http/httpClient.mjs";
import { retryWithBackoff } from "../http/retryWithBackoff.mjs";
import { HTTP_OK, HTTP_SERVICE_UNAVAILABLE } from "../http/httpStatuses.mjs";

// The isolated unit tests prove each primitive in a vacuum; this file proves the
// composition that actually ships — real httpRequest driven by real
// retryWithBackoff — so the `{ ok, status }` result shape one produces is
// exactly what the other consumes.

const TEST_SERVER_URL = "https://127.0.0.1:1/anything";
const TEST_TIMEOUT_MS = 1000;

// Fake transport (parsedUrl, options, callback) => req, matching https.request.
// Plays back the queued responses in order, one per request, so successive
// retries can see different statuses.
function scriptedTransport(responses) {
  let call = 0;
  const transport = (parsedUrl, options, callback) => {
    const idx = Math.min(call, responses.length - 1);
    call += 1;
    const { status, body = "" } = responses[idx];
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = {};
        callback(res);
        queueMicrotask(() => {
          if (body) res.emit("data", Buffer.from(body));
          res.emit("end");
        });
      });
    req.destroy = (error) => queueMicrotask(() => req.emit("error", error));
    return req;
  };
  return { transport, getCalls: () => call };
}

const noSleep = async () => {};

test("composition: retryWithBackoff retries a real httpRequest 503 then succeeds", async () => {
  const { transport, getCalls } = scriptedTransport([
    { status: HTTP_SERVICE_UNAVAILABLE },
    { status: HTTP_OK, body: "ok" },
  ]);

  const result = await retryWithBackoff(
    () =>
      httpRequest({
        url: TEST_SERVER_URL,
        transport,
        timeoutMs: TEST_TIMEOUT_MS,
      }),
    { successStatus: HTTP_OK, sleep: noSleep },
  );

  assert.equal(result.success, true);
  assert.equal(result.status, HTTP_OK);
  assert.equal(result.body, "ok");
  assert.equal(result.attempts, 2);
  assert.equal(getCalls(), 2);
});

test("composition: a real httpRequest network error is retried then exhausted", async () => {
  // A transport that always errors — httpRequest surfaces { ok:false,
  // reason:"network" }, which retryWithBackoff treats as retryable.
  const transport = () => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () =>
      queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED")));
    req.destroy = () => {};
    return req;
  };

  const result = await retryWithBackoff(
    () =>
      httpRequest({
        url: TEST_SERVER_URL,
        transport,
        timeoutMs: TEST_TIMEOUT_MS,
      }),
    { successStatus: HTTP_OK, maxAttempts: 3, sleep: noSleep },
  );

  assert.equal(result.success, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
  assert.equal(result.attempts, 3);
});
