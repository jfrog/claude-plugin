#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Tests the skill-enforcement hook wiring by executing the real command string out of hooks.json
// against a stub npx. hooks.json starts a node launcher (scripts/enforce-skill.mjs), which spawns
// agent-guard via npx. The launcher is not a policy engine: it only builds the argv, the deadline,
// and a spawn that Windows can run. The hook string itself cannot be a POSIX one-liner, because a
// Windows machine without Git Bash cannot run a `shell: "bash"` hook at all. Two facts are
// load-bearing:
//
//   1. Exit 2 is the ONLY code Claude Code treats as a blocking PreToolUse error. 1, 127, spawn
//      failures and a hook killed at the timeout are all non-blocking. So the hook must pass
//      agent-guard's exit code through untouched: agent-guard's 2 blocks, everything else fails
//      OPEN — which is the requirement, since a user who cannot run the guard is not governed by
//      it and blocking them enforces nothing.
//   2. npx ONLY (spawned by the launcher), with no `command -v agent-guard` fast path: a binary earlier on PATH could be
//      anything, whereas npx resolves the package from the configured registry. The registry is
//      fixed (overridable only by JFROG_AGENT_GUARD_REPO); the package spec deliberately is not,
//      because a check below forbids pinning the version of a security control.
//
// Registry traffic is split between the hooks: the async SessionStart pre-warm resolves ONLINE and
// is the only thing that pulls a newly published agent-guard into the cache; the governed hooks use
// --prefer-offline, because PreToolUse fires on every Read and a round trip per Read is a tax paid
// thousands of times for a resolution the pre-warm already did.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooks = JSON.parse(readFileSync(path.join(repoRoot, "hooks", "hooks.json"), "utf8"));
const sandbox = mkdtempSync(path.join(tmpdir(), "enforce-hook-"));
const binDir = path.join(sandbox, "bin");
mkdirSync(binDir, { recursive: true });

// A directory holding ONLY node, so the stub's shebang resolves while the real npx stays
// unreachable. Using node's own directory instead would silently defeat the "npx is missing"
// check: the real npx sits right beside node, so that check would reach the network and hang
// on a genuine 33 MB download rather than exercising the 127 path.
const nodeDir = path.join(sandbox, "node-only");
mkdirSync(nodeDir, { recursive: true });
symlinkSync(process.execPath, path.join(nodeDir, "node"));

const RELEASES_REGISTRY = "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";
const LAUNCHER_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/enforce-skill.mjs" --prefer-offline';
const WARM_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/warm-agent-guard.mjs"';
const GOVERNED_EVENTS = ["PreToolUse", "UserPromptExpansion"];
// On macOS and Linux Claude Code hands the hook string to a POSIX shell; /bin/bash exists on both,
// which is where this validator runs.
//
// COVERAGE GAP, deliberate: CI runs on Ubuntu, so nothing here EXECUTES the Windows path. The
// launcher's Windows spawn plan (npx.cmd under cmd.exe, cmd.exe quoting) is asserted as data by
// the resolveEnforceSpawn check below; actually running it needs a Windows runner.
const BASH = "/bin/bash";

const failures = [];
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures.push(label); console.log(`  FAIL ${label}\n         ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

function entriesFor(event) {
  return hooks?.hooks?.[event] ?? [];
}

function hooksFor(event) {
  return entriesFor(event).flatMap((entry) => entry.hooks ?? []);
}

// A stub npx that records the argv it was handed and the stdin it received, then replays a
// canned result. Installed as `npx` so the hook command finds it first on PATH.
function stubNpx({ stdout = "", exitCode = 0, sleepMs = 0 }) {
  const record = path.join(sandbox, "record.json");
  rmSync(record, { force: true });
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input, deadline: process.env.JF_AGENT_GUARD_ENFORCE_DEADLINE ?? "", retries: process.env.npm_config_fetch_retries ?? "", fetchTimeout: process.env.npm_config_fetch_timeout ?? "" }));
  setTimeout(() => {
    if (${JSON.stringify(stdout)}) process.stdout.write(${JSON.stringify(stdout)});
    process.exit(${exitCode});
  }, ${sleepMs});
});
`;
  const p = path.join(binDir, "npx");
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
  return record;
}

