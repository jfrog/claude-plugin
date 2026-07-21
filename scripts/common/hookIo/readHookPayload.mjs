// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Node-enforced stream event names, not strings we define — pinned as constants
// so the on()/removeListener() pairs can never silently desync.
const STREAM_EVENT_DATA = "data";
const STREAM_EVENT_END = "end";
const STREAM_EVENT_ERROR = "error";

/**
 * Reads a JSON payload from a stream (process.stdin by default). Never
 * rejects.
 *
 * @returns {Promise<
 *   | { ok: true, payload: any }
 *   | { ok: false, reason: "empty" | "invalid-json" | "timeout" | "stream-error", error?: Error }
 * >}
 * @example
 * const res = await readHookPayload();
 * if (res.ok) {
 *   // res.payload
 * } else {
 *   // res.reason, res.error
 * }
 */
export function readHookPayload({ stream = process.stdin, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const onData = (chunk) => chunks.push(chunk);
    let onEnd;
    let onError;

    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener(STREAM_EVENT_DATA, onData);
      stream.removeListener(STREAM_EVENT_END, onEnd);
      stream.removeListener(STREAM_EVENT_ERROR, onError);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    onEnd = () => {
      // Guard against a throw here becoming an uncaught exception — this
      // runs outside the Promise executor's auto-catch.
      let text;
      try {
        text = Buffer.concat(
          chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))),
        )
          .toString("utf8")
          .trim();
      } catch (error) {
        finish({ ok: false, reason: "stream-error", error });
        return;
      }
      if (text === "") {
        finish({ ok: false, reason: "empty" });
        return;
      }
      try {
        finish({ ok: true, payload: JSON.parse(text) });
      } catch (error) {
        finish({ ok: false, reason: "invalid-json", error });
      }
    };

    onError = (error) => {
      finish({ ok: false, reason: "stream-error", error });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);

    stream.on(STREAM_EVENT_DATA, onData);
    stream.on(STREAM_EVENT_END, onEnd);
    stream.on(STREAM_EVENT_ERROR, onError);
  });
}
