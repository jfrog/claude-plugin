// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// stdout is reserved for the caller's own response, so all output here goes
// to stderr, never stdout.

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

export function logToStderr(message) {
  process.stderr.write(stringifyMessage(message) + "\n");
}

// Lets multiple call sites share stderr while staying distinguishable.
export function createLogger(prefix) {
  return (message) => {
    const text = stringifyMessage(message);
    logToStderr(prefix ? `[${prefix}] ${text}` : text);
  };
}
