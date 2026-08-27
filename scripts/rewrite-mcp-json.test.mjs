import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AGENT_GUARD_BIN_ENV,
  AGENT_GUARD_PACKAGE,
  DEFAULT_AGENT_GUARD_NPM_REGISTRY,
  DEFAULT_AGENT_GUARD_VERSION,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_REWRITE_TIMEOUT_MS,
  DISABLE_ENV,
  FORCE_ENV,
  OUTCOME,
  STRICT_ENV,
  activeProjectFromSetupFile,
  buildAgentGuardRewriteArgs,
  buildNpxArgs,
  buildNpxSpawnOptions,
  computeRewriteFingerprint,
  hasJfrogUrlTokenEnv,
  isRewriteDisabled,
  isSafeRewriteIdentifier,
  killRewriteChildTree,
  parseJfConfigShowJson,
  parseRewriteMcpJsonResult,
  pickDefaultJfCliServer,
  pipelineResult,
  quoteSpawnArgs,
  quoteWindowsArg,
  redactUrlCredentials,
  resolveAgentGuardBin,
  resolveAgentGuardCommand,
  resolveAgentGuardNpmRegistry,
  resolveAgentGuardSpec,
  resolveNpxCommand,
  resolveRewriteProject,
  resolveRewriteServer,
  resolveRewriteServerId,
  runAgentGuardRewriteMcpJson,
  runRewriteMcpJsonPipeline,
} from "../modules/core/rewrite-mcp-json.mjs";

/** Minimal env for rewrite argv / pipeline happy paths. */
const PROJ_SRV = { JF_PROJECT: "proj1", JF_SERVER: "my-server" };

/** Avoid real `jf config show` in unit tests. */
function noJfConfig() {
  return () => ({ status: 1, stdout: "" });
}

/**
 * Isolated skip-if-current marker so rewriting pipeline tests never share the
 * real `~/.jfrog` default marker (cross-test fingerprint collisions).
 * @returns {string}
 */
function freshMarkerPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-marker-"));
  return path.join(dir, "rewrite.marker");
}

/**
 * @param {{ serverId: string, url?: string, isDefault?: boolean }[]} servers
 */
function mockJfConfigShow(servers) {
  return () => ({
    status: 0,
    stdout: JSON.stringify(
      servers.map((s) => ({
        serverId: s.serverId,
        url: s.url ?? "",
        isDefault: Boolean(s.isDefault),
      })),
    ),
  });
}

/**
 * @param {{ code?: number, stdout?: string, stderr?: string } | (() => { code?: number, stdout?: string, stderr?: string })} resultOrFactory
 */
function mockSpawn(resultOrFactory) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {}, on: () => child.stdin };
    child.kill = () => true;
    child.pid = 99;
    queueMicrotask(() => {
      const result =
        typeof resultOrFactory === "function"
          ? resultOrFactory()
          : resultOrFactory;
      if (result.stdout) child.stdout.emit("data", result.stdout);
      if (result.stderr) child.stderr.emit("data", result.stderr);
      child.emit("close", result.code ?? 0);
    });
    return child;
  };
}

test("isRewriteDisabled respects kill switch", () => {
  assert.equal(isRewriteDisabled({}), false);
  assert.equal(isRewriteDisabled({ [DISABLE_ENV]: "0" }), false);
  assert.equal(isRewriteDisabled({ [DISABLE_ENV]: "1" }), true);
});

test("pipelineResult maps failed_* to exit 1 only under STRICT", () => {
  assert.deepEqual(pipelineResult(OUTCOME.REWRITTEN, "", {}), {
    exitCode: 0,
    outcome: OUTCOME.REWRITTEN,
    reason: "",
  });
  assert.deepEqual(pipelineResult(OUTCOME.FAILED_SPAWN, "boom", {}), {
    exitCode: 0,
    outcome: OUTCOME.FAILED_SPAWN,
    reason: "boom",
  });
  assert.deepEqual(
    pipelineResult(OUTCOME.FAILED_SPAWN, "boom", { [STRICT_ENV]: "1" }),
    {
      exitCode: 1,
      outcome: OUTCOME.FAILED_SPAWN,
      reason: "boom",
    },
  );
  assert.deepEqual(
    pipelineResult(OUTCOME.SKIPPED_NO_SERVER, "x", { [STRICT_ENV]: "1" }),
    {
      exitCode: 0,
      outcome: OUTCOME.SKIPPED_NO_SERVER,
      reason: "x",
    },
  );
});

test("resolveNpxCommand uses npx.cmd on Windows", () => {
  assert.equal(resolveNpxCommand("darwin"), "npx");
  assert.equal(resolveNpxCommand("win32"), "npx.cmd");
});

test("buildNpxSpawnOptions shells on Windows and detaches on POSIX", () => {
  assert.deepEqual(buildNpxSpawnOptions({ FOO: "1" }, "darwin"), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { FOO: "1" },
    shell: false,
    detached: true,
  });
  assert.deepEqual(buildNpxSpawnOptions({ FOO: "1" }, "win32"), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { FOO: "1" },
    shell: "cmd.exe",
    detached: false,
  });
  assert.deepEqual(
    buildNpxSpawnOptions({ FOO: "1" }, "win32", { local: true }),
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { FOO: "1" },
      shell: false,
      detached: false,
    },
  );
});

