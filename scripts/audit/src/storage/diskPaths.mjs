// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import os from "node:os";
import path from "node:path";

export const PLUGIN_NAME = "claude-plugin";
export const JFROG_HOME_DIRNAME = ".jfrog";
export const AGENT_HOOKS_DIRNAME = "agent-hooks";

export const TOKEN_FILE = "token.json";
export const CONFIG_FILE = "config.json";

// Root-level singletons the GC must never reap, whatever their age.
export const SINGLETON_FILES = Object.freeze([TOKEN_FILE, CONFIG_FILE]);

// Per-tool file lifecycle: pre_ (Pre) -> post_ (Post) -> sending_ (Stop claim).
export const PRE_PREFIX = "pre_";
export const POST_PREFIX = "post_";
export const SENDING_PREFIX = "sending_";
export const TRACE_FILE_SUFFIX = ".json";

// Staging suffix produced by common/storage/atomicWrite; an orphaned .tmp is
// swept by the GC.
export const TMP_SUFFIX = ".tmp";

// A session_id / tool_use_id becomes a path segment, so it must be safe on every
// target OS (macOS, Linux, Windows). We allowlist a narrow character set rather
// than denylist hazards one platform at a time - harness-generated ids like
// "cs_abc123" / "toolu_01xyz" stay well inside it. The allowlist alone excludes
// path separators (/ \), NUL, ":" (Windows drive / NTFS alternate-data-stream),
// spaces, and every other byte; the extra guards below cover the traps that
// slip past a pure character check:
//   - "." / ".." are traversal (both pass the char allowlist);
//   - a trailing "." is silently stripped by Windows ("foo." -> "foo"), a hidden
//     collision;
//   - Windows reserved DEVICE names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) resolve
//     to a device, not a file - reserved case-insensitively and even with an
//     extension ("CON.json"), so we test the stem before the first ".".
// Reject rather than silently rewrite - the caller's hook boundary fails open on
// the throw.
const SAFE_SEGMENT = new RegExp("^[A-Za-z0-9._-]+$");
const WINDOWS_RESERVED = new RegExp("^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", "i");

function safeSegment(value) {
  if (
    typeof value !== "string" ||
    !SAFE_SEGMENT.test(value) ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    WINDOWS_RESERVED.test(value.split(".")[0])
  ) {
    throw new Error(`Unsafe on-disk path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function traceFileName(prefix, toolUseId) {
  return `${prefix}${safeSegment(toolUseId)}${TRACE_FILE_SUFFIX}`;
}

/**
 * The single source of truth for every on-disk path the audit hook uses, all
 * under the per-plugin root `~/.jfrog/agent-hooks/<plugin>/`. No other audit
 * module builds a path by hand. `home`/`plugin` are injectable so tests can
 * target a scratch directory.
 *
 * @returns {{
 *   root: string,
 *   tokenFile: string,
 *   configFile: string,
 *   sessionDir: (sessionId: string) => string,
 *   preFile: (sessionId: string, toolUseId: string) => string,
 *   postFile: (sessionId: string, toolUseId: string) => string,
 *   sendingFile: (sessionId: string, toolUseId: string) => string,
 * }}
 * @example
 * const paths = createDiskPaths();
 * paths.preFile("cs_abc", "toolu_123"); // .../claude-plugin/cs_abc/pre_toolu_123.json
 */
export function createDiskPaths({
  home = os.homedir(),
  plugin = PLUGIN_NAME,
} = {}) {
  const root = path.join(home, JFROG_HOME_DIRNAME, AGENT_HOOKS_DIRNAME, plugin);
  const sessionDir = (sessionId) => path.join(root, safeSegment(sessionId));
  const traceFile = (prefix) => (sessionId, toolUseId) =>
    path.join(sessionDir(sessionId), traceFileName(prefix, toolUseId));

  return {
    root,
    tokenFile: path.join(root, TOKEN_FILE),
    configFile: path.join(root, CONFIG_FILE),
    sessionDir,
    preFile: traceFile(PRE_PREFIX),
    postFile: traceFile(POST_PREFIX),
    sendingFile: traceFile(SENDING_PREFIX),
  };
}
