// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Shared JFrog credential resolution, used by the SessionStart injector and the
// skills-governance hooks. Zero dependencies.

import { execFileSync } from "node:child_process";
import process from "node:process";

// New JFROG_* env vars take precedence over the legacy JF_* names.
export const env = (newName, oldName) =>
    process.env[newName] ?? process.env[oldName];

// Resolve {baseUrl, token}: environment variables (JFROG_URL/JFROG_ACCESS_TOKEN,
// or legacy JF_*) are checked first; if either is missing, fall back to the
// JFrog CLI's default configured server via `jf config export`. Returns null
// when neither source yields usable credentials.
export function resolveCredentials() {
  const baseUrl = env("JFROG_URL", "JF_URL");
  const token = env("JFROG_ACCESS_TOKEN", "JF_ACCESS_TOKEN");
  if (baseUrl && token) {
    return { baseUrl, token };
  }

  // `jf config export` emits the default server as a base64-encoded JSON token.
  let configToken;
  try {
    configToken = execFileSync("jf", ["config", "export"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return null;
  }

  // The token is a base64-encoded JSON blob containing the server's url,
  // accessToken, and serverId — decode and validate it before using it.
  let cfg;
  try {
    cfg = JSON.parse(Buffer.from(configToken, "base64").toString("utf8"));
  } catch {
    return null;
  }

  if (!cfg?.url || !cfg?.accessToken) {
    return null;
  }

  return { baseUrl: cfg.url, token: cfg.accessToken };
}
