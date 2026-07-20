// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Server statuses the beta spec (§Service Contracts) marks retryable. NOTE:
// 500 is explicitly NON-retryable — a deterministic server error a retry would
// only reproduce; among the 5xx only 502/503/504 are transient. 401 is the
// token layer's concern (a single re-mint, handled by the caller), so it is
// absent here and never retried by this helper.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

// Permanent client-side failures a retry would only reproduce — a malformed
// URL or an unserializable body are deterministic bugs, not transient faults.
const NON_RETRYABLE_REASONS = new Set(["invalid-url", "invalid-body"]);

function isRetryable(result) {
  if (!result.ok) {
    return !NON_RETRYABLE_REASONS.has(result.reason);
  }
  return RETRYABLE_STATUSES.has(result.status);
}

function computeDelay(result, attempt, baseDelayMs, maxDelayMs) {
  // Honor Retry-After on 429 responses when present (Node lowercases headers).
  // Always cap at maxDelayMs so a hostile or misconfigured server can't force
  // an unbounded sleep (e.g. `Retry-After: 3600`).
  if (result.ok && result.status === 429) {
    const retryAfter = result.headers?.["retry-after"];
    if (retryAfter !== undefined && retryAfter !== null) {
      const value = String(retryAfter).trim();
      if (/^\d+$/.test(value)) {
        // All-digits => delta-seconds.
        return Math.min(Number(value) * 1000, maxDelayMs);
      }
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        const delta = parsed - Date.now();
        if (delta > 0) return Math.min(delta, maxDelayMs);
      }
    }
  }

  // Exponential backoff, exactly the curve the beta spec (§Service Contracts /
  // D2) pins: 200ms → 400ms → 800ms (~1.4s total). Base 200ms, doubling, capped
  // at maxDelayMs. No jitter — the spec fixes these values.
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

/**
 * Retries a request function with backoff. Has no knowledge of URLs, tokens,
 * or auth - only interprets an httpClient-shaped result and decides whether
 * to retry.
 *
 * @returns {Promise<object>} the last result, plus `{ success: boolean, attempts: number }`
 * @example
 * const res = await retryWithBackoff((attempt) => httpRequest({ url }), { successStatus: 200 });
 * if (res.success) {
 *   // res.status, res.body, res.attempts
 * }
 */
export async function retryWithBackoff(
  requestFn,
  {
    successStatus,
    // 1 initial attempt + 3 retries = sleeps of 200 → 400 → 800ms (~1.4s
    // total), the backoff the beta spec (§Service Contracts / D2) pins.
    maxAttempts = 4,
    baseDelayMs = 200,
    maxDelayMs = 3000,
    sleep = defaultSleep,
  } = {},
) {
  if (successStatus === undefined || successStatus === null) {
    throw new Error("retryWithBackoff requires a `successStatus`");
  }

  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Treat a throwing/rejecting requestFn like a retryable network failure.
    try {
      result = await requestFn(attempt);
    } catch (error) {
      result = { ok: false, reason: "network", error };
    }

    // Success is the ONLY status the caller declared as such.
    if (result.ok && result.status === successStatus) {
      return { ...result, success: true, attempts: attempt };
    }

    if (!isRetryable(result)) {
      return { ...result, success: false, attempts: attempt };
    }

    if (attempt >= maxAttempts) {
      return { ...result, success: false, attempts: attempt };
    }

    const delayMs = computeDelay(result, attempt, baseDelayMs, maxDelayMs);
    await sleep(delayMs);
  }

  // Unreachable in practice (the loop always returns), but keeps the shape
  // consistent if maxAttempts were ever < 1.
  return { ...result, success: false, attempts: maxAttempts };
}