// Run the hook as Claude Code does on macOS/Linux: the command string from
// hooks.json handed to bash -c, hook event JSON on stdin, with the env Claude Code supplies.
// `isolate` drops the stub bin dir from PATH, which is how the "npx is not installed at all"
// case is reproduced.
function runHookCommand(command, payload, { extraEnv = {}, isolate = false, timeoutMs = 30_000 } = {}) {
  // An ABSOLUTE bash: the PATH below is deliberately minimal (it is how the "npx is not
  // installed" case is reproduced), so `bash` by name would not resolve and spawnSync would
  // fail with status null before the command ever ran.
  const result = spawnSync(BASH, ["-c", command], {
    input: Buffer.from(payload),
    encoding: "buffer",
    // No check should ever reach the network; a hang means the stub was bypassed, and failing
    // fast beats waiting on a real npx download. The timeout-kill check lowers this deliberately.
    timeout: timeoutMs,
    env: {
      // Deliberately minimal: node stays reachable for the stub's shebang, and nothing else —
      // in particular no real npx — is on it.
      PATH: isolate ? nodeDir : `${binDir}:${nodeDir}`,
      HOME: sandbox,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      ...extraEnv,
    },
  });
  // ETIMEDOUT is not a failure to run — it IS the killed-at-the-ceiling outcome the timeout check
  // asks for, and spawnSync reports it the same way it reports a genuine spawn error. Everything
  // else still throws, so a real spawn problem cannot masquerade as a passing check.
  if (result.error && result.error.code !== "ETIMEDOUT") {
    throw new Error(`could not run the hook command via ${BASH}: ${result.error.message}`);
  }
  return {
    code: result.status,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
  };
}

const commandFor = (event) => hooksFor(event)[0].command;

console.log("Validating the skill-enforcement hook wiring…");

