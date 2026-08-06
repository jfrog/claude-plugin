#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Tests the skill-enforcement hook wiring. hooks.json invokes the plugin's Node wrapper
// (scripts/enforce-skill.mjs) in EXEC FORM — no shell, so it behaves identically on macOS,
// Linux, and Windows (with or without Git Bash). The wrapper itself contains no governance
// logic; it only transports the hook event to agent-guard and agent-guard's response back.
// These checks assert the hooks.json wiring's shape and then RUN the wrapper against a stub
// agent-guard to prove byte forwarding, the npx fallback, and the fail-closed exit semantics.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrapperPath = path.join(repoRoot, "scripts", "enforce-skill.mjs");
const waiverHelperPath = path.join(repoRoot, "scripts", "governance", "request-waiver.mjs");
const hooks = JSON.parse(readFileSync(path.join(repoRoot, "hooks", "hooks.json"), "utf8"));
const sandbox = mkdtempSync(path.join(tmpdir(), "enforce-hook-"));
const binDir = path.join(sandbox, "bin");
mkdirSync(binDir, { recursive: true });

const failures = [];
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures.push(label); console.log(`  FAIL ${label}\n         ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const SHELL_SYNTAX_MARKERS = ["if ", "||", "2>&1", "command -v", "${...:-", "${JFROG_AGENT_GUARD_REPO:-"];

function entriesFor(event) {
  return hooks?.hooks?.[event] ?? [];
}

function hooksFor(event) {
  return entriesFor(event).flatMap((entry) => entry.hooks ?? []);
}

// A stub agent-guard that records argv+stdin and replays a canned result.
function stubAgentGuard({ stdout = "", exitCode = 0 }) {
  const record = path.join(sandbox, "record.json");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input }));
  if (${JSON.stringify(stdout)}) process.stdout.write(${JSON.stringify(stdout)});
  process.exit(${exitCode});
});
`;
  writeFileSync(path.join(binDir, "agent-guard"), script, { mode: 0o755 });
  chmodSync(path.join(binDir, "agent-guard"), 0o755);
  return record;
}

// Run the Node wrapper the way Claude Code does: exec form, no shell, hook event JSON on
// stdin, with the env Claude Code would supply.
function runWrapper(payload, extraEnv = {}) {
  const result = spawnSync("node", [wrapperPath], {
    input: Buffer.from(payload),
    encoding: "buffer",
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: sandbox,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      ...extraEnv,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
  };
}

console.log("Validating the skill-enforcement hook wiring…");

check("hooks.json is valid JSON and keeps the SessionStart hook byte-identical", () => {
  assert(Array.isArray(hooks?.hooks?.SessionStart), "SessionStart entry missing");
  const sessionStart = hooks.hooks.SessionStart;
  assert(sessionStart.length === 1, "expected exactly one SessionStart entry group");
  const h = sessionStart[0]?.hooks?.[0];
  assert(
    h?.command === 'node "${CLAUDE_PLUGIN_ROOT}/modules/claude-session-start.mjs" package-resolution',
    "the package-resolution SessionStart hook command was altered",
  );
  assert(h?.timeout === 7, "the package-resolution SessionStart hook timeout was altered");
  assert(
    h?.statusMessage === "Routing package installs through JFrog Artifactory…",
    "the package-resolution SessionStart hook statusMessage was altered",
  );
});

for (const event of ["PreToolUse", "UserPromptExpansion"]) {
  check(`${event} invokes the Node wrapper in exec form (no shell)`, () => {
    const hs = hooksFor(event);
    assert(hs.length === 1, `expected exactly one ${event} hook, got ${hs.length}`);
    const h = hs[0];
    assert(h.command === "node", `${event} command must be exactly "node", got ${JSON.stringify(h.command)}`);
    assert(Array.isArray(h.args) && h.args.length === 1, `${event} must pass args: [<script path>]`);
    assert(
      h.args[0].endsWith("scripts/enforce-skill.mjs"),
      `${event} args[0] must point at scripts/enforce-skill.mjs, got ${h.args[0]}`,
    );
    assert(h.args[0].includes("${CLAUDE_PLUGIN_ROOT}"), `${event} args[0] must be rooted at \${CLAUDE_PLUGIN_ROOT}`);
    assert(!("shell" in h), `${event} must not set a shell field`);
    const fullCommandText = JSON.stringify(h);
    for (const marker of SHELL_SYNTAX_MARKERS) {
      assert(!fullCommandText.includes(marker), `${event} hook definition still contains shell syntax: ${marker}`);
    }
  });
}

check("PreToolUse matcher covers Skill and Read", () => {
  const entry = entriesFor("PreToolUse")[0];
  assert(/Skill/.test(entry?.matcher ?? "") && /Read/.test(entry?.matcher ?? ""),
    `matcher does not cover both: ${entry?.matcher}`);
});

check("both hooks allow for an npx cold start (timeout >= 20)", () => {
  for (const event of ["PreToolUse", "UserPromptExpansion"]) {
    for (const h of hooksFor(event)) assert((h.timeout ?? 0) >= 20, `${event} timeout ${h.timeout} < 20`);
  }
});

await check("forwards stdin verbatim and passes the expected flags to agent-guard", async () => {
  const record = stubAgentGuard({ stdout: "" });
  const payload = `{"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"demo"}}`;
  runWrapper(payload);
  const seen = JSON.parse(readFileSync(record, "utf8"));
  assert(seen.stdin === payload, `stdin altered: ${seen.stdin}`);
  assert(seen.argv.includes("--enforce-skill"), `argv missing --enforce-skill: ${seen.argv}`);
  assert(seen.argv[seen.argv.indexOf("--client") + 1] === "claude-code", `bad --client: ${seen.argv}`);
  const helper = seen.argv[seen.argv.indexOf("--waiver-helper") + 1];
  assert(helper === waiverHelperPath, `bad --waiver-helper: ${helper}`);
});

await check("forwards agent-guard stdout verbatim and exits 0", async () => {
  const deny = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"nope"}}`;
  stubAgentGuard({ stdout: deny });
  const r = runWrapper("{}");
  assert(r.code === 0, `exit=${r.code}`);
  assert(r.stdout === deny, `stdout altered: ${r.stdout}`);
});

await check("empty agent-guard stdout means allow (no output, exit 0)", async () => {
  stubAgentGuard({ stdout: "" });
  const r = runWrapper("{}");
  assert(r.code === 0 && r.stdout === "", `exit=${r.code} stdout=${r.stdout}`);
});

await check("agent-guard failure yields exit exactly 2 (fail closed)", async () => {
  stubAgentGuard({ stdout: "", exitCode: 1 });
  const r = runWrapper("{}");
  assert(r.code === 2, `expected the wrapper's fail-closed exit 2, got exit=${r.code}`);
});

await check("no agent-guard on PATH and an unreachable registry still fails closed (exit 2)", async () => {
  rmSync(path.join(binDir, "agent-guard"), { force: true });
  const r = runWrapper("{}", {
    JFROG_AGENT_GUARD_REPO: "http://127.0.0.1:1/",
    npm_config_offline: "true",
  });
  assert(r.code === 2, `an unreachable agent-guard must fail closed with exit 2, got exit=${r.code}`);
});

rmSync(sandbox, { recursive: true, force: true });
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log("\nAll checks passed.");
