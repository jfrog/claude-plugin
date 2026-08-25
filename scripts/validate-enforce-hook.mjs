#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Tests the skill-enforcement hook wiring. hooks.json invokes agent-guard DIRECTLY via npx —
// no plugin-side wrapper script, so there is no plugin code in the enforcement path at all.
// Two properties make that safe, and both are asserted by executing the real command string
// out of hooks.json against a stub npx:
//
//   1. npx ONLY. There is deliberately no `command -v agent-guard` fast path: an agent-guard
//      earlier on PATH could be anything, whereas npx always resolves the package from the
//      pinned registry. Dropping that branch removes the hijack vector AND removes the
//      `command -v` that used to force POSIX-only syntax.
//   2. `|| exit 2` is load-bearing and cannot be replaced by an exit code inside agent-guard.
//      Claude Code blocks a PreToolUse hook on exit 2 ONLY; 1, 127 and spawn failures are all
//      non-blocking (the tool call proceeds). So when npx itself is missing the shell returns
//      127 and agent-guard never runs — nothing inside agent-guard could have blocked. Only
//      the `|| exit 2` in the hook converts that into a block.
//   3. `|| exit 2` only fires if the command EXITS. A hook that runs past its timeout is killed,
//      and Claude Code treats a timed-out hook as non-blocking — so a hang is a silent ALLOW,
//      the exact opposite of the intended verdict. npm's defaults hang for a long time on a
//      dead registry (70s to a refused port; over 10 minutes to one that drops packets), so
//      the fetch is bounded inline, below the hook timeout, to keep every infrastructure
//      failure on the exit-2 path rather than the timeout path.
//
// Registry traffic is split deliberately between the two kinds of hook, and the split is what
// makes an unpinned package spec affordable:
//
//   * The async SessionStart pre-warm resolves ONLINE (no --prefer-offline). It is the one
//     network round trip per session, and the only thing that pulls a newly published
//     agent-guard into the npx cache. Remove it and --prefer-offline below would pin the user
//     to whatever release they happened to download first.
//   * The two governed hooks resolve with --prefer-offline, so a warm cache satisfies them with
//     no network at all. PreToolUse fires on every Read, and a ~1s registry round trip per Read
//     is a tax the session pays thousands of times for a resolution the pre-warm already did.
//
// `"shell": "bash"` is set explicitly so Windows-without-Git-Bash fails LOUDLY (Claude Code
// raises a visible "requires bash … Install Git for Windows" hook error) instead of silently:
// left to default, such a machine runs the command under PowerShell, where `||` is a parse
// error that exits 1 — non-blocking, i.e. governance silently fails OPEN.

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
function stubNpx({ stdout = "", exitCode = 0 }) {
  const record = path.join(sandbox, "record.json");
  rmSync(record, { force: true });
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
  const p = path.join(binDir, "npx");
  writeFileSync(p, script, { mode: 0o755 });
  chmodSync(p, 0o755);
  return record;
}

