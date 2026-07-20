// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import test from "node:test";
import assert from "node:assert/strict";

import { checkPreflight, isNodeVersionAtLeast } from "../preflightCheck.mjs";

// Fixed Node-version reference points reused across tests.
const MIN_NODE_VERSION = "14.14.0"; // fixed reference version used across these tests
const BELOW_MIN_NODE_VERSION = "v12.0.0"; // safely under the floor
const HEALTHY_NODE_VERSION = "v24.0.0"; // comfortably above the floor

// Env-var names the preflight consults for the force-enable / -disable escape
// hatches.
const FORCE_ENABLE_ENV = "FORCE_ENABLE";
const FORCE_DISABLE_ENV = "FORCE_DISABLE";

test("version below minimum wins over force-enable (precedence #1 beats #3)", async () => {
  const result = await checkPreflight({
    minNodeVersion: MIN_NODE_VERSION,
    nodeVersion: BELOW_MIN_NODE_VERSION,
    forceEnableEnv: FORCE_ENABLE_ENV,
    env: { [FORCE_ENABLE_ENV]: "true" },
  });
  assert.deepEqual(result, {
    shouldRun: false,
    reason: "node-version-too-low",
  });
});

test("force-disable beats force-enable (precedence #2 beats #3)", async () => {
  const result = await checkPreflight({
    nodeVersion: HEALTHY_NODE_VERSION,
    forceDisableEnv: FORCE_DISABLE_ENV,
    forceEnableEnv: FORCE_ENABLE_ENV,
    env: { [FORCE_DISABLE_ENV]: "true", [FORCE_ENABLE_ENV]: "true" },
  });
  assert.deepEqual(result, { shouldRun: false, reason: "force-disabled" });
});

test("force-enable set → true, isEnabled NOT called", async () => {
  let called = false;
  const isEnabled = async () => {
    called = true;
    return false;
  };
  const result = await checkPreflight({
    nodeVersion: HEALTHY_NODE_VERSION,
    forceEnableEnv: FORCE_ENABLE_ENV,
    env: { [FORCE_ENABLE_ENV]: "true" },
    isEnabled,
  });
  assert.deepEqual(result, { shouldRun: true, reason: "force-enabled" });
  assert.equal(called, false);
});

const defaultCheckCases = [
  { isEnabledReturns: true, shouldRun: true, reason: "default-check-enabled" },
  { isEnabledReturns: false, shouldRun: false, reason: "default-check-disabled" },
];

for (const { isEnabledReturns, shouldRun, reason } of defaultCheckCases) {
  test(`no force flags, isEnabled → ${isEnabledReturns}`, async () => {
    const result = await checkPreflight({
      nodeVersion: HEALTHY_NODE_VERSION,
      env: {},
      isEnabled: async () => isEnabledReturns,
    });
    assert.deepEqual(result, { shouldRun, reason });
  });
}

test("no force flags, isEnabled throws → fail closed", async () => {
  const result = await checkPreflight({
    nodeVersion: HEALTHY_NODE_VERSION,
    env: {},
    isEnabled: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(result, {
    shouldRun: false,
    reason: "default-check-error",
  });
});

test("no isEnabled, no force flags → no-default-check", async () => {
  const result = await checkPreflight({
    nodeVersion: HEALTHY_NODE_VERSION,
    env: {},
  });
  assert.deepEqual(result, { shouldRun: true, reason: "no-default-check" });
});

test("isNodeVersionAtLeast boundary cases", () => {
  // exactly equal → true
  assert.equal(isNodeVersionAtLeast("14.14.0", "14.14.0"), true);
  assert.equal(isNodeVersionAtLeast("v14.14.0", "14.14.0"), true);
  // one patch below → false
  assert.equal(isNodeVersionAtLeast("14.14.0", "14.14.1"), false);
  // higher major even with lower minor/patch → true
  assert.equal(isNodeVersionAtLeast("15.0.0", "14.14.0"), true);
  assert.equal(isNodeVersionAtLeast("v24.0.0", "14.14.0"), true);
  // lower major → false
  assert.equal(isNodeVersionAtLeast("12.99.99", "14.14.0"), false);
  // with/without leading v both sides
  assert.equal(isNodeVersionAtLeast("v14.15.0", "v14.14.0"), true);
  // higher patch → true
  assert.equal(isNodeVersionAtLeast("14.14.5", "14.14.0"), true);
});

test("two concurrent checkPreflight calls don't leak state", async () => {
  const [a, b] = await Promise.all([
    checkPreflight({
      nodeVersion: HEALTHY_NODE_VERSION,
      env: { E: "true" },
      forceEnableEnv: "E",
      isEnabled: async () => false,
    }),
    checkPreflight({
      nodeVersion: HEALTHY_NODE_VERSION,
      env: {},
      isEnabled: async () => false,
    }),
  ]);
  assert.deepEqual(a, { shouldRun: true, reason: "force-enabled" });
  assert.deepEqual(b, {
    shouldRun: false,
    reason: "default-check-disabled",
  });
});
