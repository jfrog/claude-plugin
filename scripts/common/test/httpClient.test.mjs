// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { httpRequest } from "../http/httpClient.mjs";

// Well-known HTTP status codes used across these tests.
const HTTP_OK = 200;
const HTTP_SERVER_ERROR = 500;

// A short real timeout so the timeout test exercises httpClient's own timer
// logic while still resolving fast.
const SHORT_TIMEOUT_MS = 50;

// A generous timeout for tests that always get a fake response promptly — kept
// small since the fake transport never actually waits on the network.
const TEST_TIMEOUT_MS = 1000;

// A syntactically valid https URL for the fake transport to receive. Nothing
// ever connects to it — the transport is faked — so the host/port are inert.
const TEST_SERVER_URL = "https://127.0.0.1:1/anything";

// Fake transport matching the (parsedUrl, options, callback) => req shape of
// https.request, driven by a responder so tests exercise httpClient's real
// request/response/timeout logic entirely in-process — no real socket or TLS.
function fakeTransport(responder) {
  const calls = [];
  const transport = (parsedUrl, options, callback) => {
    const req = new EventEmitter();
    calls.push({ parsedUrl, options });
    req.write = () => {};
    req.end = () => responder({ req, callback });
    req.destroy = (error) => queueMicrotask(() => req.emit("error", error));
    return req;
  };
  return { transport, calls };
}

// Responder that plays back a full successful response (status, headers, body)
// through the callback + res EventEmitter the way https.request would.
function respondWith({ status, headers = {}, body = "" }) {
  return ({ callback }) => {
    queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = headers;
      callback(res);
      queueMicrotask(() => {
        if (body) res.emit("data", Buffer.from(body));
        res.emit("end");
      });
    });
  };
}

// Responder that emits a transport-level error on the request, as https.request
// would for a connection failure.
function failWith(error) {
  return ({ req }) => queueMicrotask(() => req.emit("error", error));
}

// Responder that never produces a response, so httpClient's own timeout timer
// is what ends the request.
function neverRespond() {
  return () => {};
}

test("success: 200 with JSON body round-trips", async () => {
  const payload = { hello: "world", n: 42 };
  const { transport } = fakeTransport(
    respondWith({ status: HTTP_OK, body: JSON.stringify(payload) }),
  );
  const result = await httpRequest({
    url: TEST_SERVER_URL,
    transport,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, HTTP_OK);
  assert.deepEqual(JSON.parse(result.body), payload);
});

test("server error: 500 still resolves ok:true (module reports, not judges)", async () => {
  const { transport } = fakeTransport(
    respondWith({ status: HTTP_SERVER_ERROR, body: "boom" }),
  );
  const result = await httpRequest({
    url: TEST_SERVER_URL,
    transport,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, HTTP_SERVER_ERROR);
  assert.equal(result.body, "boom");
});

test("network failure: transport error → reason network", async () => {
  const { transport } = fakeTransport(failWith(new Error("ECONNREFUSED")));
  const result = await httpRequest({
    url: TEST_SERVER_URL,
    transport,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
  assert.ok(result.error);
});

test("timeout: no response → reason timeout, resolves promptly", async () => {
  const { transport } = fakeTransport(neverRespond());
  const start = Date.now();
  const result = await httpRequest({
    url: TEST_SERVER_URL,
    transport,
    timeoutMs: SHORT_TIMEOUT_MS,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.ok(elapsed < 1500, `expected prompt resolution, took ${elapsed}ms`);
});

test("invalid / non-https URL → reason invalid-url, no throw", async () => {
  const bad = await httpRequest({ url: "not a url" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "invalid-url");

  const http = await httpRequest({ url: "http://example.com" });
  assert.equal(http.ok, false);
  assert.equal(http.reason, "invalid-url");
});

test("circular body → reason invalid-body, no throw/reject", async () => {
  const circular = {};
  circular.self = circular;
  // Contract: never throws, never rejects — so a plain await must be safe.
  // Fails at JSON.stringify before any transport call, so no seam needed.
  const result = await httpRequest({
    url: TEST_SERVER_URL,
    method: "POST",
    body: circular,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-body");
  assert.ok(result.error);
});

test("header-injection-shaped throw → reason network, no throw", async () => {
  // A token with an embedded newline yields `Authorization: Bearer abc\ndef`,
  // which the real https.request rejects synchronously with ERR_INVALID_CHAR
  // (header-injection protection) before any socket is opened — so this hits
  // the real default transport deliberately, no seam injected.
  const result = await httpRequest({
    url: TEST_SERVER_URL,
    token: "abc\ndef",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "network");
  assert.ok(result.error);
});

test("object body sets Content-Type: application/json and a matching Content-Length", async () => {
  const { transport, calls } = fakeTransport(
    respondWith({ status: HTTP_OK, body: "ok" }),
  );
  const body = { hello: "world", n: 42 };

  await httpRequest({
    url: TEST_SERVER_URL,
    method: "POST",
    body,
    transport,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  const { headers } = calls[0].options;
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(
    headers["Content-Length"],
    String(Buffer.byteLength(JSON.stringify(body))),
  );
});

test("caller-supplied Content-Type / Content-Length are not overridden", async () => {
  const { transport, calls } = fakeTransport(
    respondWith({ status: HTTP_OK, body: "ok" }),
  );

  await httpRequest({
    url: TEST_SERVER_URL,
    method: "POST",
    body: { a: 1 },
    // Lower-cased on purpose: the override guard is case-insensitive, so these
    // must win over the defaults httpClient would otherwise add.
    headers: { "content-type": "text/plain", "content-length": "999" },
    transport,
    timeoutMs: TEST_TIMEOUT_MS,
  });

  const { headers } = calls[0].options;
  assert.equal(headers["content-type"], "text/plain");
  assert.equal(headers["content-length"], "999");
  // No duplicate capitalized variants were added alongside the caller's.
  assert.equal(headers["Content-Type"], undefined);
  assert.equal(headers["Content-Length"], undefined);
});

test("token sets Authorization; caller-supplied Authorization is not overridden", async () => {
  const { transport, calls } = fakeTransport(
    respondWith({ status: HTTP_OK, body: "ok" }),
  );

  await httpRequest({
    url: TEST_SERVER_URL,
    token: "abc123",
    transport,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  assert.equal(calls[0].options.headers.Authorization, "Bearer abc123");

  await httpRequest({
    url: TEST_SERVER_URL,
    token: "abc123",
    headers: { Authorization: "Bearer caller-set" },
    transport,
    timeoutMs: TEST_TIMEOUT_MS,
  });
  assert.equal(calls[1].options.headers.Authorization, "Bearer caller-set");
});
