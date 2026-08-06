import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AGENT_GUARD_PACKAGE,
  DEFAULT_AGENT_GUARD_NPM_REGISTRY,
  DISABLE_ENV,
  MODES,
  buildNpxArgs,
  buildSessionStartWatchPayload,
  isAlignDisabled,
  resolveAgentGuardNpmRegistry,
  resolvePluginsDir,
  runAlignHook,
} from "./claude-align-plugin-mcps.mjs";
import { runRegisterWatchPaths } from "./claude-register-align-watch-paths.mjs";

test("MODES maps CLI args to agent-guard hook formats", () => {
  assert.equal(MODES["session-start"], "hook-session-start");
  assert.equal(MODES["file-changed"], "hook-file-changed");
});

test("isAlignDisabled respects kill switch", () => {
  assert.equal(isAlignDisabled({}), false);
  assert.equal(isAlignDisabled({ [DISABLE_ENV]: "0" }), false);
  assert.equal(isAlignDisabled({ [DISABLE_ENV]: "1" }), true);
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
