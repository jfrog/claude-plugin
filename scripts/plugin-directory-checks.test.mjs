// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Tests the plugin directory pre-submission checks against temp-dir fixtures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checkDirectoryRules, listTrackedEntries } from "./plugin-directory-checks.mjs";

const README = `# Fixture\n\n${"word ".repeat(45)}\n`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

/** @type {string[]} */
const tempRoots = [];

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Writes the files into a new temp dir and returns the dir.
 * @param {Record<string, string | Buffer>} files
 * @returns {string}
 */
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "plugin-dir-checks-"));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries({ "README.md": README, ...files })) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

/**
 * Runs the checks with one regular-file entry per fixture file, plus `extra` entries.
 * @param {Record<string, string | Buffer>} files
 * @param {{ path: string, mode: string }[]} [extra]
 * @returns {string[]}
 */
function check(files, extra = []) {
  const root = fixture(files);
  const entries = ["README.md", ...Object.keys(files)].map((p) => ({ path: p, mode: "100644" }));
  return checkDirectoryRules(root, [...entries, ...extra]);
}

/**
 * @param {string[]} errors
 * @param {RegExp} pattern
 */
function assertOneError(errors, pattern) {
  assert.equal(errors.length, 1, `expected one error, got: ${JSON.stringify(errors)}`);
  assert.match(errors[0], pattern);
}

test("a clean plugin has no errors", () => {
  const hooks = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/a.mjs" start' }] },
      ],
    },
  });
  const errors = check({
    "hooks/hooks.json": hooks,
    "assets/logo.png": PNG,
    "assets/font.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00]),
    "skills/a/assets/.gitkeep": "",
    "scripts/a.mjs": "console.log('hi');\n",
  });
  assert.deepEqual(errors, []);
});

test("more than 512 files is an error", () => {
  const files = {};
  for (let i = 0; i < 512; i += 1) files[`docs/f${i}.md`] = "x";
  assertOneError(check(files), /file-count.*513/);
});

test("a text file over 256 KiB is an error", () => {
  assertOneError(check({ "docs/big.md": "a".repeat(256 * 1024 + 1) }), /file-size.*docs\/big\.md/);
});

test("an image over 256 KiB but under 5 MiB is fine", () => {
  const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
  assert.deepEqual(check({ "assets/big.png": big }), []);
});

test("any file over 5 MiB is an error", () => {
  const huge = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  assertOneError(check({ "assets/huge.png": huge }), /file-size.*assets\/huge\.png/);
});

for (const name of [".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX/x.txt"]) {
  test(`OS junk ${name} is an error`, () => {
    assertOneError(check({ [`docs/${name}`]: "x" }), /os-file.*docs\//);
  });
}

test("a symlink is an error", () => {
  assertOneError(check({}, [{ path: "docs/link", mode: "120000" }]), /symlink.*docs\/link/);
});

test("a submodule is an error", () => {
  assertOneError(check({}, [{ path: "vendor/sub", mode: "160000" }]), /submodule.*vendor\/sub/);
});

for (const bad of ["docs/a:b.md", "docs/trail.", "docs/trail ", "docs/con.md", "docs/LPT1", "docs/nul.txt"]) {
  test(`non-portable name ${JSON.stringify(bad)} is an error`, () => {
    // Paths the host filesystem cannot create are checked by entry only.
    const errors = checkDirectoryRules(fixture({}), [
      { path: "README.md", mode: "100644" },
      { path: bad, mode: "100644" },
    ]);
    assert.ok(errors.some((e) => /portable-name/.test(e) && e.includes(bad)), JSON.stringify(errors));
  });
}

test("paths that differ only by case are an error", () => {
  const errors = checkDirectoryRules(fixture({ "docs/a.md": "x" }), [
    { path: "README.md", mode: "100644" },
    { path: "docs/a.md", mode: "100644" },
    { path: "docs/A.md", mode: "100644" },
  ]);
  assertOneError(errors, /case-collision/);
});

test("a folder name with other characters is an error", () => {
  assertOneError(check({ "my docs/a.md": "x" }), /folder-name.*my docs/);
});

for (const attr of ["*.zip export-ignore", "VERSION export-subst", "*.bin filter=lfs diff=lfs"]) {
  test(`.gitattributes with ${JSON.stringify(attr)} is an error`, () => {
    assertOneError(check({ ".gitattributes": `${attr}\n` }), /gitattributes.*\.gitattributes/);
  });
}

test(".gitattributes with only text settings is fine", () => {
  assert.deepEqual(check({ ".gitattributes": "* text=auto eol=lf\n" }), []);
});

for (const bundle of ["server.mcpb", "server.dxt"]) {
  test(`${bundle} is an error`, () => {
    assertOneError(check({ [bundle]: "{}" }), new RegExp(`bundle.*${bundle.replace(".", "\\.")}`));
  });
}

test("a binary that is not an image or font is an error", () => {
  assertOneError(check({ "assets/icon.ico": Buffer.from([0x00, 0x00, 0x01, 0x00]) }), /binary.*icon\.ico/);
});

test("an image extension without a matching signature is an error", () => {
  assertOneError(check({ "assets/fake.png": Buffer.from([0x00, 0x01, 0x02]) }), /binary.*fake\.png/);
});

test("a missing README is an error", () => {
  const root = fixture({});
  rmSync(path.join(root, "README.md"));
  assertOneError(checkDirectoryRules(root, []), /readme.*missing/);
});

test("a four-backtick fence holding a three-backtick line is stripped whole", () => {
  const inner = `\`\`\`\`md\n\`\`\`bash\n${"code ".repeat(60)}\n\`\`\`\n${"more ".repeat(60)}\n\`\`\`\`\n`;
  assertOneError(check({ "README.md": `# Title\n\nToo short.\n\n${inner}` }), /readme.*words/);
});

test("an unclosed fence strips the rest of the README", () => {
  assertOneError(check({ "README.md": `# Title\n\nShort.\n\n\`\`\`\n${"code ".repeat(60)}\n` }), /readme.*words/);
});

test("an unreadable tracked file is reported with its path", { skip: process.getuid?.() === 0 }, () => {
  const root = fixture({ "docs/secret.md": "x" });
  chmodSync(path.join(root, "docs/secret.md"), 0o000);
  try {
    const errors = checkDirectoryRules(root, [
      { path: "README.md", mode: "100644" },
      { path: "docs/secret.md", mode: "100644" },
    ]);
    assertOneError(errors, /unreadable.*docs\/secret\.md/);
  } finally {
    chmodSync(path.join(root, "docs/secret.md"), 0o644);
  }
});

test("a README under 40 words outside code blocks is an error", () => {
  const short = `# Title\n\nToo short.\n\n\`\`\`bash\n${"code ".repeat(60)}\n\`\`\`\n`;
  assertOneError(check({ "README.md": short }), /readme.*words/);
});

for (const cfg of [".npmrc", "server/bunfig.toml", "uv.toml"]) {
  test(`package manager config ${cfg} is an error`, () => {
    assertOneError(check({ [cfg]: "registry=x\n" }), /package-manager-config/);
  });
}

/**
 * @param {string} command
 * @returns {string[]}
 */
function checkHookCommand(command) {
  const hooks = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command }] }] } });
  return check({ "hooks/hooks.json": hooks });
}

