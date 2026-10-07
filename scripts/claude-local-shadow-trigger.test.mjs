// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  HOOK_LOG_FILE,
  HOOK_LOG_MAX_BYTES,
  RESULT,
  MIN_TIME_BETWEEN_SCANS_MS,
  MONITOR_INTERVAL_MS,
  SCANNING_ENABLED_PATH,
  appendHookLog,
  scannedRecently,
  runLocalShadowTrigger,
  shadowDir,
} from "./claude-local-shadow-trigger.mjs";

const NOW = Date.parse("2026-10-07T10:00:00Z");
const URL_ROOT = "https://acme.jfrog.io";

let jfHome;
let dir;

beforeEach(() => {
  jfHome = mkdtempSync(path.join(tmpdir(), "local-shadow-trigger-"));
  dir = path.join(jfHome, "shadow");
});

afterEach(() => {
  rmSync(jfHome, { recursive: true, force: true });
});

const bearer = () => ({
  identity: { url: URL_ROOT, auth: { kind: "bearer", token: "tok" } },
});

function stubFetch(response) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    const { status = 200, body } = response;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  return { fetchFn, calls };
}

function stubSpawn({ error } = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefed = true;
    };
    calls.push({ command, args, options, child });
    queueMicrotask(() =>
      error ? child.emit("error", error) : child.emit("spawn"),
    );
    return child;
  };
  return { spawnFn, calls };
}

function writeReceipt(content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "receipt.json"), content);
}

const receiptAt = (ms) =>
  JSON.stringify({ lastSuccessAt: new Date(ms).toISOString() });