check("hooks.json keeps the package-resolution SessionStart hook byte-identical", () => {
  const sessionStart = hooks?.hooks?.SessionStart;
  assert(Array.isArray(sessionStart), "SessionStart entry missing");
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

check("the npx cache pre-warm is async so it never delays session start", () => {
  // Found by content, not position: other features add SessionStart hooks, and an index pinned the
  // check to whichever hook happened to sit there.
  const warm = (hooks.hooks.SessionStart[0].hooks ?? []).find((h) => h.command === WARM_COMMAND);
  assert(warm, `the agent-guard pre-warm SessionStart hook is missing; expected: ${WARM_COMMAND}`);
  assert(warm.async === true, "the pre-warm MUST be async, or a 33 MB cold download blocks session start");
  assert(!("shell" in warm),
    "the pre-warm must not pin a shell: shell: \"bash\" never runs on Windows without Git Bash, " +
    "which leaves the governed hooks' --prefer-offline reading a cache nothing refreshes");
});

await check("the pre-warm resolves online with npm's default fetch policy, and cannot pin the version", async () => {
  const mod = await import(pathToFileURL(path.join(repoRoot, "scripts", "warm-agent-guard.mjs")).href);
  assert(typeof mod.resolveWarmSpawn === "function", "warm-agent-guard.mjs must export resolveWarmSpawn");
  const env = { JFROG_AGENT_GUARD_VERSION: "0.0.0-master.1.gabc" };
  const unix = mod.resolveWarmSpawn({ env, platform: "linux" });
  assert(unix.command === "npx" && unix.shell === false,
    `Unix must spawn npx with no shell, got ${unix.command} shell=${String(unix.shell)}`);
  assert(unix.args.includes("--version"),
    `the pre-warm must use --version: it exits before mode selection, so it needs no credentials and has no side effects: ${unix.args}`);
  assert(!unix.args.includes("--enforce-skill"), `the pre-warm must not run an enforcement pass: ${unix.args}`);
  assert(!unix.args.includes("--prefer-offline"),
    "the pre-warm MUST hit the registry: it is the only thing that refreshes the cache to the latest agent-guard, which is what makes the governed hooks' --prefer-offline safe");
  assert(unix.args[unix.args.indexOf("--registry") + 1] === RELEASES_REGISTRY, `default registry drifted: ${unix.args}`);
  assert(unix.args.includes("@jfrog/agent-guard") && !unix.args.some((a) => a.startsWith("@jfrog/agent-guard@")),
    `JFROG_AGENT_GUARD_VERSION must not pin the spec: ${unix.args}`);
  assert(unix.env.npm_config_fetch_retries === undefined && unix.env.npm_config_fetch_timeout === undefined,
    "the pre-warm must keep npm's default retries and fetch timeout: it is async and has 180s, so retrying through a flaky network costs nobody anything — the tight bounds belong only where a hang would fail open");
  const win = mod.resolveWarmSpawn({ env: { JFROG_AGENT_GUARD_REPO: "https://example.invalid/npm/?a=1&b=2" }, platform: "win32" });
  assert(win.command === "npx.cmd" && win.shell === "cmd.exe",
    `Windows must spawn npx.cmd through cmd.exe, got ${win.command} shell=${String(win.shell)}`);
  assert(win.args.includes('"https://example.invalid/npm/?a=1&b=2"') && win.args.includes('"--version"'),
    `Windows args must be quoted for cmd.exe: ${win.args}`);
});

check("the governed hooks resolve from cache, so no Read pays a registry round trip", () => {
  for (const event of GOVERNED_EVENTS) {
    for (const h of hooksFor(event)) {
      assert(h.command.includes("--prefer-offline"),
        `${event} must pass --prefer-offline; PreToolUse fires on every Read and a per-call registry lookup is a ~1s tax on each one`);
    }
  }
});

for (const event of GOVERNED_EVENTS) {
  check(`${event} starts the node launcher, with no POSIX syntax in the hook string`, () => {
    const hs = hooksFor(event);
    assert(hs.length === 1, `expected exactly one ${event} hook, got ${hs.length}`);
    const h = hs[0];
    assert(h.command === LAUNCHER_COMMAND,
      `${event} must be the node launcher. A POSIX env prefix or $(...) never starts on a Windows ` +
      `machine without Git Bash. Got: ${h.command}`);
    assert(!("shell" in h),
      `${event} must not pin a shell: shell: "bash" fails on Windows without Git Bash, and the ` +
      `launcher string runs under any shell`);
    const beyondPluginRoot = h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", "");
    assert(!beyondPluginRoot.includes("$"),
      `${event} command must not use shell substitution other than the plugin-root token ` +
      `Claude Code expands before the shell runs`);
    assert(!h.command.includes("command -v"), `${event} must not have a PATH fast path: a hijackable agent-guard earlier on PATH would win`);
    // The waiver request is agent-guard's own `--request-waiver` command now. The plugin used to
    // hand it the path to a Node helper it shipped; that script and its credential resolver are
    // gone, so passing the flag again would name a file that no longer exists.
    assert(!h.command.includes("--waiver-helper"),
      `${event} must not pass --waiver-helper: agent-guard owns the waiver flow`);
    assert(!h.command.includes("request-waiver"),
      `${event} must not reference a plugin-side waiver script`);
    // Inverted deliberately: infrastructure failures fail OPEN by requirement, so the hook must
    // NOT remap agent-guard's exit code. Only agent-guard can tell a broken environment from a
    // policy decision, and `|| exit 2` made every one of them look like a block.
    assert(!/\|\|\s*exit\s+2/.test(h.command),
      `${event} must not force exit 2: npx/install/credential failures fail open, and agent-guard's own exit 2 already blocks`);
  });
}

check("PreToolUse matcher covers Skill and Read", () => {
  const entry = entriesFor("PreToolUse")[0];
  assert(/Skill/.test(entry?.matcher ?? "") && /Read/.test(entry?.matcher ?? ""),
    `matcher does not cover both: ${entry?.matcher}`);
});

check("both governed hooks allow for an npx cold start (timeout >= 30)", () => {
  for (const event of GOVERNED_EVENTS) {
    for (const h of hooksFor(event)) assert((h.timeout ?? 0) >= 30, `${event} timeout ${h.timeout} < 30`);
  }
});

// The hook, not agent-guard, owns the enforcement deadline. agent-guard's own default (12s) is
// set in a different repo and cannot see the npm bound in front of it, so leaving the two to be
// chosen independently let the sum overrun the hook timeout and turn a block into a silent allow.
// Supplying the budget here makes one number drive both.
//
// Computed FRESH every invocation by the launcher, overwriting any inherited value. An absolute
// instant is valid for one run only: an exported value — a shell profile, a parent process, a CI
// runner — would pin every later invocation to a deadline already in the past. agent-guard then
// floors the budget at minEnforcementBudget, which a real JPD cannot answer within, and denies
// every governed skill permanently. When the clock is unusable the launcher DROPS the variable
// rather than pass a stale one: agent-guard ignores an absent deadline and uses its own budget.
//
// The fetch bounds live here too: npm_config_fetch_retries=0 (npm's default of 2 backs off 10s
// then 60s) and npm_config_fetch_timeout=10000 (npm's default is 300000ms).
await check("the launcher builds a bounded, unpinned spawn plan, with npx.cmd through cmd.exe on Windows", async () => {
  const launcherUrl = pathToFileURL(path.join(repoRoot, "scripts", "enforce-skill.mjs")).href;
  const mod = await import(launcherUrl);
  assert(typeof mod.resolveEnforceSpawn === "function",
    "enforce-skill.mjs must export resolveEnforceSpawn");
  const nowSec = 1_700_000_000;
  const common = {
    env: {
      JF_AGENT_GUARD_ENFORCE_DEADLINE: "1",
      JFROG_AGENT_GUARD_VERSION: "0.0.0-master.1.gabc",
      PATH: "C:\\Windows\\System32",
    },
    nowSec,
  };
  const win = mod.resolveEnforceSpawn({ ...common, preferOffline: true, platform: "win32" });
  assert(win.command === "npx.cmd", `Windows must spawn npx.cmd, got ${win.command}`);
  assert(win.shell === "cmd.exe",
    `Windows must pin cmd.exe so ComSpec cannot select PowerShell, got ${String(win.shell)}`);
  assert(win.args.includes('"--prefer-offline"'), `missing offline flag: ${win.args}`);
  assert(win.args.includes(`"${RELEASES_REGISTRY}"`), `registry must be quoted for cmd.exe: ${win.args}`);
  assert(win.args.includes('"@jfrog/agent-guard"'), `package spec must stay unpinned: ${win.args}`);
  assert(win.args.includes('"claude-code"'), `--client must be claude-code: ${win.args}`);
  assert(!win.args.some((arg) => arg.includes("@jfrog/agent-guard@")),
    `JFROG_AGENT_GUARD_VERSION must not pin the spec: ${win.args}`);
  assert(win.env.JF_AGENT_GUARD_ENFORCE_DEADLINE === String(nowSec + 25),
    `deadline must replace an inherited value; got ${win.env.JF_AGENT_GUARD_ENFORCE_DEADLINE}`);
  assert(win.env.npm_config_fetch_retries === "0",
    "npm_config_fetch_retries=0 is required: npm's default of 2 backs off 10s then 60s");
  assert(win.env.npm_config_fetch_timeout === "10000",
    `npm_config_fetch_timeout must be 10000 (npm's default is 300000), got ${win.env.npm_config_fetch_timeout}`);
  const quoted = mod.resolveEnforceSpawn({
    preferOffline: true,
    env: { JFROG_AGENT_GUARD_REPO: "https://example.invalid/npm/?a=1&b=2" },
    nowSec,
    platform: "win32",
  });
  assert(quoted.args.includes('"https://example.invalid/npm/?a=1&b=2"'),
    `a registry & must stay inside one cmd.exe argument: ${quoted.args}`);
  const unix = mod.resolveEnforceSpawn({ ...common, preferOffline: true, platform: "linux" });
  assert(unix.command === "npx" && unix.shell === false,
    `Unix must spawn npx with no shell, got ${unix.command} shell=${String(unix.shell)}`);
  assert(unix.args[unix.args.indexOf("--registry") + 1] === RELEASES_REGISTRY,
    `default registry drifted: ${unix.args}`);
  const stale = mod.resolveEnforceSpawn({
    preferOffline: true,
    env: { JF_AGENT_GUARD_ENFORCE_DEADLINE: "1" },
    nowSec: Number.NaN,
    platform: "linux",
  });
  assert(stale.env.JF_AGENT_GUARD_ENFORCE_DEADLINE === undefined,
    `an unusable clock must drop an inherited deadline, got ${stale.env.JF_AGENT_GUARD_ENFORCE_DEADLINE}`);
  // Deadline vs hook timeout: agent-guard must stop at a wall-clock instant inside the timeout,
  // or it is killed before it can write its verdict.
  const budgetS = Number(unix.env.JF_AGENT_GUARD_ENFORCE_DEADLINE) - nowSec;
  for (const event of GOVERNED_EVENTS) {
    for (const h of hooksFor(event)) {
      assert(budgetS < (h.timeout ?? 0),
        `${event}: the deadline (+${budgetS}s) must fall inside the ${h.timeout}s hook timeout`);
    }
  }
});

check("the two governed hooks run byte-identical commands", () => {
  assert(commandFor("PreToolUse") === commandFor("UserPromptExpansion"),
    "PreToolUse and UserPromptExpansion must enforce identically; they have drifted apart");
});

// ---------------------------------------------------------------------------
// Behavioural checks: execute the real hooks.json command string.
// ---------------------------------------------------------------------------

// Run every behavioural check against BOTH governed events, not just PreToolUse. The
// byte-identical check above already makes divergence loud, but it only holds while it runs
// first; looping here means a future hook that stops being identical is still exercised on its
// own terms rather than inheriting PreToolUse's result.
for (const event of GOVERNED_EVENTS) {
  await check(`${event}: forwards stdin verbatim and hands agent-guard the expected argv`, async () => {
    const record = stubNpx({ stdout: "" });
    const payload = `{"hook_event_name":"${event}","tool_name":"Skill","tool_input":{"skill":"demo"}}`;
    const r = runHookCommand(commandFor(event), payload);
    assert(r.code === 0, `exit=${r.code} stderr=${r.stderr}`);
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert(seen.stdin === payload, `stdin altered: ${seen.stdin}`);
    assert(seen.argv.includes("--enforce-skill"), `argv missing --enforce-skill: ${seen.argv}`);
    assert(seen.argv[seen.argv.indexOf("--client") + 1] === "claude-code", `bad --client: ${seen.argv}`);
    assert(!seen.argv.includes("--waiver-helper"),
      `--waiver-helper must not reach agent-guard; it owns the waiver flow: ${seen.argv}`);
    assert(seen.argv[seen.argv.indexOf("--registry") + 1] === RELEASES_REGISTRY,
      `must default to the releases registry: ${seen.argv}`);
    assert(seen.argv.includes("@jfrog/agent-guard"),
      `the package spec must always be the unpinned "@jfrog/agent-guard": ${seen.argv}`);
    assert(seen.argv.includes("--prefer-offline"), `${event} must read the npx cache: ${seen.argv}`);
    assert(seen.retries === "0" && seen.fetchTimeout === "10000",
      `fetch must be bounded: retries=${seen.retries} timeout=${seen.fetchTimeout}`);
  });

  await check(`${event}: hands agent-guard a deadline in the future, recomputed over an inherited one`, async () => {
    const record = stubNpx({ stdout: "" });
    const before = Math.floor(Date.now() / 1000);
    const r = runHookCommand(commandFor(event), "{}", { extraEnv: { JF_AGENT_GUARD_ENFORCE_DEADLINE: "1" } });
    assert(r.code === 0, `exit=${r.code} stderr=${r.stderr}`);
    const seen = JSON.parse(readFileSync(record, "utf8"));
    const deadline = Number(seen.deadline);
    assert(Number.isFinite(deadline) && deadline > before,
      `the deadline must be recomputed, not inherited; got ${JSON.stringify(seen.deadline)}`);
  });

  await check(`${event}: forwards a deny verdict's stdout verbatim and exits 0 (the JSON decides)`, async () => {
    const deny = `{"hookSpecificOutput":{"hookEventName":"${event}","permissionDecision":"deny","permissionDecisionReason":"nope"}}`;
    stubNpx({ stdout: deny });
    const r = runHookCommand(commandFor(event), "{}");
    assert(r.code === 0, `a rendered verdict must exit 0 and let the JSON decide, got exit=${r.code}`);
    assert(r.stdout === deny, `stdout altered: ${r.stdout}`);
  });

  await check(`${event}: empty stdout means allow (no output, exit 0)`, async () => {
    stubNpx({ stdout: "" });
    const r = runHookCommand(commandFor(event), "{}");
    assert(r.code === 0 && r.stdout === "", `exit=${r.code} stdout=${r.stdout}`);
  });

  // Infrastructure failures fail OPEN, by product requirement: a user who cannot run the guard is
  // not governed by it, and blocking them enforces nothing except their inability to work. The hook
  // therefore does NOT convert failures into exit 2 — agent-guard's own exit code is the verdict,
  // and only agent-guard can tell a broken environment from a policy decision.
  await check(`${event}: an agent-guard failure fails OPEN, not closed`, async () => {
    stubNpx({ stdout: "", exitCode: 1 });
    const r = runHookCommand(commandFor(event), "{}");
    assert(r.code !== 2, `exit 2 blocks; an internal failure must fail open, got exit=${r.code}`);
  });

  await check(`${event}: npx missing entirely fails OPEN`, async () => {
    const r = runHookCommand(commandFor(event), "{}", { isolate: true });
    assert(r.code !== 2, `a missing npx must not block, got exit=${r.code}`);
  });

  // The header calls a hook killed at the client's timeout non-blocking. This EMULATES that kill
  // rather than reproducing it — Claude Code owns the real timer, and nothing here can drive it —
  // by giving spawnSync a ceiling well under the stub's sleep and asserting what survives the
  // kill. What matters is the shape of the result: a killed command cannot yield exit 2, so it
  // cannot block, which is exactly why the command must not rely on being killed to fail closed.
  await check(`${event}: a hook killed at the timeout does not block`, async () => {
    stubNpx({ stdout: "", exitCode: 2, sleepMs: 4_000 });
    const r = runHookCommand(commandFor(event), "{}", { timeoutMs: 1_000 });
    assert(r.code !== 2,
      `a killed hook must not surface as a block, got exit=${r.code}`);
  });

  // The other half of the same rule, and the one that must never regress: when agent-guard DOES
  // reach a decision to block, the hook has to pass it through untouched. Nothing in the command
  // may swallow, remap, or re-raise its exit code.
  await check(`${event}: agent-guard's own exit 2 still blocks`, async () => {
    stubNpx({ stdout: "", exitCode: 2 });
    const r = runHookCommand(commandFor(event), "{}");
    assert(r.code === 2, `agent-guard blocked; the hook must propagate exit 2, got exit=${r.code}`);
  });

  await check(`${event}: JFROG_AGENT_GUARD_REPO redirects the registry, and nothing can pin the version`, async () => {
    const record = stubNpx({ stdout: "" });
    const r = runHookCommand(commandFor(event), "{}", {
      extraEnv: {
        JFROG_AGENT_GUARD_REPO: "https://example.invalid/npm/dev/",
        // Set on purpose: the pin mechanism was deliberately removed, so this must have NO effect.
        // If a future edit reintroduces it, this check turns that back into a visible failure.
        JFROG_AGENT_GUARD_VERSION: "0.0.0-master.1.gabc",
      },
    });
    assert(r.code === 0, `exit=${r.code} stderr=${r.stderr}`);
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert(seen.argv[seen.argv.indexOf("--registry") + 1] === "https://example.invalid/npm/dev/",
      `registry override ignored: ${seen.argv}`);
    assert(seen.argv.includes("@jfrog/agent-guard"),
      `the package spec must stay plain "@jfrog/agent-guard": ${seen.argv}`);
    assert(!seen.argv.some((a) => a.startsWith("@jfrog/agent-guard@")),
      `an env var pinned the version of a security control: ${seen.argv}`);
  });
}

await check("pre-warm: hands npx the online --version argv, and JFROG_AGENT_GUARD_REPO redirects it", async () => {
  let record = stubNpx({ stdout: "agent-guard 1.0.0\n" });
  let r = runHookCommand(WARM_COMMAND, "{}");
  assert(r.code === 0 && r.stdout === "", `the pre-warm must exit 0 and print nothing, got exit=${r.code} stdout=${r.stdout}`);
  let seen = JSON.parse(readFileSync(record, "utf8"));
  assert(seen.argv.includes("--version") && !seen.argv.includes("--prefer-offline"), `bad pre-warm argv: ${seen.argv}`);
  assert(seen.argv[seen.argv.indexOf("--registry") + 1] === RELEASES_REGISTRY, `must default to the releases registry: ${seen.argv}`);
  record = stubNpx({ stdout: "" });
  r = runHookCommand(WARM_COMMAND, "{}", { extraEnv: { JFROG_AGENT_GUARD_REPO: "https://example.invalid/npm/dev/" } });
  seen = JSON.parse(readFileSync(record, "utf8"));
  assert(seen.argv[seen.argv.indexOf("--registry") + 1] === "https://example.invalid/npm/dev/",
    `registry override ignored: ${seen.argv}`);
});

await check("pre-warm: a failed or missing npx never fails the session", async () => {
  stubNpx({ stdout: "", exitCode: 1 });
  let r = runHookCommand(WARM_COMMAND, "{}");
  assert(r.code === 0, `a failed pre-warm must exit 0, got exit=${r.code}`);
  r = runHookCommand(WARM_COMMAND, "{}", { isolate: true });
  assert(r.code === 0, `a missing npx must exit 0, got exit=${r.code}`);
});

// agent-guard IS the enforcement. Letting the environment choose which build of it runs inverts
// the trust relationship: the machine being governed would pick its own governor, and could hold
// itself on a release that predates a policy. Every JFrog client invokes agent-guard unpinned;
// the registry stays overridable (air-gapped / self-hosted mirrors), the version never does. The
// launchers ignore JFROG_AGENT_GUARD_VERSION (asserted above); no hook string may add a pin either.
await check("no hook can pin the agent-guard version", () => {
  for (const [event, entries] of Object.entries(hooks.hooks)) {
    for (const h of entries.flatMap((entry) => entry.hooks ?? [])) {
      assert(!h.command.includes("JFROG_AGENT_GUARD_VERSION"),
        `${event} reintroduced a version-pin override: ${h.command}`);
      assert(!/@jfrog\/agent-guard@/.test(h.command),
        `${event} hard-pins the agent-guard version: ${h.command}`);
    }
  }
});

rmSync(sandbox, { recursive: true, force: true });
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log("\nAll checks passed.");