test("buildNpxArgs includes --rewrite-mcp-json paths, project, and --server", () => {
  const mcp = "/tmp/mcp.json";
  const base = buildNpxArgs({
    paths: [mcp],
    allowRoots: ["/tmp"],
    env: { ...PROJ_SRV },
  });
  assert.deepEqual(base.slice(0, 4), [
    "--yes",
    "--registry",
    DEFAULT_AGENT_GUARD_NPM_REGISTRY,
    `${AGENT_GUARD_PACKAGE}@${DEFAULT_AGENT_GUARD_VERSION}`,
  ]);
  assert.equal(base[4], "--rewrite-mcp-json");
  assert.ok(base.includes(mcp));
  assert.ok(base.includes("--project"));
  assert.ok(base.includes("proj1"));
  assert.ok(base.includes("--server"));
  assert.ok(base.includes("my-server"));
  assert.ok(base.includes("--allow-root"));
  assert.ok(base.includes("/tmp"));
  assert.ok(base.includes("--format"));
  assert.ok(base.includes("json"));
  assert.match(DEFAULT_AGENT_GUARD_VERSION, /^\d+\.\d+\.\d+/);

  const withFlags = buildNpxArgs({
    paths: [mcp],
    env: {
      ...PROJ_SRV,
      JFROG_AGENT_GUARD_REPO: "https://example.com/npm/",
    },
  });
  assert.ok(withFlags.includes("--server"));
  assert.ok(withFlags.includes("my-server"));
  assert.equal(withFlags.filter((a) => a === "--registry").length, 2);
});

test("resolveAgentGuardNpmRegistry / Spec honor overrides", () => {
  assert.equal(
    resolveAgentGuardNpmRegistry({}),
    DEFAULT_AGENT_GUARD_NPM_REGISTRY,
  );
  assert.equal(
    resolveAgentGuardNpmRegistry({ JFROG_AGENT_GUARD_REPO: " https://r/ " }),
    "https://r/",
  );
  assert.equal(
    resolveAgentGuardSpec({}),
    `${AGENT_GUARD_PACKAGE}@${DEFAULT_AGENT_GUARD_VERSION}`,
  );
  assert.equal(
    resolveAgentGuardSpec({ JFROG_AGENT_GUARD_VERSION: "latest" }),
    `${AGENT_GUARD_PACKAGE}@latest`,
  );
});

test("buildAgentGuardRewriteArgs requires project, server, and paths", () => {
  assert.throws(
    () =>
      buildAgentGuardRewriteArgs({
        paths: [],
        env: { ...PROJ_SRV },
      }),
    /at least one/,
  );
  assert.throws(
    () =>
      buildAgentGuardRewriteArgs({ paths: ["/x"], env: { JF_SERVER: "s" } }),
    /JF_PROJECT/,
  );
  assert.throws(
    () =>
      buildAgentGuardRewriteArgs({
        paths: ["/x"],
        env: { JF_PROJECT: "p" },
      }),
    /JF_SERVER/,
  );
  assert.deepEqual(
    buildAgentGuardRewriteArgs({
      paths: ["/x/mcp.json"],
      allowRoots: ["/x"],
      env: {
        ...PROJ_SRV,
        JFROG_AGENT_GUARD_REPO: "https://example.com/npm/",
      },
    }),
    [
      "--rewrite-mcp-json",
      "/x/mcp.json",
      "--project",
      "proj1",
      "--server",
      "my-server",
      "--registry",
      "https://example.com/npm/",
      "--allow-root",
      "/x",
      "--format",
      "json",
    ],
  );
});

test("buildAgentGuardRewriteArgs always passes --server even with URL+token env", () => {
  assert.equal(
    hasJfrogUrlTokenEnv({
      JFROG_URL: "https://mycompany.jfrog.io",
      JFROG_ACCESS_TOKEN: "tok",
    }),
    true,
  );
  const args = buildAgentGuardRewriteArgs({
    paths: ["/tmp/mcp.json"],
    env: {
      ...PROJ_SRV,
      JFROG_URL: "https://mycompany.jfrog.io",
      JFROG_ACCESS_TOKEN: "tok",
    },
  });
  assert.ok(args.includes("--server"));
  assert.ok(args.includes("my-server"));
});

test("Agent Guard rewrite argv uses --rewrite-mcp-json not legacy flag names", () => {
  const args = buildAgentGuardRewriteArgs({
    paths: ["/tmp/mcp.json"],
    env: { ...PROJ_SRV },
  });
  assert.equal(args[0], "--rewrite-mcp-json");
  assert.ok(!args.includes("--align-mcp-json"));
  assert.ok(!args.includes("--align-plugin-mcps"));
});

test("resolveAgentGuardBin trims and treats blank as unset", () => {
  assert.equal(resolveAgentGuardBin({}), undefined);
  assert.equal(
    resolveAgentGuardBin({ [AGENT_GUARD_BIN_ENV]: "   " }),
    undefined,
  );
  assert.equal(
    resolveAgentGuardBin({ [AGENT_GUARD_BIN_ENV]: " /opt/agent-guard " }),
    "/opt/agent-guard",
  );
});

test("resolveAgentGuardCommand uses npx by default", () => {
  const resolved = resolveAgentGuardCommand({
    paths: ["/tmp/mcp.json"],
    env: { ...PROJ_SRV },
    platform: "darwin",
  });
  assert.equal(resolved.command, "npx");
  assert.equal(resolved.local, false);
  assert.equal(resolved.args[4], "--rewrite-mcp-json");
  assert.ok(resolved.args.includes("--server"));
});

test("resolveAgentGuardCommand runs local binary directly when overridden", () => {
  const resolved = resolveAgentGuardCommand({
    paths: ["/tmp/mcp.json"],
    allowRoots: ["/tmp"],
    env: {
      [AGENT_GUARD_BIN_ENV]: "/opt/agent-guard",
      JF_PROJECT: "p",
      JF_SERVER: "srv",
    },
    platform: "darwin",
  });
  assert.equal(resolved.command, "/opt/agent-guard");
  assert.equal(resolved.local, true);
  assert.deepEqual(resolved.args, [
    "--rewrite-mcp-json",
    "/tmp/mcp.json",
    "--project",
    "p",
    "--server",
    "srv",
    "--allow-root",
    "/tmp",
    "--format",
    "json",
  ]);
  assert.ok(!resolved.args.includes("--yes"));
  assert.ok(!resolved.args.some((a) => a.includes(AGENT_GUARD_PACKAGE)));
});