function readHookLog() {
  return readFileSync(path.join(dir, HOOK_LOG_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function run(overrides = {}) {
  const fetchStub = stubFetch(overrides.response ?? { body: { enabled: true } });
  const spawnStub = stubSpawn(overrides.spawn);
  const identityCalls = [];
  await runLocalShadowTrigger(overrides.trigger ?? "session_start", {
    env: { JFROG_CLI_HOME_DIR: jfHome, ...overrides.env },
    now: NOW,
    getIdentityFn: () => {
      identityCalls.push(1);
      return (overrides.identity ?? bearer)();
    },
    fetchFn: fetchStub.fetchFn,
    spawnFn: spawnStub.spawnFn,
    platform: "linux",
  });
  return { fetch: fetchStub.calls, spawn: spawnStub.calls, identityCalls };
}

test("shadowDir follows JFROG_CLI_HOME_DIR", () => {
  assert.equal(shadowDir({ JFROG_CLI_HOME_DIR: "/x" }), path.join("/x", "shadow"));
});

test("scannedRecently: false for a missing, corrupt, failed-only, old or future receipt", () => {
  const receipt = path.join(jfHome, "receipt.json");
  assert.equal(scannedRecently(receipt, NOW), false);

  for (const content of [
    "{not json",
    "null",
    JSON.stringify({ lastAttempt: { outcome: "failed" } }),
    receiptAt(NOW - MIN_TIME_BETWEEN_SCANS_MS),
    receiptAt(NOW + 60_000),
  ]) {
    writeFileSync(receipt, content);
    assert.equal(scannedRecently(receipt, NOW), false, content);
  }
});

test("scannedRecently: the next hourly tick scans even if the last scan ended just after the previous tick", () => {
  const receipt = path.join(jfHome, "receipt.json");
  writeFileSync(receipt, receiptAt(NOW - MONITOR_INTERVAL_MS + 10_000));
  assert.equal(scannedRecently(receipt, NOW), false);
  writeFileSync(receipt, receiptAt(NOW - 30 * 60_000));
  assert.equal(scannedRecently(receipt, NOW), true);
});

test("scanned_recently: a recent success skips the login check and the backend", async () => {
  writeReceipt(receiptAt(NOW - 60_000));
  const calls = await run({ trigger: "monitor" });
  assert.equal(calls.identityCalls.length, 0);
  assert.equal(calls.fetch.length, 0);
  assert.equal(calls.spawn.length, 0);
  const [entry] = readHookLog();
  assert.equal(entry.trigger, "monitor");
  assert.equal(entry.result, RESULT.SCANNED_RECENTLY);
  assert.ok(entry.time);
});

for (const [label, identity] of [
  ["no jf CLI server", () => ({ identity: null })],
  [
    "basic auth only",
    () => ({ identity: { url: URL_ROOT, auth: { kind: "basic", user: "u", password: "p" } } }),
  ],
]) {
  test(`not_logged_in: ${label}`, async () => {
    const calls = await run({ identity });
    assert.equal(calls.fetch.length, 0);
    assert.equal(calls.spawn.length, 0);
    assert.equal(readHookLog()[0].result, RESULT.NOT_LOGGED_IN);
  });
}

test("not_logged_in: the backend rejects the token", async () => {
  const calls = await run({ response: { status: 401 } });
  assert.equal(calls.spawn.length, 0);
  const [entry] = readHookLog();
  assert.equal(entry.result, RESULT.NOT_LOGGED_IN);
  assert.equal(entry.error, "token rejected (HTTP 401)");
});

test("scanning_disabled: the backend says enabled=false", async () => {
  const calls = await run({ response: { body: { enabled: false } } });
  assert.equal(calls.spawn.length, 0);
  assert.equal(readHookLog()[0].result, RESULT.SCANNING_DISABLED);
});

for (const [label, response, error] of [
  ["404", { status: 404 }, "scanning enabled: HTTP 404"],
  ["403", { status: 403 }, "scanning enabled: HTTP 403"],
  ["network error", new Error("getaddrinfo ENOTFOUND"), "scanning enabled: getaddrinfo ENOTFOUND"],
  ["unexpected body", { body: { enabled: "yes" } }, "scanning enabled: response has no boolean 'enabled'"],
  ["empty body", { body: null }, "scanning enabled: response has no boolean 'enabled'"],
]) {
  test(`check_failed: ${label} never starts the scanner`, async () => {
    const calls = await run({ response });
    assert.equal(calls.spawn.length, 0);
    const [entry] = readHookLog();
    assert.equal(entry.result, RESULT.CHECK_FAILED);
    assert.equal(entry.error, error);
  });
}

test("check_failed: the scanner fails to spawn", async () => {
  await run({ spawn: { error: new Error("spawn npx ENOENT") } });
  const [entry] = readHookLog();
  assert.equal(entry.result, RESULT.CHECK_FAILED);
  assert.equal(entry.error, "start scanner: spawn npx ENOENT");
});

test("scanner_started: one backend call, then the scanner starts detached", async () => {
  writeReceipt(receiptAt(NOW - 2 * MONITOR_INTERVAL_MS));
  // Set on purpose: the version pin must have no effect.
  const calls = await run({ env: { JFROG_AGENT_GUARD_VERSION: "9.9.9" } });

  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, `${URL_ROOT}${SCANNING_ENABLED_PATH}`);
  assert.equal(calls.fetch[0].init.headers.Authorization, "Bearer tok");

  assert.equal(calls.spawn.length, 1);
  const [{ command, args, options, child }] = calls.spawn;
  assert.equal(command, "npx");
  assert.deepEqual(args, [
    "--yes",
    "--prefer-offline",
    "--registry",
    "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/",
    "@jfrog/agent-guard",
    "--local-shadow-scan",
  ]);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(child.unrefed, true);

  const [entry] = readHookLog();
  assert.equal(entry.result, RESULT.SCANNER_STARTED);
  assert.equal(entry.error, undefined);
});

test("the backend URL drops a trailing /artifactory", async () => {
  const calls = await run({
    identity: () => ({
      identity: { url: `${URL_ROOT}/artifactory/`, auth: { kind: "bearer", token: "tok" } },
    }),
  });
  assert.equal(calls.fetch[0].url, `${URL_ROOT}${SCANNING_ENABLED_PATH}`);
});

test("JFROG_AGENT_GUARD_BIN runs the local binary directly", async () => {
  const calls = await run({ env: { JFROG_AGENT_GUARD_BIN: "/opt/agent-guard" } });
  assert.equal(calls.spawn[0].command, "/opt/agent-guard");
  assert.deepEqual(calls.spawn[0].args, ["--local-shadow-scan"]);
});

test("the trigger never writes receipt.json", async () => {
  await run();
  await run({ response: { status: 500 } });
  assert.deepEqual(readdirSync(dir), [HOOK_LOG_FILE]);
});

test("appendHookLog rotates into one .1 backup", () => {
  const logPath = path.join(dir, HOOK_LOG_FILE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(logPath, "x".repeat(HOOK_LOG_MAX_BYTES));
  appendHookLog(logPath, { result: "scanned_recently" });
  assert.equal(readFileSync(`${logPath}.1`, "utf8").length, HOOK_LOG_MAX_BYTES);
  assert.equal(readHookLog().length, 1);
});
