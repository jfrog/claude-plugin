#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Tests the skill-enforcement hook wiring by executing the real command string out of hooks.json
// against a stub npx. Two facts are load-bearing:
//
//   1. Exit 2 is the ONLY code Claude Code treats as a blocking PreToolUse error. 1, 127, spawn
//      failures and a hook killed at the timeout are all non-blocking. So the hook must pass
//      agent-guard's exit code through untouched: agent-guard's 2 blocks, everything else fails
//      OPEN — which is the requirement, since a user who cannot run the guard is not governed by
//      it and blocking them enforces nothing.
//   2. npx ONLY, with no `command -v agent-guard` fast path: a binary earlier on PATH could be
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
import { fileURLToPath } from "node:url";

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
const GOVERNED_EVENTS = ["PreToolUse", "UserPromptExpansion"];
// Claude Code resolves `shell: "bash"` itself; here we only need A bash to execute the same
// string. /bin/bash exists on macOS and Linux, which is where this validator runs.
//
// COVERAGE GAP, deliberate: CI runs on Ubuntu, so nothing here exercises Windows. A Windows
// machine without Git Bash has no bash to resolve, the command never runs, and the action is
// allowed unchecked (README lists Git for Windows as a prerequisite for that reason). Reproducing
// it needs a Windows runner, not a different constant here.
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
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input }));
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