test("activeProjectFromSetupFile reads currentActiveProject", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-setup-"));
  const setupPath = path.join(dir, "setup.json");
  writeFileSync(
    setupPath,
    JSON.stringify({
      version: 1,
      servers: {
        "my-server": {
          jpdUrl: "https://mycompany.jfrog.io",
          currentActiveProject: "from-setup",
        },
        other: {
          jpdUrl: "https://other.jfrog.io",
          currentActiveProject: "other-proj",
        },
      },
    }),
    "utf8",
  );

  assert.equal(
    activeProjectFromSetupFile("my-server", "https://mycompany.jfrog.io", {
      setupPath,
    }),
    "from-setup",
  );
  assert.equal(
    activeProjectFromSetupFile("my-server", "", { setupPath }),
    "from-setup",
  );
  assert.equal(
    activeProjectFromSetupFile("", "https://other.jfrog.io", { setupPath }),
    "other-proj",
  );
  assert.equal(
    activeProjectFromSetupFile("missing", "https://mycompany.jfrog.io", {
      setupPath,
    }),
    "from-setup",
  );
  assert.equal(
    activeProjectFromSetupFile("nope", "https://nowhere.jfrog.io", {
      setupPath,
    }),
    "",
  );
});

test("resolveRewriteProject prefers env then setup.json", () => {
  assert.equal(resolveRewriteProject({ JF_PROJECT: " from-env " }), "from-env");
  assert.equal(resolveRewriteProject({ JFROG_PROJECT: "alt" }), "alt");

  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-proj-"));
  const setupPath = path.join(dir, "setup.json");
  writeFileSync(
    setupPath,
    JSON.stringify({
      version: 1,
      servers: {
        srv: {
          jpdUrl: "https://mycompany.jfrog.io",
          currentActiveProject: "from-setup",
        },
      },
    }),
    "utf8",
  );
  assert.equal(
    resolveRewriteProject(
      {},
      {
        serverId: "srv",
        jpdUrl: "https://mycompany.jfrog.io",
        setupPath,
      },
    ),
    "from-setup",
  );
  assert.equal(
    resolveRewriteProject(
      { JF_PROJECT: "env-wins" },
      { serverId: "srv", setupPath },
    ),
    "env-wins",
  );
});

test("parseJfConfigShowJson and pickDefaultJfCliServer", () => {
  assert.deepEqual(parseJfConfigShowJson(""), []);
  assert.deepEqual(parseJfConfigShowJson("not-json"), []);
  assert.deepEqual(
    parseJfConfigShowJson(
      JSON.stringify([
        { serverId: "a", url: "https://a.jfrog.io/", isDefault: false },
        { serverId: "b", Url: "https://b.jfrog.io", isDefault: true },
      ]),
    ),
    [
      { serverId: "a", jpdUrl: "https://a.jfrog.io", isDefault: false },
      { serverId: "b", jpdUrl: "https://b.jfrog.io", isDefault: true },
    ],
  );

  assert.deepEqual(pickDefaultJfCliServer([]), { error: "missing" });
  assert.deepEqual(
    pickDefaultJfCliServer([
      { serverId: "only", jpdUrl: "https://o.jfrog.io", isDefault: false },
    ]),
    { serverId: "only", jpdUrl: "https://o.jfrog.io" },
  );
  assert.deepEqual(
    pickDefaultJfCliServer([
      { serverId: "a", jpdUrl: "https://a.jfrog.io", isDefault: false },
      { serverId: "b", jpdUrl: "https://b.jfrog.io", isDefault: true },
    ]),
    { serverId: "b", jpdUrl: "https://b.jfrog.io" },
  );
  assert.deepEqual(
    pickDefaultJfCliServer([
      { serverId: "a", jpdUrl: "https://a.jfrog.io", isDefault: false },
      { serverId: "b", jpdUrl: "https://b.jfrog.io", isDefault: false },
    ]),
    { error: "no_default" },
  );
});

test("resolveRewriteServer: hint, sole, default, env, ambiguous, missing", () => {
  assert.deepEqual(
    resolveRewriteServer(
      {},
      { serverIdHint: " hint-srv ", spawnSyncFn: noJfConfig() },
    ),
    { serverId: "hint-srv", jpdUrl: "" },
  );

  assert.deepEqual(
    resolveRewriteServer(
      {},
      {
        serverIdHint: "hint-srv",
        spawnSyncFn: mockJfConfigShow([
          {
            serverId: "hint-srv",
            url: "https://hint.jfrog.io",
            isDefault: false,
          },
        ]),
      },
    ),
    { serverId: "hint-srv", jpdUrl: "https://hint.jfrog.io" },
  );

  assert.deepEqual(
    resolveRewriteServer(
      {},
      {
        spawnSyncFn: mockJfConfigShow([
          { serverId: "sole", url: "https://sole.jfrog.io" },
        ]),
      },
    ),
    { serverId: "sole", jpdUrl: "https://sole.jfrog.io" },
  );

  assert.deepEqual(
    resolveRewriteServer(
      {},
      {
        spawnSyncFn: mockJfConfigShow([
          { serverId: "a", url: "https://a.jfrog.io", isDefault: false },
          { serverId: "b", url: "https://b.jfrog.io", isDefault: true },
        ]),
      },
    ),
    { serverId: "b", jpdUrl: "https://b.jfrog.io" },
  );

  assert.deepEqual(
    resolveRewriteServer(
      { JF_SERVER: " from-env " },
      {
        spawnSyncFn: mockJfConfigShow([
          { serverId: "a", url: "https://a.jfrog.io", isDefault: false },
          { serverId: "from-env", url: "https://e.jfrog.io", isDefault: false },
        ]),
      },
    ),
    { serverId: "from-env", jpdUrl: "https://e.jfrog.io" },
  );

  assert.deepEqual(
    resolveRewriteServer(
      {},
      {
        spawnSyncFn: mockJfConfigShow([
          { serverId: "a", url: "https://a.jfrog.io", isDefault: false },
          { serverId: "b", url: "https://b.jfrog.io", isDefault: false },
        ]),
      },
    ),
    { error: "no_default" },
  );

  assert.deepEqual(resolveRewriteServer({}, { spawnSyncFn: noJfConfig() }), {
    error: "missing",
  });

  // URL+token must not suppress server resolution.
  assert.equal(
    resolveRewriteServerId(
      {
        JFROG_URL: "https://mycompany.jfrog.io",
        JFROG_ACCESS_TOKEN: "tok",
        JF_SERVER: "keep-me",
      },
      { spawnSyncFn: noJfConfig() },
    ),
    "keep-me",
  );
});

