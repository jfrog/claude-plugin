// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// A minimum-Node-version check plus optional force-enable/disable env flags.
// Callers pass their own env var names so multiple consumers can share this.

// Compared numerically, not as strings, to avoid e.g. "9" > "10".
export function isNodeVersionAtLeast(current, minimum) {
  const parse = (v) =>
    String(v)
      .replace(/^v/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const [curMajor, curMinor, curPatch] = parse(current);
  const [minMajor, minMinor, minPatch] = parse(minimum);

  if (curMajor !== minMajor) return curMajor > minMajor;
  if (curMinor !== minMinor) return curMinor > minMinor;
  return curPatch >= minPatch;
}

export async function checkPreflight({
  minNodeVersion = "14.14.0",
  forceEnableEnv,
  forceDisableEnv,
  isEnabled,
  env = process.env,
  nodeVersion = process.version,
} = {}) {
  // 1. Node version gate wins over EVERYTHING, including force-enable.
  if (!isNodeVersionAtLeast(nodeVersion, minNodeVersion)) {
    return { shouldRun: false, reason: "node-version-too-low" };
  }

  // 2. Force-disable wins over force-enable.
  if (forceDisableEnv && env[forceDisableEnv] === "true") {
    return { shouldRun: false, reason: "force-disabled" };
  }

  // 3. Force-enable short-circuits the default check entirely.
  if (forceEnableEnv && env[forceEnableEnv] === "true") {
    return { shouldRun: true, reason: "force-enabled" };
  }

  // 4. No default check supplied — run by default.
  if (typeof isEnabled !== "function") {
    return { shouldRun: true, reason: "no-default-check" };
  }

  // 5. Delegate to the caller's default check; fail closed if it throws.
  try {
    const enabled = await isEnabled();
    return {
      shouldRun: enabled === true,
      reason: enabled ? "default-check-enabled" : "default-check-disabled",
    };
  } catch {
    return { shouldRun: false, reason: "default-check-error" };
  }
}
