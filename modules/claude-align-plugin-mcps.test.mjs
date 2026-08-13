import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AGENT_GUARD_PACKAGE,
  DEFAULT_AGENT_GUARD_NPM_REGISTRY,
  DEFAULT_ALIGN_TIMEOUT_MS,
  DISABLE_ENV,
  MODES,
  PLUGIN_SOURCE_TAG,
  SOURCE_TAG_FLAG,
  addPluginSourceTag,
  buildNpxArgs,
  buildNpxSpawnOptions,
  buildSessionStartWatchPayload,
  isAlignDisabled,
  killAlignChildTree,
  listInstalledPluginMcpJsonPaths,
  patchPluginMcpJsonSourceTag,
  resolveAgentGuardNpmRegistry,
  resolveNpxCommand,
  resolvePluginsDir,
  runAgentGuardAlign,
  runAlignHook,
  tagPluginMcpJsonFiles,
} from "./claude-align-plugin-mcps.mjs";
import { runRegisterWatchPaths } from "./claude-register-align-watch-paths.mjs";

test("MODES maps CLI args to agent-guard hook formats", () => {
  assert.equal(MODES["session-start"], "hook-session-start");
  assert.equal(MODES["file-changed"], "hook-file-changed");
});

test("DEFAULT_ALIGN_TIMEOUT_MS sits under the 45s hook budget", () => {
  assert.equal(DEFAULT_ALIGN_TIMEOUT_MS, 40_000);
  assert.ok(DEFAULT_ALIGN_TIMEOUT_MS < 45_000);
});

test("isAlignDisabled respects kill switch", () => {
  assert.equal(isAlignDisabled({}), false);
  assert.equal(isAlignDisabled({ [DISABLE_ENV]: "0" }), false);
  assert.equal(isAlignDisabled({ [DISABLE_ENV]: "1" }), true);
});

test("resolveNpxCommand uses npx.cmd on Windows", () => {
  assert.equal(resolveNpxCommand("darwin"), "npx");
  assert.equal(resolveNpxCommand("linux"), "npx");
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
    shell: true,
    detached: false,
  });
});

test("killAlignChildTree uses process-group SIGTERM on POSIX", () => {
  /** @type {{ pid?: number, signal?: string }[]} */
  const kills = [];
  killAlignChildTree(
    { pid: 4242, kill: () => assert.fail("should use process group") },
    {
      platform: "linux",
      killFn: (pid, signal) => {
        kills.push({ pid, signal });
        return true;
      },
    },
  );
  assert.deepEqual(kills, [{ pid: -4242, signal: "SIGTERM" }]);
});

test("killAlignChildTree falls back to child.kill on Windows", () => {
  let killedWith;
  killAlignChildTree(
    {
      pid: 4242,
      kill: (signal) => {
        killedWith = signal;
        return true;
      },
    },
    {
      platform: "win32",
      killFn: () => assert.fail("should not process-group kill on Windows"),
    },
  );
  assert.equal(killedWith, "SIGTERM");
});

test("killAlignChildTree falls back when process-group kill fails", () => {
  let killedWith;
  killAlignChildTree(
    {
      pid: 4242,
      kill: (signal) => {
        killedWith = signal;
        return true;
      },
    },
    {
      platform: "darwin",
      killFn: () => {
        throw new Error("ESRCH");
      },
    },
  );
  assert.equal(killedWith, "SIGTERM");
});

test("resolveAgentGuardNpmRegistry prefers JFROG_AGENT_GUARD_REPO", () => {
  assert.equal(
    resolveAgentGuardNpmRegistry({}),
    DEFAULT_AGENT_GUARD_NPM_REGISTRY,
  );
  assert.equal(
    resolveAgentGuardNpmRegistry({ JFROG_AGENT_GUARD_REPO: " https://corp.example/npm/ " }),
    "https://corp.example/npm/",
  );
});

test("resolvePluginsDir honors CLAUDE_CONFIG_DIR", () => {
  assert.equal(
    resolvePluginsDir({ CLAUDE_CONFIG_DIR: "/custom/claude" }),
    path.join("/custom/claude", "plugins"),
  );
  assert.equal(
    resolvePluginsDir({}),
    path.join(homedir(), ".claude", "plugins"),
  );
});

test("buildSessionStartWatchPayload lists plugin metadata files", () => {
  const payload = JSON.parse(
    buildSessionStartWatchPayload({ CLAUDE_CONFIG_DIR: "/cfg" }),
  );
  assert.deepEqual(payload.hookSpecificOutput.watchPaths, [
    path.join("/cfg", "plugins", "installed_plugins.json"),
    path.join("/cfg", "plugins", "known_marketplaces.json"),
  ]);
});