test("runAgentGuardRewriteMcpJson spawns the local binary when overridden", async () => {
  /** @type {{ command?: string, args?: string[], opts?: object }} */
  const spawned = {};
  const result = await runAgentGuardRewriteMcpJson({
    paths: ["/tmp/mcp.json"],
    env: {
      [AGENT_GUARD_BIN_ENV]: "/opt/agent-guard",
      JF_PROJECT: "p",
      JF_SERVER: "srv",
    },
    spawnFn: (command, args, opts) => {
      spawned.command = command;
      spawned.args = args;
      spawned.opts = opts;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {}, on: () => child.stdin };
      child.kill = () => true;
      child.pid = 99;
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ scanned: 1, rewritten: 0 }));
        child.emit("close", 0);
      });
      return child;
    },
    timeoutMs: 0,
  });
  assert.equal(result.code, 0);
  assert.equal(spawned.command, "/opt/agent-guard");
  assert.ok(spawned.args?.includes("--rewrite-mcp-json"));
  assert.ok(spawned.args?.includes("--server"));
  assert.ok(spawned.args?.includes("srv"));
  assert.equal(spawned.opts?.shell, false);
});

test("runAgentGuardRewriteMcpJson skips cmd.exe for local bin on Windows", async () => {
  /** @type {{ command?: string, args?: string[], opts?: object }} */
  const spawned = {};
  const bin = String.raw`C:\Program Files\agent-guard\bin.exe`;
  const result = await runAgentGuardRewriteMcpJson({
    paths: [String.raw`C:\tmp\mcp.json`],
    env: {
      [AGENT_GUARD_BIN_ENV]: bin,
      JF_PROJECT: "my-proj",
      JF_SERVER: "srv",
    },
    platform: "win32",
    spawnFn: (command, args, opts) => {
      spawned.command = command;
      spawned.args = args;
      spawned.opts = opts;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: () => {}, on: () => child.stdin };
      child.kill = () => true;
      child.pid = 99;
      queueMicrotask(() => {
        child.stdout.emit("data", '{"scanned":1,"rewritten":0}');
        child.emit("close", 0);
      });
      return child;
    },
    timeoutMs: 0,
  });
  assert.equal(result.code, 0);
  assert.equal(spawned.command, bin);
  assert.ok(spawned.args?.includes("--project"));
  assert.ok(spawned.args?.includes("my-proj"));
  assert.ok(spawned.args?.includes("--server"));
  assert.equal(spawned.opts?.shell, false);
});

test("quoteSpawnArgs only quotes on Windows", () => {
  assert.deepEqual(quoteSpawnArgs(["a b"], "darwin"), ["a b"]);
  assert.deepEqual(quoteSpawnArgs(["a b"], "win32"), ['"a b"']);
});

test("quoteWindowsArg uses cmd.exe quoting (doubled quotes, %% for %)", () => {
  assert.equal(quoteWindowsArg("proj1"), '"proj1"');
  assert.equal(quoteWindowsArg("a b"), '"a b"');
  assert.equal(quoteWindowsArg("my project"), '"my project"');
  assert.equal(quoteWindowsArg("a&b"), '"a&b"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say ""hi"""');
  assert.equal(quoteWindowsArg("safe-project"), '"safe-project"');
  // Embedded quote + metacharacters must not break out of the quoted token.
  assert.equal(quoteWindowsArg('a"&calc&"b'), '"a""&calc&""b"');
  // %VAR% expansion must be neutralized inside the quoted token.
  assert.equal(quoteWindowsArg("%PATH%"), '"%%PATH%%"');
  assert.equal(quoteWindowsArg("pre%TEMP%post"), '"pre%%TEMP%%post"');
  // Pipe / caret / redirect metacharacters stay inside the quoted token.
  assert.equal(quoteWindowsArg("a|b"), '"a|b"');
  assert.equal(quoteWindowsArg("a^b"), '"a^b"');
  assert.equal(quoteWindowsArg("a<b>c"), '"a<b>c"');
});

test("quoteWindowsArg rejects CR/LF to prevent cmd.exe breakout", () => {
  assert.throws(() => quoteWindowsArg("line1\nwhoami"), /CR\/LF/);
  assert.throws(() => quoteWindowsArg("line1\r\nwhoami"), /CR\/LF/);
  assert.doesNotThrow(() => quoteWindowsArg("safe-project"));
});

test("isSafeRewriteIdentifier accepts JF project/server grammar", () => {
  assert.equal(isSafeRewriteIdentifier("proj1"), true);
  assert.equal(isSafeRewriteIdentifier("my-server"), true);
  assert.equal(isSafeRewriteIdentifier("a.b_c-1"), true);
  assert.equal(isSafeRewriteIdentifier(""), false);
  assert.equal(isSafeRewriteIdentifier(" my "), false);
  assert.equal(isSafeRewriteIdentifier("a b"), false);
  assert.equal(isSafeRewriteIdentifier('a"&calc&"b'), false);
  assert.equal(isSafeRewriteIdentifier("%PATH%"), false);
  assert.equal(isSafeRewriteIdentifier("evil\nwhoami"), false);
});