// Run the hook exactly as Claude Code does for `shell: "bash"`: the command string from
// hooks.json handed to bash -c, hook event JSON on stdin, with the env Claude Code supplies.
// `isolate` drops the stub bin dir from PATH, which is how the "npx is not installed at all"
// case is reproduced.
function runHookCommand(command, payload, { extraEnv = {}, isolate = false } = {}) {
  // An ABSOLUTE bash: the PATH below is deliberately minimal (it is how the "npx is not
  // installed" case is reproduced), so `bash` by name would not resolve and spawnSync would
  // fail with status null before the command ever ran.
  const result = spawnSync(BASH, ["-c", command], {
    input: Buffer.from(payload),
    encoding: "buffer",
    // No check should ever reach the network; a hang means the stub was bypassed, and failing
    // fast beats waiting on a real npx download.
    timeout: 30_000,
    env: {
      // Deliberately minimal: node stays reachable for the stub's shebang, and nothing else —
      // in particular no real npx — is on it.
      PATH: isolate ? nodeDir : `${binDir}:${nodeDir}`,
      HOME: sandbox,
      CLAUDE_PLUGIN_ROOT: repoRoot,
      ...extraEnv,
    },
  });
  if (result.error) throw new Error(`could not run the hook command via ${BASH}: ${result.error.message}`);
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
  const warm = hooks.hooks.SessionStart[0].hooks[1];
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
    assert(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+ )*npx /.test(h.command),
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
    assert(h.command.trimEnd().endsWith("|| exit 2"),
      `${event} must end in "|| exit 2": exit 1/127 are NON-blocking, so nothing else fails closed`);
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
// chosen independently is what let 10s + 12s exceed a 20s hook and turn a block into a silent
// allow. Supplying the budget here makes one number drive both.
//
// `${VAR:-default}` and not a bare assignment: a bare `VAR=v cmd` beats the inherited
// environment, which would silently disable the documented operator override for clients whose
// hook timeout differs from Claude Code's.
check("the governed hooks supply agent-guard's budget without defeating the operator override", () => {
  for (const event of GOVERNED_EVENTS) {
    for (const h of hooksFor(event)) {
      assert(/JF_AGENT_GUARD_ENFORCE_TIMEOUT="\$\{JF_AGENT_GUARD_ENFORCE_TIMEOUT:-\d+s\}"/.test(h.command),
        `${event} must pass JF_AGENT_GUARD_ENFORCE_TIMEOUT="\${JF_AGENT_GUARD_ENFORCE_TIMEOUT:-<n>s}" so the hook owns the deadline and the operator can still override it`);
    }
  }
});

// Failing closed is a race the command has to win. `|| exit 2` blocks; a hook that overruns its
// timeout is killed and treated as NON-blocking, so the slowest possible failure of the command
// must land strictly inside the hook timeout or the block silently becomes an allow.
//
// npm's defaults lose that race. fetch-retries is 2 with a 10s/60s backoff and fetch-timeout is
// 300s, measured as 70s against a refused port and over ten minutes against a registry that
// drops packets — both far past a 20s hook. With retries off and a 10s fetch timeout the same
// three failure modes take 0.26s (DNS failure), 0.38s (refused) and 10.4s (dropped packets),
// each exiting non-zero and therefore each reaching `|| exit 2`.
//
// Retries are 0 deliberately. A single retry doubles the dropped-packet case to ~21s, which
// pushes it back over the hook timeout and turns the block into a silent allow — a retry here
// buys resilience by giving up the guarantee. Resilience lives in the SessionStart pre-warm
// instead: it keeps npm's defaults, has 180s, is async, and can block nobody.
//
// 10s still clears a legitimate cold start. A fully cold cache resolved and ran agent-guard in
// 13.0s end to end with this bound applied, so no individual request approached the limit.
check("the governed hooks bound their fetch so a dead registry exits before the hook times out", () => {
  for (const event of GOVERNED_EVENTS) {
    for (const h of hooksFor(event)) {
      const retries = /npm_config_fetch_retries=(\d+)/.exec(h.command);
      const fetchTimeout = /npm_config_fetch_timeout=(\d+)/.exec(h.command);
      assert(retries, `${event} must set npm_config_fetch_retries: npm's default of 2 backs off 10s then 60s`);
      assert(fetchTimeout, `${event} must set npm_config_fetch_timeout: npm's default is 300000ms, 15x the hook timeout`);
      assert(Number(retries[1]) === 0,
        `${event} sets fetch_retries=${retries[1]}; every retry multiplies the worst case and can push it past the hook timeout`);
      const worstCaseMs = Number(fetchTimeout[1]) * (Number(retries[1]) + 1);
      const hookTimeoutMs = (h.timeout ?? 0) * 1000;
      // The three terms are ADDITIVE, not overlapping: the client's timer starts when it spawns
      // this command, npm runs to completion first, and only then does agent-guard start its own
      // budget. "Half the hook budget stays free" used to stand in for agent-guard's share, but
      // it is a guess at a number this file can now read directly out of the command it ships.
      const budget = /JF_AGENT_GUARD_ENFORCE_TIMEOUT:-(\d+)s\}/.exec(h.command);
      assert(budget, `${event} must supply JF_AGENT_GUARD_ENFORCE_TIMEOUT so this bound can be checked`);
      const budgetMs = Number(budget[1]) * 1000;
      const RENDER_HEADROOM_MS = 5_000; // writing the card and flushing stdout after the verdict
      const needMs = worstCaseMs + budgetMs + RENDER_HEADROOM_MS;
      assert(needMs <= hookTimeoutMs,
        `${event}: a stalled fetch (${worstCaseMs}ms) plus agent-guard's budget (${budgetMs}ms) plus render headroom (${RENDER_HEADROOM_MS}ms) is ${needMs}ms against a ${hookTimeoutMs}ms hook timeout. They are additive, and overrunning the hook is NOT a block — the client kills it and treats that as allowed`);
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

await check("forwards stdin verbatim and hands agent-guard the expected argv", async () => {
  const record = stubNpx({ stdout: "" });
  const payload = `{"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"demo"}}`;
  const r = runHookCommand(commandFor("PreToolUse"), payload);
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

await check("forwards a deny verdict's stdout verbatim and exits 0 (the JSON decides)", async () => {
  const deny = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"nope"}}`;
  stubNpx({ stdout: deny });
  const r = runHookCommand(commandFor("PreToolUse"), "{}");
  assert(r.code === 0, `a rendered verdict must exit 0 and let the JSON decide, got exit=${r.code}`);
  assert(r.stdout === deny, `stdout altered: ${r.stdout}`);
});

await check("empty stdout means allow (no output, exit 0)", async () => {
  stubNpx({ stdout: "" });
  const r = runHookCommand(commandFor("PreToolUse"), "{}");
  assert(r.code === 0 && r.stdout === "", `exit=${r.code} stdout=${r.stdout}`);
});

await check("agent-guard failure yields exit exactly 2 (fail closed)", async () => {
  stubNpx({ stdout: "", exitCode: 1 });
  const r = runHookCommand(commandFor("PreToolUse"), "{}");
  assert(r.code === 2, `expected the fail-closed exit 2, got exit=${r.code}`);
});

// The case that justifies `|| exit 2` over an exit code inside agent-guard: with npx absent,
// agent-guard never runs, so only the hook itself can turn 127 into a block.
await check("npx missing entirely still fails closed (exit 2, not 127)", async () => {
  const r = runHookCommand(commandFor("PreToolUse"), "{}", { isolate: true });
  assert(r.code === 2, `a missing npx must fail closed with exit 2, got exit=${r.code}`);
});

await check("JFROG_AGENT_GUARD_REPO redirects the registry, and nothing can pin the version", async () => {
  const record = stubNpx({ stdout: "" });
  const r = runHookCommand(commandFor("PreToolUse"), "{}", {
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
