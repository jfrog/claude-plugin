// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Pre-submission checks from the Claude plugin directory checklist that
// `claude plugin validate --profile directory` does not run:
// https://claude.com/docs/plugins/pre-submission-checklist
// Items the directory blocks and items it holds for a reviewer are both errors.

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";

const MAX_FILES = 512;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_ANY_BYTES = 5 * 1024 * 1024;
const MIN_README_WORDS = 40;
const BINARY_SNIFF_BYTES = 8000;

const OS_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini", "__macosx"]);
const PACKAGE_MANAGER_CONFIGS = new Set([".npmrc", "bunfig.toml", "uv.toml"]);
const BUNDLE_EXTENSIONS = new Set([".mcpb", ".dxt"]);
const FONT_EXTENSIONS = new Set([".woff", ".woff2", ".ttf", ".otf"]);
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const FOLDER_NAME = /^[A-Za-z0-9._-]+$/;

/** @type {Record<string, (head: Buffer) => boolean>} */
const IMAGE_SIGNATURES = {
  ".png": (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ".jpg": (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  ".jpeg": (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  ".gif": (h) => h.subarray(0, 4).toString("latin1") === "GIF8",
  ".webp": (h) => h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP",
};

const LAUNCHERS = [/\bnpx\b/, /\bbunx\b/, /\bpnpm\s+dlx\b/, /\byarn\s+dlx\b/, /\buvx\b/, /\bpipx\s+run\b/, /\buv\s+run\b/];
// The flag must come before the first non-option argument: after a script path it is the script's own argument.
const INLINE_PROGRAM = /\b(node|python3?|bash|sh)(?:\s+-\S+)*?\s+(-c|-e|--eval)(?=\s|$)/;
const ALLOWED_VARIABLE = "CLAUDE_PLUGIN_ROOT";

/**
 * Lists the files git tracks under `root`, with their git modes.
 * @param {string} root
 * @returns {{ path: string, mode: string }[]}
 */
export function listTrackedEntries(root) {
  let out;
  try {
    out = execFileSync("git", ["ls-files", "-s", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`directory checks need a git checkout: git ls-files failed in ${root}: ${err.message}`);
  }
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { mode: line.slice(0, line.indexOf(" ")), path: line.slice(tab + 1) };
    });
}

/**
 * Runs the directory checks over `entries` (paths relative to `root`).
 * @param {string} root
 * @param {{ path: string, mode: string }[]} entries
 * @returns {string[]} one message per violation, each starting with its rule name
 */
export function checkDirectoryRules(root, entries) {
  /** @type {string[]} */
  const errors = [];
  const add = (rule, message) => errors.push(`[${rule}] ${message}`);

  if (entries.length > MAX_FILES) {
    add("file-count", `${entries.length} tracked files; the directory holds plugins with more than ${MAX_FILES}`);
  }

  checkNames(entries, add);

  for (const entry of entries) {
    if (entry.mode === "120000") {
      add("symlink", `${entry.path} is a symlink; use a regular file`);
      continue;
    }
    if (entry.mode === "160000") {
      add("submodule", `${entry.path} is a git submodule; vendor its files instead`);
      continue;
    }
    checkFile(root, entry.path, add);
  }

  checkReadme(root, add);
  checkHooks(root, entries, add);
  return errors;
}

/**
 * @param {{ path: string }[]} entries
 * @param {(rule: string, message: string) => void} add
 */
function checkNames(entries, add) {
  /** @type {Map<string, string>} */
  const seen = new Map();
  /** @type {Set<string>} */
  const reportedFolders = new Set();
  for (const { path: rel } of entries) {
    const segments = rel.split("/");
    const osSegment = segments.find((s) => OS_FILES.has(s.toLowerCase()));
    if (osSegment) add("os-file", `${rel}: remove ${osSegment}`);

    const badSegment = segments.find((s) => s.includes(":") || /[. ]$/.test(s) || WINDOWS_DEVICE.test(s));
    if (badSegment !== undefined) add("portable-name", `${rel}: "${badSegment}" is not a portable file name`);

    for (let i = 0; i < segments.length - 1; i += 1) {
      const folder = segments.slice(0, i + 1).join("/");
      if (!FOLDER_NAME.test(segments[i]) && !reportedFolders.has(folder)) {
        reportedFolders.add(folder);
        add("folder-name", `${folder}: folder names may use only letters, digits, ".", "-" and "_"`);
      }
    }

    const key = rel.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined && other !== rel) add("case-collision", `${rel} and ${other} differ only by case`);
    else seen.set(key, rel);

    const base = segments[segments.length - 1];
    if (PACKAGE_MANAGER_CONFIGS.has(base)) {
      add("package-manager-config", `${rel}: package-manager config that sets a registry is not allowed`);
    }
    if (BUNDLE_EXTENSIONS.has(path.extname(base).toLowerCase())) {
      add("bundle", `${rel}: declare MCP servers with command/args or url, not a .mcpb/.dxt bundle`);
    }
  }
}

/**
 * Size, binary type and .gitattributes rules for one regular file.
 * @param {string} root
 * @param {string} rel
 * @param {(rule: string, message: string) => void} add
 */
function checkFile(root, rel, add) {
  const full = path.join(root, rel);
  let size;
  let head;
  try {
    size = statSync(full).size;
    head = readHead(full);
  } catch (err) {
    // Not on disk (e.g. a name the host cannot create): the name checks already ran.
    if (err.code !== "ENOENT") add("unreadable", `${rel} could not be read: ${err.message}`);
    return;
  }
  const ext = path.extname(rel).toLowerCase();
  const isImage = ext in IMAGE_SIGNATURES && IMAGE_SIGNATURES[ext](head);
  const isFont = FONT_EXTENSIONS.has(ext);

  if (size > MAX_ANY_BYTES) {
    add("file-size", `${rel} is ${size} bytes; every file must be under ${MAX_ANY_BYTES}`);
  } else if (size > MAX_TEXT_BYTES && !isImage && !isFont) {
    add("file-size", `${rel} is ${size} bytes; files other than images and fonts must be under ${MAX_TEXT_BYTES}`);
  }

  if (head.includes(0) && !isImage && !isFont) {
    add("binary", `${rel} is binary; only text, PNG/JPEG/GIF/WebP images and fonts are allowed`);
  }

  if (path.basename(rel) === ".gitattributes") {
    const content = readFileSync(full, "utf8");
    const banned = content.match(/(?:^|\s)(-?export-ignore|-?export-subst|-?filter(?:=\S*)?)(?=\s|$)/m);
    if (banned) add("gitattributes", `${rel} sets "${banned[1]}"; the directory refuses archive and content-rewriting attributes`);
  }
}

/**
 * @param {string} file
 * @returns {Buffer}
 */
function readHead(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
    const n = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {string} root
 * @param {(rule: string, message: string) => void} add
 */
function checkReadme(root, add) {
  let text;
  try {
    text = readFileSync(path.join(root, "README.md"), "utf8");
  } catch {
    add("readme", "README.md is missing");
    return;
  }
  const words = stripFencedCode(text).split(/\s+/).filter(Boolean).length;
  if (words < MIN_README_WORDS) {
    add("readme", `README.md has ${words} words outside code blocks; at least ${MIN_README_WORDS} are required`);
  }
}

/**
 * Drops fenced code blocks. A fence closes only on a run of the same character at least as
 * long as the opener; an unclosed fence runs to the end of the file, as in CommonMark.
 * @param {string} text
 * @returns {string}
 */
function stripFencedCode(text) {
  /** @type {string | null} */
  let fence = null;
  const kept = [];
  for (const line of text.split("\n")) {
    if (fence === null) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) fence = open[1];
      else kept.push(line);
      continue;
    }
    const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
  }
  return kept.join("\n");
}