test("buildAgentGuardRewriteArgs rejects unsafe project/server identifiers", () => {
  assert.throws(
    () =>
      buildAgentGuardRewriteArgs({
        paths: ["/tmp/mcp.json"],
        project: 'a"&calc&"b',
        serverId: "srv",
      }),
    /safe identifier/,
  );
  assert.throws(
    () =>
      buildAgentGuardRewriteArgs({
        paths: ["/tmp/mcp.json"],
        project: "proj1",
        serverId: "%PATH%",
      }),
    /safe identifier/,
  );
});

test("runAgentGuardRewriteMcpJson soft-fails when Windows args contain CR/LF", async () => {
  const result = await runAgentGuardRewriteMcpJson({
    paths: ["/tmp/mcp.json"],
    env: { JF_PROJECT: "evil\r\nwhoami", JF_SERVER: "srv" },
    platform: "win32",
    spawnFn: () => assert.fail("must not spawn with CR/LF args"),
    timeoutMs: 0,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /CR\/LF|safe identifier/);
});

test("parseRewriteMcpJsonResult accepts JSON summary and tolerates npx noise", () => {
  assert.deepEqual(parseRewriteMcpJsonResult('{"scanned":2,"rewritten":1}'), {
    scanned: 2,
    rewritten: 1,
  });
  assert.equal(parseRewriteMcpJsonResult(""), null);
  assert.equal(parseRewriteMcpJsonResult("not-json"), null);
  assert.deepEqual(
    parseRewriteMcpJsonResult(
      'npm notice\nDownloading...\n{"scanned":1,"rewritten":0}\n',
    ),
    { scanned: 1, rewritten: 0 },
  );
  assert.deepEqual(
    parseRewriteMcpJsonResult(
      'noise before {"scanned":3,"rewritten":2} trailing',
    ),
    { scanned: 3, rewritten: 2 },
  );
});

test("redactUrlCredentials strips userinfo from URLs", () => {
  assert.equal(
    redactUrlCredentials("https://user:token@mycompany.jfrog.io/npm/"),
    "https://***@mycompany.jfrog.io/npm/",
  );
  assert.equal(
    redactUrlCredentials("npm ERR! registry https://u:p@host/npm/ failed"),
    "npm ERR! registry https://***@host/npm/ failed",
  );
  assert.equal(
    redactUrlCredentials("no credentials here"),
    "no credentials here",
  );
});

test("killRewriteChildTree uses process-group SIGTERM on POSIX", async () => {
  /** @type {{ pid?: number, signal?: string }[]} */
  const kills = [];
  await killRewriteChildTree(
    { pid: 4242, kill: () => assert.fail("should use process group") },
    {
      platform: "linux",
      isAlive: () => false,
      killFn: (pid, signal) => {
        kills.push({ pid, signal });
        return true;
      },
    },
  );
  assert.deepEqual(kills, [{ pid: -4242, signal: "SIGTERM" }]);
});

test("killRewriteChildTree escalates SIGTERM to SIGKILL and waits after SIGKILL", async () => {
  /** @type {{ pid?: number, signal?: string }[]} */
  const kills = [];
  let aliveChecks = 0;
  const started = Date.now();
  await killRewriteChildTree(
    { pid: 4242, kill: () => assert.fail("should use process group") },
    {
      platform: "linux",
      graceMs: 25,
      // Never-resolving wait forces both post-TERM and post-KILL grace timeouts.
      waitForExit: new Promise(() => {}),
      isAlive: () => {
        aliveChecks += 1;
        return true;
      },
      killFn: (pid, signal) => {
        kills.push({ pid, signal });
        return true;
      },
    },
  );
  assert.deepEqual(kills, [
    { pid: -4242, signal: "SIGTERM" },
    { pid: -4242, signal: "SIGKILL" },
  ]);
  // Pre-wait, post-TERM, and post-KILL isAlive checks (post-KILL wait is new).
  assert.ok(
    aliveChecks >= 3,
    `expected >=3 isAlive checks including post-SIGKILL, got ${aliveChecks}`,
  );
  assert.ok(
    Date.now() - started >= 45,
    "expected two graceMs waits (TERM + KILL)",
  );
});

test("killRewriteChildTree spawns taskkill with /T /F on Windows", async () => {
  /** @type {{ command?: string, args?: string[] }} */
  const spawned = {};
  const killer = new EventEmitter();
  await killRewriteChildTree(
    { pid: 4242, kill: () => true },
    {
      platform: "win32",
      isAlive: () => false,
      spawnFn: (command, args) => {
        spawned.command = command;
        spawned.args = args;
        return killer;
      },
    },
  );
  assert.equal(spawned.command, "taskkill");
  assert.deepEqual(spawned.args, ["/pid", "4242", "/T", "/F"]);
  assert.doesNotThrow(() => {
    killer.emit("error", new Error("taskkill ENOENT"));
  });
});

test("runAgentGuardRewriteMcpJson sets utf8 encoding on child streams", async () => {
  /** @type {string[]} */
  const encodings = [];
  const result = await runAgentGuardRewriteMcpJson({
    paths: ["/tmp/mcp.json"],
    env: { JF_PROJECT: "p", JF_SERVER: "srv" },
    spawnFn: () => {
      const child = new EventEmitter();
      const track = (stream) => {
        stream.setEncoding = (enc) => {
          encodings.push(enc);
          return stream;
        };
        return stream;
      };
      child.stdout = track(new EventEmitter());
      child.stderr = track(new EventEmitter());
      child.stdin = { end: () => {}, on: () => child.stdin };
      child.kill = () => true;
      child.pid = 99;
      queueMicrotask(() => {
        child.stdout.emit("data", '{"scanned":1,"rewritten":0}');
        child.emit("close", 0);
      });
      return child;
    },
    timeoutMs: 0,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(encodings, ["utf8", "utf8"]);
});

test("runAgentGuardRewriteMcpJson returns stdout summary", async () => {
  const result = await runAgentGuardRewriteMcpJson({
    paths: ["/tmp/mcp.json"],
    env: { JF_PROJECT: "p", JF_SERVER: "srv" },
    spawnFn: mockSpawn({
      code: 0,
      stdout: JSON.stringify({ scanned: 1, rewritten: 1 }),
    }),
    timeoutMs: 0,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(parseRewriteMcpJsonResult(result.stdout), {
    scanned: 1,
    rewritten: 1,
  });
});

test("runAgentGuardRewriteMcpJson times out when child never closes", async () => {
  /** @type {{ pid?: number, signal?: string }[]} */
  const kills = [];
  const keepAlive = setInterval(() => {}, 50);
  let result;
  try {
    result = await runAgentGuardRewriteMcpJson({
      paths: ["/tmp/mcp.json"],
      env: { JF_PROJECT: "p", JF_SERVER: "srv" },
      platform: "linux",
      timeoutMs: 40,
      graceMs: 10,
      killFn: (pid, signal) => {
        kills.push({ pid, signal });
        return true;
      },
      spawnFn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = { end: () => {}, on: () => child.stdin };
        child.pid = 4242;
        child.kill = () => assert.fail("should use process-group killFn");
        return child;
      },
    });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rewrite timed out after 40ms/);
  assert.deepEqual(kills, [
    { pid: -4242, signal: "SIGTERM" },
    { pid: -4242, signal: "SIGKILL" },
  ]);
});

test("DEFAULT_REWRITE_TIMEOUT_MS leaves room for kill grace", () => {
  assert.ok(DEFAULT_REWRITE_TIMEOUT_MS > DEFAULT_KILL_GRACE_MS);
});

test("computeRewriteFingerprint is stable for same inputs", () => {
  const fp1 = computeRewriteFingerprint({
    paths: ["/missing-a.json", "/missing-b.json"],
    project: "proj1",
    serverId: "srv",
    agSpec: "@jfrog/agent-guard@1.6.0",
    statSyncFn: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  const fp2 = computeRewriteFingerprint({
    paths: ["/missing-b.json", "/missing-a.json"],
    project: "proj1",
    serverId: "srv",
    agSpec: "@jfrog/agent-guard@1.6.0",
    statSyncFn: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.equal(fp1, fp2);
  assert.match(fp1, /^[a-f0-9]{64}$/);
  const fpOther = computeRewriteFingerprint({
    paths: ["/missing-a.json", "/missing-b.json"],
    project: "proj2",
    serverId: "srv",
    agSpec: "@jfrog/agent-guard@1.6.0",
    statSyncFn: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  assert.notEqual(fp1, fpOther);
});

test("runRewriteMcpJsonPipeline no-ops when disabled", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { [DISABLE_ENV]: "1" },
    discover: () => assert.fail("must not discover"),
    spawnFn: () => assert.fail("must not spawn"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () => assert.fail("must not check"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.DISABLED);
});

test("runRewriteMcpJsonPipeline soft no-ops when agent-guard check is disabled", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/mcp.json"],
    spawnFn: () => assert.fail("must not spawn"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () => ({
      code: 1,
      reason: "Disabled: test",
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.SKIPPED_GATE);
});

test("runRewriteMcpJsonPipeline soft no-ops when registry disabled (exit 2)", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/mcp.json"],
    spawnFn: () => assert.fail("must not spawn"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () => ({
      code: 2,
      reason: "RegistryDisabled: test",
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.SKIPPED_GATE);
});

test("runRewriteMcpJsonPipeline soft no-ops when checkFn throws", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-gate-throw-"));
  const markerPath = path.join(dir, "rewrite.marker");
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/mcp.json"],
    markerPath,
    spawnFn: () => assert.fail("must not spawn after gate throw"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () => {
      throw new Error("gate boom");
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.FAILED_GATE);
  assert.match(result.reason, /gate boom/);
});

test("runRewriteMcpJsonPipeline soft no-ops when checkFn rejects", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-gate-reject-"));
  const markerPath = path.join(dir, "rewrite.marker");
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/mcp.json"],
    markerPath,
    spawnFn: () => assert.fail("must not spawn after gate reject"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      Promise.reject(new Error("gate reject boom")),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.FAILED_GATE);
});

test("runRewriteMcpJsonPipeline STRICT maps failed_gate to exitCode 1", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-gate-strict-"));
  const markerPath = path.join(dir, "rewrite.marker");
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV, [STRICT_ENV]: "1" },
    discover: () => ["/tmp/mcp.json"],
    markerPath,
    spawnFn: () => assert.fail("must not spawn after gate throw"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () => {
      throw new Error("gate boom");
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.outcome, OUTCOME.FAILED_GATE);
});

test("runRewriteMcpJsonPipeline soft no-ops when allowRoots function throws", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-allow-throw-"));
  const markerPath = path.join(dir, "rewrite.marker");
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/mcp.json"],
    markerPath,
    allowRoots: () => {
      throw new Error("allowRoots boom");
    },
    spawnFn: () => assert.fail("must not spawn after allowRoots throw"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.FAILED_ALLOW_ROOTS);
  assert.match(result.reason, /allowRoots boom/);
});

test("runRewriteMcpJsonPipeline soft-skips when server missing", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { JF_PROJECT: "p" },
    discover: () => ["/tmp/mcp.json"],
    spawnFn: () => assert.fail("must not spawn without server"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate without server"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.SKIPPED_NO_SERVER);
});

test("runRewriteMcpJsonPipeline soft-skips when JF_PROJECT missing", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { JF_SERVER: "srv" },
    discover: () => ["/tmp/mcp.json"],
    spawnFn: () => assert.fail("must not spawn without project"),
    spawnSyncFn: noJfConfig(),
    setupPath: path.join(tmpdir(), "rewrite-no-setup-missing.json"),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate without project"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.SKIPPED_NO_PROJECT);
});

test("runRewriteMcpJsonPipeline soft-skips unsafe project/server identifiers", async () => {
  const unsafeProject = await runRewriteMcpJsonPipeline({
    env: { JF_PROJECT: 'a"&calc&"b', JF_SERVER: "srv" },
    discover: () => ["/tmp/does-not-exist-mcp.json"],
    spawnFn: () => assert.fail("must not spawn unsafe project"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate unsafe project"),
  });
  assert.equal(unsafeProject.exitCode, 0);
  assert.equal(unsafeProject.outcome, OUTCOME.SKIPPED_UNSAFE_PROJECT);

  const unsafeServer = await runRewriteMcpJsonPipeline({
    env: { JF_PROJECT: "proj1", JF_SERVER: "%PATH%" },
    discover: () => ["/tmp/does-not-exist-mcp.json"],
    spawnFn: () => assert.fail("must not spawn unsafe server"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate unsafe server"),
  });
  assert.equal(unsafeServer.exitCode, 0);
  assert.equal(unsafeServer.outcome, OUTCOME.SKIPPED_UNSAFE_SERVER);
});

test("runRewriteMcpJsonPipeline soft-fails when agent-guard exits non-zero", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/mcp.json"],
    allowRoots: ["/tmp"],
    spawnFn: mockSpawn({ code: 1, stderr: "boom" }),
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.FAILED_SPAWN);
});

test("runRewriteMcpJsonPipeline STRICT maps failed_spawn to exitCode 1", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV, [STRICT_ENV]: "1" },
    discover: () => ["/tmp/mcp.json"],
    allowRoots: ["/tmp"],
    spawnFn: mockSpawn({ code: 1, stderr: "boom" }),
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.outcome, OUTCOME.FAILED_SPAWN);
});

test("runRewriteMcpJsonPipeline uses serverIdHint for gate and always --server", async () => {
  /** @type {string | undefined} */
  let gatedServerId;
  /** @type {string[] | undefined} */
  let spawnedArgs;
  const result = await runRewriteMcpJsonPipeline({
    env: { JF_PROJECT: "proj1" },
    serverIdHint: "hint-server",
    discover: () => ["/tmp/a/mcp.json"],
    markerPath: freshMarkerPath(),
    allowRoots: ["/tmp/a"],
    spawnFn: (command, args) => {
      spawnedArgs = args;
      return mockSpawn({
        code: 0,
        stdout: JSON.stringify({ scanned: 1, rewritten: 1 }),
      })();
    },
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async (opts) => {
      gatedServerId = opts.serverId;
      return { code: 0, reason: "Enabled: test" };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.REWRITTEN);
  assert.equal(gatedServerId, "hint-server");
  assert.ok(spawnedArgs?.includes("--server"));
  assert.ok(spawnedArgs?.includes("hint-server"));
});

test("runRewriteMcpJsonPipeline always passes --server even with URL+token", async () => {
  /** @type {string[] | undefined} */
  let spawnedArgs;
  const result = await runRewriteMcpJsonPipeline({
    env: {
      ...PROJ_SRV,
      JFROG_URL: "https://mycompany.jfrog.io",
      JFROG_ACCESS_TOKEN: "tok",
    },
    discover: () => ["/tmp/a/mcp.json"],
    markerPath: freshMarkerPath(),
    allowRoots: ["/tmp/a"],
    spawnFn: (command, args) => {
      spawnedArgs = args;
      return mockSpawn({
        code: 0,
        stdout: JSON.stringify({ scanned: 1, rewritten: 1 }),
      })();
    },
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.REWRITTEN);
  assert.ok(spawnedArgs?.includes("--server"));
  assert.ok(spawnedArgs?.includes("my-server"));
});

test("runRewriteMcpJsonPipeline spawns rewrite with paths and allow-root", async () => {
  /** @type {string[] | undefined} */
  let spawnedArgs;
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/a/mcp.json"],
    markerPath: freshMarkerPath(),
    allowRoots: ["/tmp/a"],
    spawnFn: (command, args) => {
      spawnedArgs = args;
      return mockSpawn({
        code: 0,
        stdout: JSON.stringify({ scanned: 1, rewritten: 1 }),
      })();
    },
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.REWRITTEN);
  assert.ok(spawnedArgs?.includes("--rewrite-mcp-json"));
  assert.ok(spawnedArgs?.includes("/tmp/a/mcp.json"));
  assert.ok(spawnedArgs?.includes("--project"));
  assert.ok(spawnedArgs?.includes("proj1"));
  assert.ok(spawnedArgs?.includes("--server"));
  assert.ok(spawnedArgs?.includes("my-server"));
  assert.ok(spawnedArgs?.includes("--allow-root"));
  assert.ok(spawnedArgs?.includes("/tmp/a"));
});

test("runRewriteMcpJsonPipeline skips gate when discover returns empty", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => [],
    spawnFn: () => assert.fail("must not spawn"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate with no mcp.json"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.SKIPPED_NO_PATHS);
});

test("runRewriteMcpJsonPipeline soft no-ops when discover throws", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => {
      throw new Error("discover boom");
    },
    spawnFn: () => assert.fail("must not spawn after discover failure"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate after discover failure"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.FAILED_DISCOVER);
});

test("runRewriteMcpJsonPipeline STRICT maps failed_discover to exitCode 1", async () => {
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV, [STRICT_ENV]: "1" },
    discover: () => {
      throw new Error("discover boom");
    },
    spawnFn: () => assert.fail("must not spawn after discover failure"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate after discover failure"),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.outcome, OUTCOME.FAILED_DISCOVER);
});

test("runRewriteMcpJsonPipeline resolves allowRoots from a function of paths", async () => {
  /** @type {string[] | undefined} */
  let spawnedArgs;
  /** @type {string[] | undefined} */
  let allowRootsArg;
  const result = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => ["/tmp/a/mcp.json", "/tmp/b/mcp.json"],
    markerPath: freshMarkerPath(),
    allowRoots: (paths) => {
      allowRootsArg = paths;
      return paths.map((p) => path.dirname(p));
    },
    spawnFn: (command, args) => {
      spawnedArgs = args;
      return mockSpawn({
        code: 0,
        stdout: JSON.stringify({ scanned: 2, rewritten: 0 }),
      })();
    },
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.REWRITTEN);
  assert.deepEqual(allowRootsArg, ["/tmp/a/mcp.json", "/tmp/b/mcp.json"]);
  assert.ok(spawnedArgs?.includes("--allow-root"));
  assert.ok(spawnedArgs?.includes("/tmp/a"));
  assert.ok(spawnedArgs?.includes("/tmp/b"));
});

test("runRewriteMcpJsonPipeline uses project from setup.json when env unset", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-pipe-setup-"));
  const setupPath = path.join(dir, "setup.json");
  writeFileSync(
    setupPath,
    JSON.stringify({
      version: 1,
      servers: {
        "my-server": {
          jpdUrl: "",
          currentActiveProject: "setup-proj",
        },
      },
    }),
    "utf8",
  );

  /** @type {string[] | undefined} */
  let spawnedArgs;
  const result = await runRewriteMcpJsonPipeline({
    env: { JF_SERVER: "my-server" },
    discover: () => ["/tmp/a/mcp.json"],
    markerPath: freshMarkerPath(),
    allowRoots: ["/tmp/a"],
    setupPath,
    spawnFn: (command, args) => {
      spawnedArgs = args;
      return mockSpawn({
        code: 0,
        stdout: JSON.stringify({ scanned: 1, rewritten: 0 }),
      })();
    },
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.REWRITTEN);
  assert.ok(spawnedArgs?.includes("--project"));
  assert.ok(spawnedArgs?.includes("setup-proj"));
});

test("runRewriteMcpJsonPipeline skips when fingerprint marker is current", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-fp-"));
  const mcpPath = path.join(dir, "mcp.json");
  const markerPath = path.join(dir, "rewrite.marker");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }), "utf8");

  const fp = computeRewriteFingerprint({
    paths: [mcpPath],
    project: "proj1",
    serverId: "my-server",
    agSpec: resolveAgentGuardSpec({}),
  });
  writeFileSync(markerPath, `${fp}\n`, "utf8");

  const skipped = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV },
    discover: () => [mcpPath],
    markerPath,
    spawnFn: () => assert.fail("must not spawn when fingerprint current"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate when fingerprint current"),
  });
  assert.equal(skipped.exitCode, 0);
  assert.equal(skipped.outcome, OUTCOME.SKIPPED_CURRENT);

  /** @type {boolean} */
  let spawned = false;
  const forced = await runRewriteMcpJsonPipeline({
    env: { ...PROJ_SRV, [FORCE_ENV]: "1" },
    discover: () => [mcpPath],
    markerPath,
    allowRoots: [dir],
    spawnFn: () => {
      spawned = true;
      return mockSpawn({
        code: 0,
        stdout: JSON.stringify({ scanned: 1, rewritten: 0 }),
      })();
    },
    spawnSyncFn: noJfConfig(),
    timeoutMs: 0,
    runAgentGuardCheckFn: async () => ({ code: 0, reason: "Enabled: test" }),
  });
  assert.equal(forced.exitCode, 0);
  assert.equal(forced.outcome, OUTCOME.REWRITTEN);
  assert.equal(spawned, true);
});

