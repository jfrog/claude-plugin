// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

function stringifyMessage(message) {
  if (typeof message === "string") return message;
  // JSON.stringify can throw (circular refs, BigInt); fall back to String(),
  // which never does.
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * Writes a message to stderr. stdout is reserved for the caller's own
 * response, so all logging here goes to stderr, never stdout.
 *
 * @returns {void}
 * @example
 * logToStderr("hook started");
 */
export function logToStderr(message) {
  process.stderr.write(stringifyMessage(message) + "\n");
}

/**
 * Builds a logger that prefixes every message, letting multiple call sites
 * share stderr while staying distinguishable.
 *
 * @returns {(message: any) => void}
 * @example
 * const log = createLogger("Pre");
 * log("config fetched");
 * // stderr: [Pre] config fetched
 */
export function createLogger(prefix) {
  return (message) => {
    const text = stringifyMessage(message);
    logToStderr(prefix ? `[${prefix}] ${text}` : text);
  };
}
