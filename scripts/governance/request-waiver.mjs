#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Requests a JFrog Unified Policy waiver for a governance-blocked skill. Invoked by the
// agent (via Bash) when the user agrees to a waiver after a governance block — the scope
// flags come pre-filled from the block message; the user supplies only the justification.
//
//   node request-waiver.mjs --project <k> --skill-name <n> --skill-version <v> \
//     --skill-repo-path <p> --justification "<reason>" [--expiry-days 30]
//
// Resolves JFrog credentials the same way the hook does (JFROG_URL/JF_ACCESS_TOKEN, or
// `jf config export`), then POSTs to the waivers endpoint, printing a single JSON result
// line (for the agent to render a confirmation) and exiting non-zero on failure.

import process from "node:process";

import { resolveCredentials } from "./helpers/credentials.mjs";

// The Unified Policy service's own REST path. NOT "/ui/api/v1/unifiedpolicy/api/v1/waivers":
// that is the UI reverse-proxy route, which authenticates a browser session and answers a
// bearer-token client with a bare 403 "Forbidden" — measured against a live JPD, and the
// reason this helper had never successfully created a waiver.
const WAIVERS_PATH = "/unifiedpolicy/api/v1/waivers";
const DEFAULT_EXPIRY_DAYS = 30;
const TIMEOUT_MS = 10000;

// The action type every skill-governance block is evaluated under. A skill is governed by
// `use_skill`, which is STAGE-LESS by contract: Unified Policy's use_skill action schema
// rejects any key beyond `type`, so sending a `stage` here is a 400 rather than a field the
// server ignores. This is not certify_to_gate — that is the AppTrust release-gate action, and
// a skill block carries no application/stage/gate to waive against.
const WAIVER_ACTION_TYPE = "use_skill";

// WaiverCreatePayload caps justification at 255 characters. The text is the user's own reason,
// relayed by a model that may pad it, so truncate here: a waiver that records a clipped reason
// is worth more to the user than an opaque HTTP 400.
const MAX_JUSTIFICATION = 255;

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
const projectKey = args["project"];
const skillName = args["skill-name"];
const skillVersion = args["skill-version"];
const skillRepoPath = args["skill-repo-path"];
const justification = args["justification"];
const expiryDays = Number.isFinite(Number(args["expiry-days"]))
  ? Number(args["expiry-days"])
  : DEFAULT_EXPIRY_DAYS;

// Every identity field is mandatory. Unified Policy matches a skill-scoped waiver on the
// whole triple (see buildSkillScopeCondition, which returns a never-matching predicate when
// any of them is empty), so a waiver created from a partial identity would be accepted,
// approved, and then match nothing — which reads to the user as access granted.
const missing = [
  ["project", projectKey],
  ["skill-name", skillName],
  ["skill-version", skillVersion],
  ["skill-repo-path", skillRepoPath],
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
// A skill waiver: `action.type: use_skill` with NO stage, plus exactly one `organization`
// scope whose sub_scope is the waiver-only `skill` type — project_keys narrowing WHERE, and
// skills[] naming WHICH package by the identity triple UP matches on.
//
// Deliberately not an `application` sub_scope with application_keys. That is the AppTrust
// shape, and it is the wrong one here twice over: a skill block has no application key (the
// governance report echoes the skill NAME into applicationKey, which is not the same thing),
// and an application-scoped waiver would not match a use_skill evaluation at all.
//
// A `project` sub_scope would also be accepted by the API and would match, but it waives
// use_skill for EVERY skill in the project — far broader than the block the user is
// responding to. Name the skill.
const payload = {
  action: { type: WAIVER_ACTION_TYPE },
  scopes: [
    {
      type: "organization",
      sub_scope: {
        type: "skill",
        project_keys: [projectKey],
        skills: [{ name: skillName, version: skillVersion, repo_path: skillRepoPath }],
      },
    },
  ],
  expires_at: expiresAt,
  justification: String(justification).slice(0, MAX_JUSTIFICATION),
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
      scope: { projectKey, skillName, skillVersion, skillRepoPath },
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
