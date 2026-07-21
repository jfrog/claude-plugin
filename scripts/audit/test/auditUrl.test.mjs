// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveAuditUrls,
  JFROG_URL_ENV_NAME,
  CONFIGURATION_URL_PATH,
  TRACES_URL_PATH,
} from "../src/storage/auditUrl.mjs";

const BASE = "https://acme.example.com";
const EXPECTED_CONFIG = BASE + CONFIGURATION_URL_PATH;
const EXPECTED_TRACES = BASE + TRACES_URL_PATH;
const CONF_PATH = "/home/dev/.jfrog/jfrog-cli.conf.v6";

// Rejected JFROG_URL values → the fail-closed reason each must produce.
const INVALID_ENV_CASES = [
  ["non-https scheme", "http://acme.example.com", "not-https"],
  ["embedded user:pass", "https://user:pass@acme.example.com", "has-credentials"],
  ["embedded username only", "https://user@acme.example.com", "has-credentials"],
  ["unparseable garbage", "not a url", "invalid-url"],
];

function readFileMustNotBeCalled() {
  return async () => {
    throw new Error("jf CLI config must not be read when JFROG_URL is set");
  };
}

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

function cliConfig(servers) {
  return JSON.stringify({ version: "6", servers });
}

function resolveFromEnv(url) {
  return resolveAuditUrls({
    env: { [JFROG_URL_ENV_NAME]: url },
    readFile: readFileMustNotBeCalled(),
    confPath: CONF_PATH,
  });
}

function resolveFromCli(readFile) {
  return resolveAuditUrls({ env: {}, readFile, confPath: CONF_PATH });
}

test("JFROG_URL is used first and builds both endpoints without touching the CLI config", async () => {
  const result = await resolveFromEnv(BASE);
  assert.deepEqual(result, {
    ok: true,
    baseUrl: BASE,
    configUrl: EXPECTED_CONFIG,
    tracesUrl: EXPECTED_TRACES,
    source: "env",
  });
});

test("a trailing slash or stray path on JFROG_URL collapses to the origin", async () => {
  const result = await resolveFromEnv("https://acme.example.com/artifactory/");
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, BASE);
  assert.equal(result.configUrl, EXPECTED_CONFIG);
});

test("JFROG_URL is trimmed of surrounding whitespace", async () => {
  const result = await resolveFromEnv(`  ${BASE}  `);
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, BASE);
});

test("an invalid JFROG_URL fails closed with a precise reason", async () => {
  for (const [label, url, reason] of INVALID_ENV_CASES) {
    const result = await resolveFromEnv(url);
    assert.deepEqual(result, { ok: false, reason }, label);
  }
});

test("a blank JFROG_URL falls back to the jf CLI config", async () => {
  const result = await resolveAuditUrls({
    env: { [JFROG_URL_ENV_NAME]: "   " },
    readFile: readFileReturning(cliConfig([{ url: BASE }])),
    confPath: CONF_PATH,
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "cli-config");
  assert.equal(result.configUrl, EXPECTED_CONFIG);
});

test("a single configured jf server is used without needing isDefault", async () => {
  const result = await resolveFromCli(readFileReturning(cliConfig([{ url: BASE }])));
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, BASE);
  assert.equal(result.source, "cli-config");
});

test("with multiple servers the unique isDefault=true one wins", async () => {
  const body = cliConfig([
    { url: "https://other.example.com", isDefault: false },
    { url: BASE, isDefault: true },
  ]);
  const result = await resolveFromCli(readFileReturning(body));
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, BASE);
});

test("an ambiguous jf config (zero or many isDefault) is rejected, never guessed", async () => {
  const zeroDefault = cliConfig([
    { url: "https://a.example.com" },
    { url: "https://b.example.com" },
  ]);
  const manyDefault = cliConfig([
    { url: "https://a.example.com", isDefault: true },
    { url: "https://b.example.com", isDefault: true },
  ]);
  assert.deepEqual(await resolveFromCli(readFileReturning(zeroDefault)), {
    ok: false,
    reason: "cli-config-ambiguous",
  });
  assert.deepEqual(await resolveFromCli(readFileReturning(manyDefault)), {
    ok: false,
    reason: "cli-config-ambiguous",
  });
});

test("a chosen jf server with a non-https url still fails closed", async () => {
  const result = await resolveFromCli(
    readFileReturning(cliConfig([{ url: "http://acme.example.com" }])),
  );
  assert.deepEqual(result, { ok: false, reason: "not-https" });
});

test("a missing jf config reports cli-config-missing", async () => {
  assert.deepEqual(await resolveFromCli(readFileThrowing("ENOENT")), {
    ok: false,
    reason: "cli-config-missing",
  });
});

test("an unreadable jf config reports cli-config-unreadable", async () => {
  assert.deepEqual(await resolveFromCli(readFileThrowing("EACCES")), {
    ok: false,
    reason: "cli-config-unreadable",
  });
});

test("a malformed jf config reports cli-config-malformed", async () => {
  assert.deepEqual(await resolveFromCli(readFileReturning("{ broken")), {
    ok: false,
    reason: "cli-config-malformed",
  });
});

test("an empty or non-array servers list reports cli-config-empty", async () => {
  assert.deepEqual(await resolveFromCli(readFileReturning(cliConfig([]))), {
    ok: false,
    reason: "cli-config-empty",
  });
  assert.deepEqual(
    await resolveFromCli(readFileReturning(JSON.stringify({ servers: "nope" }))),
    { ok: false, reason: "cli-config-empty" },
  );
});

test("a blank url on the chosen jf server fails closed as invalid-url", async () => {
  assert.deepEqual(
    await resolveFromCli(readFileReturning(cliConfig([{ url: "   " }]))),
    { ok: false, reason: "invalid-url" },
  );
});
