// jf-api.mjs — shared `jf api` bootstrap-call helpers for the web-login
// scripts (jfrog-login-register-session.mjs, jfrog-login-save-credentials.mjs).
// These run before any server exists in `jf config`, so every call goes
// through `jf api --url <url> ...` rather than a configured --server-id.
//
// Kept local to the `jfrog` skill rather than imported from
// jfrog-init/scripts/lib/jf.mjs — skills stay self-contained/portable, and
// jfrog-init's runJf() has no bootstrap (--url) mode anyway.

import { execFileSync } from "node:child_process";

// Matches jf rt ping's own network-call timeout (jfrog-init/scripts/lib/jf.mjs
// uses the same value for the same reason: long enough that a slow JPD
// doesn't misreport as "unreachable").
const JF_API_TIMEOUT_MS = 30_000;

// Parses the last "Http Status: NNN" line `jf api` prints — same regex
// logic as the original .sh scripts' jf_api_http_status(). Returns "0"
// when no such line is present, matching their sentinel for "couldn't
// determine a status."
export function parseHttpStatus(text) {
  const lines = String(text || "")
    .split("\n")
    .filter((l) => l.includes("Http Status:"));
  const line = lines[lines.length - 1] || "";
  const m = line.match(/Http Status:\s*(\d+)/);
  return m ? m[1] : "0";
}

// Runs `jf api <...args>`, returning both streams and exit info instead of
// throwing — a non-zero exit (unreachable server, a 400 on an unfinished
// login, etc) is an expected outcome the caller branches on, not a script
// bug. `shell: true` only on Windows, same reasoning as runJf() in
// jfrog-init/scripts/lib/jf.mjs (npm's .cmd shim needs it there; args here
// are never user-controlled shell metacharacters, only a URL/session-uuid
// already validated by the caller, so this carries no injection risk).
export function jfApi(args) {
  try {
    const stdout = execFileSync("jf", ["api", ...args], {
      encoding: "utf8",
      timeout: JF_API_TIMEOUT_MS,
      shell: process.platform === "win32",
      // Node's execFileSync/execSync echo the child's stderr to the
      // parent's own stderr live by default ("stderr by default will be
      // output to the parent's stderr unless stdio is specified" per the
      // Node docs) — on top of still populating err.stderr for a failed
      // call. Left at the default, every `jf api` info/warn log line
      // (e.g. "Http Status: NNN") would leak straight to the terminal,
      // unlike the original .sh scripts which always redirected both
      // streams to a temp file. Pinning stdio here keeps that same
      // silence: nothing is inherited, everything is still captured.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString() : "";
    const stderr = err.stderr ? err.stderr.toString() : "";
    return { ok: false, stdout, stderr, error: err };
  }
}
