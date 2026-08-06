#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Requests a JFrog Unified Policy waiver for a governance-blocked skill. Invoked by
// the agent (via Bash) when the user agrees to a waiver after a governance block —
// the scope flags come pre-filled from the block message; the user supplies only the
// justification. Usage: node request-waiver.mjs --application-key <k> --stage-key <k>
// --stage-gate <g> --justification "<reason>" [--expiry-days 30]. Resolves JFrog
// credentials the same way the hook does (JFROG_URL/JF_ACCESS_TOKEN, or `jf config
// export`), then POSTs to the waivers endpoint, printing a single JSON result line
// (for the agent to render a confirmation) and exiting non-zero on failure.

import process from "node:process";

import { resolveCredentials } from "./helpers/credentials.mjs";

const WAIVERS_PATH = "/ui/api/v1/unifiedpolicy/api/v1/waivers";
const DEFAULT_EXPIRY_DAYS = 30;
const TIMEOUT_MS = 10000;

// Emit a single JSON result line on stdout and exit. ok:true is a success the agent
// turns into a "Waiver requested" confirmation; ok:false is a failure to surface.
function done(result, code) {
  process.stdout.write(JSON.stringify(result));
  process.exit(code);
}

// Minimal --flag value parser (no deps). Unknown flags are ignored.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "";
    out[key] = value;
  }
  return out;
}

// N days from now as YYYY-MM-DDT00:00:00Z (matches the endpoint's absolute-timestamp
// shape; day-granularity is enough for a requested expiry).
function expiresAtInDays(days) {
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  return `${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`;
}

const args = parseArgs(process.argv.slice(2));
const applicationKey = args["application-key"];
const stageKey = args["stage-key"];
const stageGate = args["stage-gate"];
const justification = args["justification"];
const expiryDays = Number.isFinite(Number(args["expiry-days"]))
  ? Number(args["expiry-days"])
  : DEFAULT_EXPIRY_DAYS;

const missing = [
  ["application-key", applicationKey],
  ["stage-key", stageKey],
  ["stage-gate", stageGate],
  ["justification", justification],
].filter(([, v]) => !v || !String(v).trim());
if (missing.length > 0) {
  done(
    { ok: false, message: `Missing required argument(s): ${missing.map(([k]) => "--" + k).join(", ")}` },
    2,
  );
}

const credentials = resolveCredentials();
if (!credentials) {
  done(
    { ok: false, message: "No JFrog credentials found. Set JFROG_URL and JF_ACCESS_TOKEN (or run `jf config add`)." },
    1,
  );
}

const expiresAt = expiresAtInDays(expiryDays);
const url = credentials.baseUrl.replace(/\/+$/, "") + WAIVERS_PATH;
const payload = {
  scopes: [{ application_key: applicationKey, stage_key: stageKey, stage_gate: stageGate }],
  expires_at: expiresAt,
  justification,
};

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
try {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.token}`,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  const text = await response.text().catch(() => "");
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    done(
      { ok: false, httpStatus: response.status, message: `Waiver request failed (HTTP ${response.status}).`, response: body },
      1,
    );
  }
  done(
    {
      ok: true,
      status: "pending",
      requestedExpirationDays: expiryDays,
      expiresAt,
      scope: { applicationKey, stageKey, stageGate },
      waiver: body,
    },
    0,
  );
} catch (error) {
  const reason = error?.name === "AbortError" ? "timeout" : error?.message ?? "unknown error";
  done({ ok: false, message: `Waiver request failed: ${reason}` }, 1);
} finally {
  clearTimeout(timer);
}