// Run the hook exactly as Claude Code does for `shell: "bash"`: the command string from
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
  const warm = (hooks.hooks.SessionStart[0].hooks ?? [])
    .find((h) => (h.command ?? "").includes("@jfrog/agent-guard") && (h.command ?? "").includes("--version"));
  assert(warm, "the agent-guard pre-warm SessionStart hook is missing");
  assert(warm.async === true, "the pre-warm MUST be async, or a 33 MB cold download blocks session start");
  assert(warm.shell === "bash", "the pre-warm uses bash syntax and must pin shell: bash");
  assert(warm.command.includes("--version"), "the pre-warm must use --version: it exits before mode selection, so it needs no credentials and has no side effects");
  assert(warm.command.trimEnd().endsWith("|| true"), "a failed pre-warm must never fail the session: it is only a cache warm");
  assert(!warm.command.includes("--enforce-skill"), "the pre-warm must not run an enforcement pass");
  assert(!warm.command.includes("--prefer-offline"),
    "the pre-warm MUST hit the registry: it is the only thing that refreshes the cache to the latest agent-guard, which is what makes the governed hooks' --prefer-offline safe");
  assert(!warm.command.includes("npm_config_fetch"),
    "the pre-warm must keep npm's default retries and fetch timeout: it is async, has 180s and ends in || true, so retrying through a flaky network costs nobody anything — the tight bounds belong only where a hang would fail open");
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
  check(`${event} invokes agent-guard through npx only, with no plugin script in the path`, () => {
    const hs = hooksFor(event);
    assert(hs.length === 1, `expected exactly one ${event} hook, got ${hs.length}`);
    const h = hs[0];
    assert(h.shell === "bash", `${event} must pin shell: "bash" so a missing Git Bash fails loudly`);
    assert(!("args" in h), `${event} must use shell form: npx is a .cmd shim on Windows and cannot be spawned in exec form`);
    // Leading `NAME=value` assignments are the fetch bounds asserted further down; past them
    // the very first word must still be npx, with no wrapper or interpreter in between.
    assert(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\S+) )*npx /.test(h.command),
      `${event} must invoke npx directly, got: ${h.command}`);
    assert(!h.command.includes("command -v"), `${event} must not have a PATH fast path: a hijackable agent-guard earlier on PATH would win`);
    assert(!/\.mjs["' ]*--enforce-skill|node .*enforce-skill/.test(h.command), `${event} must not route through a plugin wrapper script`);
    assert(h.command.includes("--enforce-skill") && h.command.includes("--client claude-code"),
      `${event} must pass --enforce-skill --client claude-code`);
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
    assert(h.command.includes(RELEASES_REGISTRY),
      `${event} must default to the releases registry, so the artifact is the published one`);
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
// Computed FRESH every invocation, as a BARE prefix assignment with no `${VAR:-…}` fallback. An
// absolute instant is valid for one run only: `:-` substitutes solely when the variable is unset
// or empty, so an exported value — a shell profile, a parent process, a CI runner — would pin
// every later invocation to a deadline already in the past. agent-guard then floors the budget at
// minEnforcementBudget, which a real JPD cannot answer within, and denies every governed skill
// permanently. A bare prefix assignment beats the inherited environment, which is what makes it
// safe. The operator knob is the DURATION form, which agent-guard takes as a lower bound; an
// absolute deadline is not something an operator can usefully pin.
check("the governed hooks compute the deadline fresh, with no inheritable fallback", () => {
  for (const event of GOVERNED_EVENTS) {
    for (const h of hooksFor(event)) {
      const m = /JF_AGENT_GUARD_ENFORCE_DEADLINE="\$\(\(\$\(date \+%s\) \+ (\d+)\)\)"/.exec(h.command);
      assert(m, `${event} must pass JF_AGENT_GUARD_ENFORCE_DEADLINE="$(($(date +%s) + N))"`);
      assert(!/JF_AGENT_GUARD_ENFORCE_DEADLINE="\$\{/.test(h.command),
        `${event} must not allow an inherited deadline: a stale absolute instant pins every invocation to the past`);
      // Deadline vs hook timeout ONLY. An earlier revision (432a6a9) also asserted
      // npm bound + agent-guard budget + render time <= timeout. That check is gone on purpose,
      // not by omission: its arithmetic was unsound, because npm_config_fetch_timeout is PER
      // REQUEST and a cold npx makes several plus a tarball download, so the "npm bound" term was
      // never a worst case and the sum it computed was not one either. The absolute deadline
      // subsumes what that sum was protecting — agent-guard stops at a wall-clock instant that
      // sits inside the timeout no matter how long npm took to get there.
      const budgetS = Number(m[1]);
      assert(budgetS < (h.timeout ?? 0),
        `${event}: the deadline (+${budgetS}s) must fall inside the ${h.timeout}s hook timeout, or agent-guard is killed before it can write its verdict`);
    }
  }
});

check("the governed hooks bound their fetch so a dead registry gives up quickly", () => {
  for (const event of GOVERNED_EVENTS) {
    for (const h of hooksFor(event)) {
      const retries = /npm_config_fetch_retries=(\d+)/.exec(h.command);
      const fetchTimeout = /npm_config_fetch_timeout=(\d+)/.exec(h.command);
      assert(retries && Number(retries[1]) === 0,
        `${event} must set npm_config_fetch_retries=0: npm's default of 2 backs off 10s then 60s`);
      // The VALUE, not just its presence: npm_config_fetch_timeout=300000 is npm's own default,
      // so asserting presence alone would let an edit back to the default pass unnoticed. The
      // bound has to stay well inside the hook timeout to be worth setting at all.
      assert(fetchTimeout && Number(fetchTimeout[1]) <= 10_000,
        `${event} must set npm_config_fetch_timeout <= 10000 (npm's default is 300000ms), got ${fetchTimeout?.[1]}`);
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

// agent-guard IS the enforcement. Letting the environment choose which build of it runs inverts
// the trust relationship: the machine being governed would pick its own governor, and could hold
// itself on a release that predates a policy. Every JFrog client invokes agent-guard unpinned;
// the registry stays overridable (air-gapped / self-hosted mirrors), the version never does.
await check("no hook can pin the agent-guard version", () => {
  for (const [event, entries] of Object.entries(hooks.hooks)) {
    for (const h of entries.flatMap((entry) => entry.hooks ?? [])) {
      if (!h.command.includes("@jfrog/agent-guard")) continue;
      assert(!h.command.includes("JFROG_AGENT_GUARD_VERSION"),
        `${event} reintroduced a version-pin override: ${h.command}`);
      assert(!/@jfrog\/agent-guard@/.test(h.command),
        `${event} hard-pins the agent-guard version: ${h.command}`);
      assert(h.command.includes("JFROG_AGENT_GUARD_REPO"),
        `${event} dropped the registry override, which air-gapped installs depend on: ${h.command}`);
    }
  }
});

rmSync(sandbox, { recursive: true, force: true });
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log("\nAll checks passed.");
