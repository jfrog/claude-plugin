// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import {
  HTTP_TOO_MANY_REQUESTS,
  HTTP_BAD_GATEWAY,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_GATEWAY_TIMEOUT,
} from "./httpStatuses.mjs";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Server statuses the beta spec (§Service Contracts) marks retryable. NOTE:
// 500 is explicitly NON-retryable — a deterministic server error a retry would
// only reproduce; among the 5xx only 502/503/504 are transient. 401 is the
// token layer's concern (a single re-mint, handled by the caller), so it is
// absent here and never retried by this helper.
const RETRYABLE_STATUSES = new Set([
  HTTP_TOO_MANY_REQUESTS,
  HTTP_BAD_GATEWAY,
  HTTP_SERVICE_UNAVAILABLE,
  HTTP_GATEWAY_TIMEOUT,
]);

// Permanent client-side failures a retry would only reproduce — a malformed
// URL or an unserializable body are deterministic bugs, not transient faults.
const NON_RETRYABLE_REASONS = new Set(["invalid-url", "invalid-body"]);

function isRetryable(result) {
  if (!result.ok) {
    return !NON_RETRYABLE_REASONS.has(result.reason);
  }
  return RETRYABLE_STATUSES.has(result.status);
}

function computeDelay(attempt, baseDelayMs, maxDelayMs) {
  // Simple exponential backoff — every attempt doubles the wait, exactly the
  // curve the beta spec (§Service Contracts / D2) pins: 200ms → 400ms → 800ms
  // (~1.4s total). Base 200ms, doubling, capped at maxDelayMs. No jitter, and
  // no Retry-After handling — the backend never sends that header.
  return Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
}

/**
 * Retries a request function with backoff. Has no knowledge of URLs, tokens,
 * or auth - only interprets a `{ ok, status }` result and decides whether
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

    const delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs);
    await sleep(delayMs);
  }

  // Unreachable in practice (the loop always returns), but keeps the shape
  // consistent if maxAttempts were ever < 1.
  return { ...result, success: false, attempts: maxAttempts };
}
