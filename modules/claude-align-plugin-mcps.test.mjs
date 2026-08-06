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
  buildNpxArgs,
  buildNpxSpawnOptions,
  buildSessionStartWatchPayload,
  isAlignDisabled,
  killAlignChildTree,
  resolveAgentGuardNpmRegistry,
  resolveNpxCommand,
  resolvePluginsDir,
  runAgentGuardAlign,
  runAlignHook,
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
