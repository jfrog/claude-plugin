// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveAgentGuardCredentials } from "../modules/core/agent-guard-check.mjs";

test("resolveAgentGuardCredentials falls back when JFROG_URL is empty", () => {
  const creds = resolveAgentGuardCredentials({
    env: {
      JFROG_URL: "",
      JF_URL: "https://acme.jfrog.io",
      JFROG_ACCESS_TOKEN: "",
      JF_ACCESS_TOKEN: "tok-from-old",
    },
    execFileSyncFn: () => {
      throw new Error("jf should not run when env credentials resolve");
    },
  });
  assert.deepEqual(creds, {
    baseUrl: "https://acme.jfrog.io",
    token: "tok-from-old",
    source: "environment variables",
  });
});

test("resolveAgentGuardCredentials falls back when JFROG_* is whitespace", () => {
  const creds = resolveAgentGuardCredentials({
    env: {
      JFROG_URL: "   ",
      JF_URL: "https://acme.jfrog.io",
      JFROG_ACCESS_TOKEN: "\t",
      JF_ACCESS_TOKEN: "tok-from-old",
    },
    execFileSyncFn: () => {
      throw new Error("jf should not run when env credentials resolve");
    },
  });
  assert.equal(creds?.baseUrl, "https://acme.jfrog.io");
  assert.equal(creds?.token, "tok-from-old");
});

test("resolveAgentGuardCredentials prefers non-empty JFROG_* over JF_*", () => {
  const creds = resolveAgentGuardCredentials({
    env: {
      JFROG_URL: "https://primary.jfrog.io",
      JF_URL: "https://legacy.jfrog.io",
      JFROG_ACCESS_TOKEN: "primary-tok",
      JF_ACCESS_TOKEN: "legacy-tok",
    },
    execFileSyncFn: () => {
      throw new Error("jf should not run");
    },
  });
  assert.equal(creds?.baseUrl, "https://primary.jfrog.io");
  assert.equal(creds?.token, "primary-tok");
});