test("buildNpxArgs always passes registry + align flags", () => {
  assert.deepEqual(buildNpxArgs("hook-session-start", {}), [
    "--yes",
    "--registry",
    DEFAULT_AGENT_GUARD_NPM_REGISTRY,
    AGENT_GUARD_PACKAGE,
    "--align-plugin-mcps",
    "--format",
    "hook-session-start",
  ]);
});

test("buildNpxArgs forwards project, config dir, and agent-guard registry", () => {
  assert.deepEqual(
    buildNpxArgs("hook-file-changed", {
      JF_PROJECT: "my-proj",
      CLAUDE_CONFIG_DIR: "/cfg",
      JFROG_AGENT_GUARD_REPO: "https://corp.example/npm/",
    }),
    [
      "--yes",
      "--registry",
      "https://corp.example/npm/",
      AGENT_GUARD_PACKAGE,
      "--align-plugin-mcps",
      "--format",
      "hook-file-changed",
      "--project",
      "my-proj",
      "--claude-config-dir",
      "/cfg",
      "--registry",
      "https://corp.example/npm/",
    ],
  );
});

function mockSpawn(stdout, exitCode = 0) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      end() {},
    };
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", stdout);
      child.emit("close", exitCode);
    });
    return child;
  };
}

test("runAlignHook kill switch skips spawn and writes nothing", async () => {
  let spawned = false;
  let written = "";
  const code = await runAlignHook("session-start", {
    env: { [DISABLE_ENV]: "1" },
    spawnFn: () => {
      spawned = true;
      throw new Error("should not spawn");
    },
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(spawned, false);
  assert.equal(written, "");
});

test("runAlignHook passthroughs agent-guard stdout on success", async () => {
  const payload = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      watchPaths: ["/tmp/installed_plugins.json"],
    },
  });
  let written = "";
  const code = await runAlignHook("session-start", {
    env: {},
    spawnFn: mockSpawn(payload, 0),
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => '{"session_id":"abc"}',
  });
  assert.equal(code, 0);
  assert.equal(written, payload);
});

test("runAlignHook forwards Claude hook stdin to agent-guard", async () => {
  const hookStdin = JSON.stringify({
    hook_event_name: "FileChanged",
    file_path: "/cfg/plugins/installed_plugins.json",
  });
  /** @type {string | undefined} */
  let forwarded;
  const code = await runAlignHook("file-changed", {
    env: {},
    spawnFn: (_cmd, _args, _opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        end(chunk) {
          forwarded = chunk ?? "";
        },
      };
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
    writeStdout: () => {},
    readStdinFn: async () => hookStdin,
  });
  assert.equal(code, 0);
  assert.equal(forwarded, hookStdin);
});