/**
 * @param {string} root
 * @param {{ path: string }[]} entries
 * @param {(rule: string, message: string) => void} add
 */
function checkHooks(root, entries, add) {
  const rel = "hooks/hooks.json";
  if (!entries.some((e) => e.path === rel)) return;
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
  } catch (err) {
    add("hook-command", `${rel} is not valid JSON: ${err.message}`);
    return;
  }
  for (const [event, groups] of Object.entries(config?.hooks ?? {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
        if (typeof hook?.command !== "string") continue;
        for (const problem of hookCommandProblems(hook.command)) {
          add("hook-command", `${rel} ${event}: ${problem}: ${hook.command}`);
        }
      }
    }
  }
}

/**
 * @param {string} command
 * @returns {string[]}
 */
function hookCommandProblems(command) {
  const problems = [];
  if (command.includes("$(") || command.includes("`")) problems.push("command substitution");
  const variables = [...command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const others = [...new Set(variables.filter((v) => v !== ALLOWED_VARIABLE))];
  if (others.length > 0) problems.push(`variables other than ${ALLOWED_VARIABLE} (${others.join(", ")})`);
  if (command.replace(/"[^"]*"|'[^']*'/g, "").includes("*")) problems.push("wildcard");
  if (INLINE_PROGRAM.test(command)) problems.push("inline program");
  if (LAUNCHERS.some((re) => re.test(command))) problems.push("package launcher");
  return problems;
}