test("runRewriteMcpJsonPipeline soft-skips when only setup project is missing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-pipe-bad-"));
  const invalidPath = path.join(dir, "mcp.json");
  writeFileSync(invalidPath, "not json at all", "utf8");

  const result = await runRewriteMcpJsonPipeline({
    env: { JF_SERVER: "srv" },
    discover: () => [invalidPath],
    setupPath: path.join(dir, "no-setup.json"),
    spawnFn: () => assert.fail("must not spawn without project"),
    spawnSyncFn: noJfConfig(),
    runAgentGuardCheckFn: async () =>
      assert.fail("must not gate without project"),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outcome, OUTCOME.SKIPPED_NO_PROJECT);
});

const agentGuardBinForContract = process.env.JFROG_AGENT_GUARD_BIN?.trim();

test(
  "live Agent Guard binary accepts --rewrite-mcp-json path protocol",
  {
    skip:
      !agentGuardBinForContract &&
      "set JFROG_AGENT_GUARD_BIN to run live Agent Guard contract",
  },
  async () => {
    const help = spawnSync(agentGuardBinForContract, ["--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
    assert.equal(
      help.error,
      undefined,
      `Agent Guard --help failed to spawn: ${help.error?.message}`,
    );
    assert.match(
      helpText,
      /--rewrite-mcp-json/,
      "Agent Guard --help must advertise --rewrite-mcp-json",
    );
    assert.doesNotMatch(helpText, /--align-mcp-json/);

    const dir = mkdtempSync(path.join(tmpdir(), "rewrite-live-"));
    const mcpPath = path.join(dir, "mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          basic: { command: "uvx", args: ["basic"] },
        },
      }),
      "utf8",
    );

    const result = await runAgentGuardRewriteMcpJson({
      paths: [mcpPath],
      allowRoots: [dir],
      env: {
        ...process.env,
        [AGENT_GUARD_BIN_ENV]: agentGuardBinForContract,
        JF_PROJECT: process.env.JF_PROJECT?.trim() || "proj1",
        JF_SERVER: process.env.JF_SERVER?.trim() || "default",
      },
      timeoutMs: 30_000,
    });
    assert.equal(result.code, 0, result.stderr);
    const summary = parseRewriteMcpJsonResult(result.stdout);
    assert.ok(summary, `expected JSON summary, got: ${result.stdout}`);
  },
);
