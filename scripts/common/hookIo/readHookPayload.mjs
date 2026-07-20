// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Reads a JSON payload from a stream (process.stdin by default). Mirrors
// httpClient's contract: never rejects — every outcome resolves to a
// discriminated result object:
//   success: { ok: true, payload }
//   failure: { ok: false, reason: "empty" | "invalid-json" | "timeout" | "stream-error", error? }
export function readHookPayload({ stream = process.stdin, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const onData = (chunk) => chunks.push(chunk);
    let onEnd;
    let onError;

    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
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

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