for (const [label, command] of [
  ["command substitution", 'node "${CLAUDE_PLUGIN_ROOT}/a.mjs" "$(date +%s)"'],
  ["a backtick substitution", 'node "${CLAUDE_PLUGIN_ROOT}/a.mjs" `date`'],
  ["another variable", 'node "${CLAUDE_PLUGIN_ROOT}/a.mjs" "${HOME}"'],
  ["a bare variable", 'node "${CLAUDE_PLUGIN_ROOT}/a.mjs" $HOME'],
  ["a wildcard", 'node "${CLAUDE_PLUGIN_ROOT}/scripts/"*.mjs'],
  ["an inline node program", 'node -e "console.log(1)"'],
  ["an inline python program", 'python3 -c "print(1)"'],
  ["an inline shell program", 'bash -c "echo hi"'],
  ["npx", "npx --yes @jfrog/agent-guard@1.27.0 --version"],
  ["uvx", "uvx tool==1.0.0"],
  ["pnpm dlx", "pnpm dlx tool@1.0.0"],
  ["uv run", "uv run --locked tool"],
]) {
  test(`a hook command with ${label} is an error`, () => {
    const errors = checkHookCommand(command);
    assert.ok(errors.length >= 1, `expected an error for ${command}`);
    assert.ok(errors.every((e) => /hook-command/.test(e)), JSON.stringify(errors));
  });
}

for (const command of [
  'node "${CLAUDE_PLUGIN_ROOT}/a.mjs" -e',
  'bash "${CLAUDE_PLUGIN_ROOT}/a.sh" -c fast',
]) {
  test(`a script argument that looks like an inline flag is fine: ${command}`, () => {
    assert.deepEqual(checkHookCommand(command), []);
  });
}

test("an inline flag after other interpreter options is an error", () => {
  const errors = checkHookCommand('node --no-warnings -e "console.log(1)"');
  assertOneError(errors, /hook-command.*inline program/);
});

test("invalid hooks.json is an error", () => {
  assertOneError(check({ "hooks/hooks.json": "{ not json" }), /hooks\.json.*JSON/);
});

test("listTrackedEntries reports file modes from git", () => {
  const root = fixture({ "docs/a.md": "x" });
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "README.md", "docs/a.md");
  assert.deepEqual(
    listTrackedEntries(root).sort((a, b) => (a.path < b.path ? -1 : 1)),
    [
      { path: "README.md", mode: "100644" },
      { path: "docs/a.md", mode: "100644" },
    ]
  );
});

test("listTrackedEntries throws outside a git checkout", () => {
  assert.throws(() => listTrackedEntries(fixture({})), /git checkout/);
});
