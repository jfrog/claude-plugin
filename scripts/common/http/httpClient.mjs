// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import https from "node:https";

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Minimal, dependency-free HTTPS client. Never throws or rejects; every
 * outcome resolves to a discriminated result object. Does not judge HTTP
 * status semantics (e.g. 500 vs 200) - that is retryWithBackoff's job.
 *
 * @returns {Promise<
 *   | { ok: true, status: number, headers: object, body: string }
 *   | { ok: false, reason: "invalid-url" | "invalid-body" | "network" | "timeout", error: Error }
 * >}
 * @example
 * const res = await httpRequest({ url: "https://example.com" });
 * if (res.ok) {
 *   // res.status, res.headers, res.body
 * } else {
 *   // res.reason, res.error
 * }
 */
export function httpRequest({
  url,
  method = "GET",
  headers = {},
  body,
  token,
  timeoutMs = 2000,
  tls,
  // Injectable for tests; defaults to the real https.request.
  transport = https.request,
} = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ ok: false, reason: "invalid-url", error });
      return;
    }
    if (parsed.protocol !== "https:") {
      resolve({
        ok: false,
        reason: "invalid-url",
        error: new Error(`Unsupported protocol: ${parsed.protocol}`),
      });
      return;
    }

    // Add sensible header defaults without clobbering caller-set ones.
    const outHeaders = { ...headers };
    if (token && !hasHeader(outHeaders, "authorization")) {
      outHeaders.Authorization = `Bearer ${token}`;
    }

    let payload;
    if (body !== undefined && body !== null) {
      if (typeof body === "string" || Buffer.isBuffer(body)) {
        payload = body;
      } else {
        try {
          payload = JSON.stringify(body);
        } catch (error) {
          resolve({ ok: false, reason: "invalid-body", error });
          return;
        }
      }
      if (!hasHeader(outHeaders, "content-length")) {
        outHeaders["Content-Length"] = String(Buffer.byteLength(payload));
      }
      if (!hasHeader(outHeaders, "content-type")) {
        outHeaders["Content-Type"] = "application/json";
      }
    }

    // AbortController is only a global from Node v15+; a plain timer +
    // req.destroy() gives the same timeout behavior on older Node too.
    let timedOut = false;
    let req;
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const options = {
      method,
      headers: outHeaders,
      // Escape hatch spread into the request options (e.g. { ca,
      // rejectUnauthorized }) for internal/self-signed CAs.
      ...(tls || {}),
    };

    // transport can throw synchronously (e.g. an invalid header value) —
    // treat that as a network failure instead of a rejected promise.
    try {
      req = transport(parsed, options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let responseBody;
          try {
            responseBody = Buffer.concat(chunks).toString("utf8");
          } catch (error) {
            finish({ ok: false, reason: "network", error });
            return;
          }
          finish({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            body: responseBody,
          });
        });
        res.on("error", (error) => {
          finish({ ok: false, reason: "network", error });
        });
      });

      req.on("error", (error) => {
        // The local flag distinguishes our own timeout from a network error.
        if (timedOut) {
          finish({ ok: false, reason: "timeout", error });
        } else {
          finish({ ok: false, reason: "network", error });
        }
      });

      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    } catch (error) {
      finish({ ok: false, reason: "network", error });
    }
  });
}
