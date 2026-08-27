// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

/**
 * Compares two Node version strings numerically (not as strings, to avoid
 * e.g. "9" > "10").
 *
 * @returns {boolean} whether `current` is >= `minimum`
 * @example
 * isNodeVersionAtLeast("v18.2.0", "14.14.0"); // true
 */
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

/**
 * A minimum-Node-version check plus optional force-enable/disable env flags.
 * Callers pass their own env var names so multiple consumers can share this.
 *
 * @returns {Promise<{ shouldRun: boolean, reason: string }>}
 * @example
 * const { shouldRun, reason } = await checkPreflight({
 *   forceEnableEnv: "JF_FORCE_ENABLE",
 *   forceDisableEnv: "JF_FORCE_DISABLE",
 * });
 */
export async function checkPreflight({
  minNodeVersion = "14.14.0",
  forceEnableEnv,
  forceDisableEnv,
  isEnabled,
  env = process.env,
  nodeVersion = process.version,
} = {}) {
  if (!isNodeVersionAtLeast(nodeVersion, minNodeVersion)) {
    return { shouldRun: false, reason: "node-version-too-low" };
  }

  if (forceDisableEnv && env[forceDisableEnv] === "true") {
    return { shouldRun: false, reason: "force-disabled" };
  }

  if (forceEnableEnv && env[forceEnableEnv] === "true") {
    return { shouldRun: true, reason: "force-enabled" };
  }

  if (typeof isEnabled !== "function") {
    return { shouldRun: true, reason: "no-default-check" };
  }

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
