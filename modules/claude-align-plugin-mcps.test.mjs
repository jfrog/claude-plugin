import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  AGENT_GUARD_PACKAGE,
  DEFAULT_AGENT_GUARD_NPM_REGISTRY,
  DISABLE_ENV,
  MODES,
  buildNpxArgs,
  isAlignDisabled,
  resolveAgentGuardNpmRegistry,
  runAlignHook,
} from "./claude-align-plugin-mcps.mjs";

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

test("runAlignHook soft-fails on npx error (exit 0, no stdout)", async () => {
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