test("runAlignHook soft-fails on SessionStart with fallback watchPaths", async () => {
  let written = "";
  const code = await runAlignHook("session-start", {
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    spawnFn: mockSpawn("", 1),
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, buildSessionStartWatchPayload({ CLAUDE_CONFIG_DIR: "/cfg" }));
});

test("runAlignHook soft-fails on FileChanged with no stdout", async () => {
  let written = "";
  const code = await runAlignHook("file-changed", {
    env: {},
    spawnFn: mockSpawn("", 1),
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, "");
});

test("runAlignHook empty SessionStart stdout still emits fallback watchPaths", async () => {
  let written = "";
  const code = await runAlignHook("session-start", {
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    spawnFn: mockSpawn("", 0),
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, buildSessionStartWatchPayload({ CLAUDE_CONFIG_DIR: "/cfg" }));
});

test("runAlignHook unknown mode is a no-op", async () => {
  let spawned = false;
  const code = await runAlignHook("nope", {
    env: {},
    spawnFn: () => {
      spawned = true;
      throw new Error("should not spawn");
    },
    writeStdout: () => {},
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(spawned, false);
});

test("runAlignHook soft-fails when spawn throws", async () => {
  let written = "";
  const code = await runAlignHook("session-start", {
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    spawnFn: () => {
      throw new Error("spawn ENOENT");
    },
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, buildSessionStartWatchPayload({ CLAUDE_CONFIG_DIR: "/cfg" }));
});

test("runAlignHook soft-fails when child emits error", async () => {
  let written = "";
  const code = await runAlignHook("file-changed", {
    env: {},
    spawnFn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {};
      queueMicrotask(() => {
        child.emit("error", new Error("npx not found"));
      });
      return child;
    },
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, "");
});

test("runAgentGuardAlign spawns npx.cmd with shell on Windows", async () => {
  /** @type {{ cmd?: string, opts?: object }} */
  let spawned = {};
  const result = await runAgentGuardAlign("hook-session-start", {
    env: {},
    platform: "win32",
    spawnFn: (cmd, _args, opts) => {
      spawned = { cmd, opts };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(spawned.cmd, "npx.cmd");
  assert.equal(spawned.opts?.shell, true);
  assert.equal(spawned.opts?.detached, false);
});

test("runAgentGuardAlign spawns detached npx on POSIX", async () => {
  /** @type {{ cmd?: string, opts?: object }} */
  let spawned = {};
  const result = await runAgentGuardAlign("hook-session-start", {
    env: {},
    platform: "darwin",
    spawnFn: (cmd, _args, opts) => {
      spawned = { cmd, opts };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {};
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(spawned.cmd, "npx");
  assert.equal(spawned.opts?.shell, false);
  assert.equal(spawned.opts?.detached, true);
});

test("runAgentGuardAlign kills hung child process group on timeout", async () => {
  /** @type {{ pid?: number, signal?: string }[]} */
  const kills = [];
  let childKillCalled = false;
  const result = await runAgentGuardAlign("hook-session-start", {
    env: {},
    timeoutMs: 20,
    platform: "linux",
    killFn: (pid, signal) => {
      kills.push({ pid, signal });
      return true;
    },
    spawnFn: () => {
      const child = new EventEmitter();
      child.pid = 5555;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {
        childKillCalled = true;
      };
      // Never closes on its own — timeout must kill.
      return child;
    },
  });
  assert.deepEqual(kills, [{ pid: -5555, signal: "SIGTERM" }]);
  assert.equal(childKillCalled, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /align timed out after 20ms/);
});

test("runAgentGuardAlign kills hung child via child.kill on Windows timeout", async () => {
  let killedWith;
  const result = await runAgentGuardAlign("hook-session-start", {
    env: {},
    timeoutMs: 20,
    platform: "win32",
    killFn: () => assert.fail("should not process-group kill on Windows"),
    spawnFn: () => {
      const child = new EventEmitter();
      child.pid = 5555;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = (signal) => {
        killedWith = signal;
        queueMicrotask(() => child.emit("close", null));
      };
      return child;
    },
  });
  assert.equal(killedWith, "SIGTERM");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /align timed out after 20ms/);
});

test("runAlignHook timeout on SessionStart still emits fallback watchPaths", async () => {
  let written = "";
  const code = await runAlignHook("session-start", {
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    timeoutMs: 20,
    platform: "win32",
    spawnFn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.kill = () => {
        queueMicrotask(() => child.emit("close", null));
      };
      return child;
    },
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, buildSessionStartWatchPayload({ CLAUDE_CONFIG_DIR: "/cfg" }));
});

test("runRegisterWatchPaths emits watchPaths", async () => {
  let written = "";
  const code = await runRegisterWatchPaths({
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, buildSessionStartWatchPayload({ CLAUDE_CONFIG_DIR: "/cfg" }));
});

test("runRegisterWatchPaths respects kill switch", async () => {
  let written = "";
  const code = await runRegisterWatchPaths({
    env: { [DISABLE_ENV]: "1" },
    writeStdout: (s) => {
      written += s;
    },
    readStdinFn: async () => "",
  });
  assert.equal(code, 0);
  assert.equal(written, "");
});

// --- Plugin --source tagging (POC) ---------------------------------------

function agentGuardEntry(extraArgs = []) {
  return {
    type: "stdio",
    command: "npx",
    args: [
      "--yes",
      "--registry",
      DEFAULT_AGENT_GUARD_NPM_REGISTRY,
      AGENT_GUARD_PACKAGE,
      "--server",
      "jfrogmldev",
      ...extraArgs,
    ],
    env: { _JF_ARGS: "project=demo&mcp=internal-search" },
  };
}

/** In-memory readFileFn/writeFileFn pair for patch/discovery tests. */
function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const written = new Map();
  return {
    files,
    written,
    readFileFn: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p);
    },
    writeFileFn: async (p, contents) => {
      files.set(p, contents);
      written.set(p, contents);
    },
  };
}

test("addPluginSourceTag tags an untagged Agent Guard stdio entry", () => {
  const server = agentGuardEntry();
  assert.equal(addPluginSourceTag(server), true);
  assert.deepEqual(server.args.slice(-2), [SOURCE_TAG_FLAG, PLUGIN_SOURCE_TAG]);
});

test("addPluginSourceTag is idempotent on an already-tagged entry", () => {
  const server = agentGuardEntry([SOURCE_TAG_FLAG, PLUGIN_SOURCE_TAG]);
  const before = [...server.args];
  assert.equal(addPluginSourceTag(server), false);
  assert.deepEqual(server.args, before);
});

test("addPluginSourceTag ignores non-Agent-Guard and remote entries", () => {
  assert.equal(addPluginSourceTag({ command: "node", args: ["server.js"] }), false);
  assert.equal(addPluginSourceTag({ type: "http", url: "https://example.com/mcp" }), false);
  assert.equal(addPluginSourceTag(null), false);
});

test("patchPluginMcpJsonSourceTag tags untagged entries and writes the file back", async () => {
  const fs = fakeFs({
    "/plugin/.mcp.json": JSON.stringify({
      mcpServers: { "internal-search": agentGuardEntry() },
    }),
  });
  const changed = await patchPluginMcpJsonSourceTag("/plugin/.mcp.json", fs);
  assert.equal(changed, true);
  const rewritten = JSON.parse(fs.written.get("/plugin/.mcp.json"));
  assert.deepEqual(
    rewritten.mcpServers["internal-search"].args.slice(-2),
    [SOURCE_TAG_FLAG, PLUGIN_SOURCE_TAG],
  );
});

test("patchPluginMcpJsonSourceTag does not rewrite an already-tagged file", async () => {
  const fs = fakeFs({
    "/plugin/.mcp.json": JSON.stringify({
      mcpServers: {
        "internal-search": agentGuardEntry([SOURCE_TAG_FLAG, PLUGIN_SOURCE_TAG]),
      },
    }),
  });
  const changed = await patchPluginMcpJsonSourceTag("/plugin/.mcp.json", fs);
  assert.equal(changed, false);
  assert.equal(fs.written.size, 0);
});

test("patchPluginMcpJsonSourceTag leaves a remote-only mcp.json untouched", async () => {
  const fs = fakeFs({
    "/plugin/.mcp.json": JSON.stringify({
      mcpServers: { jfrog: { type: "http", url: "https://example.jfrog.io/mcp" } },
    }),
  });
  assert.equal(await patchPluginMcpJsonSourceTag("/plugin/.mcp.json", fs), false);
  assert.equal(fs.written.size, 0);
});

test("patchPluginMcpJsonSourceTag returns false for a missing file", async () => {
  const fs = fakeFs({});
  assert.equal(await patchPluginMcpJsonSourceTag("/missing/.mcp.json", fs), false);
});

test("patchPluginMcpJsonSourceTag returns false for unparsable JSON", async () => {
  const fs = fakeFs({ "/plugin/.mcp.json": "{ not json" });
  assert.equal(await patchPluginMcpJsonSourceTag("/plugin/.mcp.json", fs), false);
});

test("listInstalledPluginMcpJsonPaths reads installPath entries from installed_plugins.json", async () => {
  const installedPath = path.join("/cfg", "plugins", "installed_plugins.json");
  const fs = fakeFs({
    [installedPath]: JSON.stringify({
      version: 2,
      plugins: {
        "jfrog@jfrog-plugin": [{ scope: "user", installPath: "/cache/jfrog-plugin/jfrog/0.2.19" }],
      },
    }),
  });
  const paths = await listInstalledPluginMcpJsonPaths({ CLAUDE_CONFIG_DIR: "/cfg" }, fs);
  assert.deepEqual(paths, [path.join("/cache/jfrog-plugin/jfrog/0.2.19", ".mcp.json")]);
});

test("listInstalledPluginMcpJsonPaths returns [] when installed_plugins.json is missing", async () => {
  const fs = fakeFs({});
  assert.deepEqual(
    await listInstalledPluginMcpJsonPaths({ CLAUDE_CONFIG_DIR: "/cfg" }, fs),
    [],
  );
});

test("tagPluginMcpJsonFiles tags every discovered plugin mcp.json and reports errors per file", async () => {
  const installedPath = path.join("/cfg", "plugins", "installed_plugins.json");
  const goodMcpPath = path.join("/cache/good/0.0.1", ".mcp.json");
  const badMcpPath = path.join("/cache/bad/0.0.1", ".mcp.json");
  const fs = fakeFs({
    [installedPath]: JSON.stringify({
      plugins: {
        "good@mp": [{ installPath: "/cache/good/0.0.1" }],
        "bad@mp": [{ installPath: "/cache/bad/0.0.1" }],
      },
    }),
    [goodMcpPath]: JSON.stringify({ mcpServers: { tool: agentGuardEntry() } }),
    [badMcpPath]: "{ not json",
  });
  const { patched, errors } = await tagPluginMcpJsonFiles({ CLAUDE_CONFIG_DIR: "/cfg" }, fs);
  assert.deepEqual(patched, [goodMcpPath]);
  assert.deepEqual(errors, []); // unparsable files are skipped, not errored
});
