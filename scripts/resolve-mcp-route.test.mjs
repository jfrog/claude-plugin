// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EXIT_EXISTS,
  EXIT_GATEWAY,
  EXIT_LEGACY,
  parseArgs,
  resolveMcpRoute,
} from "../skills/jfrog-mcp-management/scripts/jfrog-resolve-mcp-route.mjs";

const JPD = "https://acme.jfrog.io";
const MOCK_BASE = "https://eligibility.ngrok.app";
const TOKEN = "tok-abc";
const MCP_ID = "com.supabase/mcp";
const PROJECT = "shwiz";
// Absent on disk, so the duplicate check reads "not present" unless a test
// injects its own readFileSyncFn.
const CONFIG = "/tmp/does-not-exist-.mcp.json";

/** `jf config export` emits base64-encoded JSON. */
function jfExport({ url = JPD, accessToken = TOKEN } = {}) {
  const payload = JSON.stringify({ url, accessToken, serverId: "jfrogmldev" });
  return () => Buffer.from(payload).toString("base64");
}

function gatedEnv(extra = {}) {
  return {
    REMOTE_GW_ELIGIBILITY_ENABLED: "true",
    JF_MCP_ELIGIBILITY_BASE_URL: MOCK_BASE,
    CLAUDECODE: "1",
    ...extra,
  };
}

function argv({
  mcp = MCP_ID,
  project = PROJECT,
  server = "jfrogmldev",
  config = CONFIG,
  remote = true,
} = {}) {
  const args = ["--mcp", mcp, "--project", project, "--config", config];
  if (server) args.push("--server", server);
  if (remote) args.push("--remote");
  return args;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

/**
 * Counting stubs rather than throwing ones: resolveMcpRoute catches every
 * throw and downgrades it to legacy, so a thrown assertion would be swallowed
 * and the test would pass for the wrong reason.
 */
function countingFetch(response = jsonResponse({ eligible: true })) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchFn, calls };
}

function countingExec(impl = jfExport()) {
  const calls = [];
  const execFileSyncFn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  return { execFileSyncFn, calls };
}

test("exit codes match the branch table in SKILL.md Step 3.5", () => {
  assert.equal(EXIT_LEGACY, 0);
  assert.equal(EXIT_GATEWAY, 3);
  assert.equal(EXIT_EXISTS, 4);
});

test("gate off: no fetch, no credential read, legacy", async () => {
  const { fetchFn, calls: fetches } = countingFetch();
  const { execFileSyncFn, calls: execs } = countingExec();

  const result = await resolveMcpRoute({
    argv: argv(),
    env: { CLAUDECODE: "1", JF_MCP_ELIGIBILITY_BASE_URL: MOCK_BASE },
    fetchFn,
    execFileSyncFn,
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=gate-disabled"]);
  assert.equal(fetches.length, 0);
  assert.equal(execs.length, 0);
});

test("second key missing: flag alone does not open the gate", async () => {
  const { fetchFn, calls: fetches } = countingFetch();
  const { execFileSyncFn, calls: execs } = countingExec();

  const result = await resolveMcpRoute({
    argv: argv(),
    env: { REMOTE_GW_ELIGIBILITY_ENABLED: "true", CLAUDECODE: "1" },
    fetchFn,
    execFileSyncFn,
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=no-eligibility-base"]);
  assert.equal(fetches.length, 0);
  assert.equal(execs.length, 0);
});

test("eligible: exit 10, exact entry, eligibility URL and bearer header", async () => {
  const { fetchFn, calls } = countingFetch(jsonResponse({ eligible: true }));

  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: jfExport(),
  });

  assert.equal(result.code, EXIT_GATEWAY);
  assert.deepEqual(result.lines, [
    "route=gateway",
    `entry={"type":"http","url":"${JPD}/mcp/${PROJECT}/${MCP_ID}"}`,
  ]);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `${MOCK_BASE}/ai-catalog/mcp-gateway/${PROJECT}/${MCP_ID}/eligibility`,
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
});

test("the entry always names the JPD, never the eligibility base", async () => {
  const { fetchFn } = countingFetch(jsonResponse({ eligible: true }));

  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn,
    // A trailing /artifactory is the common JFROG_URL shape and is not a valid
    // base for /mcp.
    execFileSyncFn: jfExport({ url: `${JPD}/artifactory/` }),
  });

  assert.equal(result.code, EXIT_GATEWAY);
  assert.equal(
    result.lines[1],
    `entry={"type":"http","url":"${JPD}/mcp/${PROJECT}/${MCP_ID}"}`,
  );
  assert.ok(!result.lines.join("\n").includes(MOCK_BASE));
});

test("an mcp-id with / and @ reaches both URLs raw and unescaped", async () => {
  const id = "@postman/postman-mcp-server";
  const { fetchFn, calls } = countingFetch(jsonResponse({ eligible: true }));

  const result = await resolveMcpRoute({
    argv: argv({ mcp: id }),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: jfExport(),
  });

  assert.equal(
    calls[0].url,
    `${MOCK_BASE}/ai-catalog/mcp-gateway/${PROJECT}/${id}/eligibility`,
  );
  assert.equal(
    result.lines[1],
    `entry={"type":"http","url":"${JPD}/mcp/${PROJECT}/${id}"}`,
  );
  assert.ok(!calls[0].url.includes("%40"));
  assert.ok(!calls[0].url.includes("%2F"));
});

test("not eligible: legacy, and the reason never reaches stdout", async () => {
  for (const reason of ["UNSUPPORTED", "NOT_ALLOWED_IN_PROJECT"]) {
    const { fetchFn } = countingFetch(
      jsonResponse({ eligible: false, reason }),
    );

    const result = await resolveMcpRoute({
      argv: argv(),
      env: gatedEnv(),
      fetchFn,
      execFileSyncFn: jfExport(),
    });

    assert.equal(result.code, EXIT_LEGACY);
    assert.deepEqual(result.lines, ["route=legacy", "detail=not-eligible"]);
    assert.ok(!result.lines.join("\n").includes(reason));
  }
});

test("404 for an MCP the registry does not hold: legacy", async () => {
  const { fetchFn } = countingFetch(
    jsonResponse({ message: "not found" }, { ok: false, status: 404 }),
  );

  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: jfExport(),
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=http-404"]);
});

test("network error: legacy", async () => {
  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn: async () => {
      throw new TypeError("fetch failed");
    },
    execFileSyncFn: jfExport(),
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=request-failed"]);
});

test("timeout: legacy", async () => {
  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn: async () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    },
    execFileSyncFn: jfExport(),
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=timeout"]);
});

test("a body carrying no eligible field: legacy", async () => {
  const { fetchFn } = countingFetch(jsonResponse({ gatewayEligible: true }));

  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: jfExport(),
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=missing-field"]);
});

test("eligible but already configured: exit 20, nothing to write", async () => {
  const { fetchFn } = countingFetch(jsonResponse({ eligible: true }));

  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: jfExport(),
    readFileSyncFn: () =>
      JSON.stringify({ mcpServers: { [MCP_ID]: { type: "http" } } }),
  });

  assert.equal(result.code, EXIT_EXISTS);
  assert.deepEqual(result.lines, ["route=exists", `mcp=${MCP_ID}`]);
});

test("a config holding other servers is not a duplicate", async () => {
  const { fetchFn } = countingFetch(jsonResponse({ eligible: true }));

  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: jfExport(),
    readFileSyncFn: () =>
      JSON.stringify({ mcpServers: { "llm-sandbox": { type: "stdio" } } }),
  });

  assert.equal(result.code, EXIT_GATEWAY);
});

test("--remote omitted (local MCP): legacy, no fetch", async () => {
  const { fetchFn, calls } = countingFetch();

  const result = await resolveMcpRoute({
    argv: argv({ mcp: "llm-sandbox", remote: false }),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: jfExport(),
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=not-remote"]);
  assert.equal(calls.length, 0);
});

test("non-Claude harness: legacy, no fetch", async () => {
  const { fetchFn, calls } = countingFetch();

  const result = await resolveMcpRoute({
    argv: argv(),
    env: {
      REMOTE_GW_ELIGIBILITY_ENABLED: "true",
      JF_MCP_ELIGIBILITY_BASE_URL: MOCK_BASE,
      CURSOR_AGENT: "1",
    },
    fetchFn,
    execFileSyncFn: jfExport(),
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=not-claude-harness"]);
  assert.equal(calls.length, 0);
});

test("unresolvable credentials: legacy, no fetch", async () => {
  const { fetchFn, calls } = countingFetch();

  const result = await resolveMcpRoute({
    argv: argv(),
    env: gatedEnv(),
    fetchFn,
    execFileSyncFn: () => {
      throw new Error("jf: command not found");
    },
  });

  assert.equal(result.code, EXIT_LEGACY);
  assert.deepEqual(result.lines, ["route=legacy", "detail=no-credentials"]);
  assert.equal(calls.length, 0);
});

test("no --server: env credentials are preferred over the default jf server", async () => {
  const { fetchFn } = countingFetch(jsonResponse({ eligible: true }));
  const { execFileSyncFn, calls: execs } = countingExec();

  const result = await resolveMcpRoute({
    argv: argv({ server: "" }),
    env: gatedEnv({
      JFROG_URL: "https://env.jfrog.io",
      JFROG_ACCESS_TOKEN: "env-tok",
    }),
    fetchFn,
    execFileSyncFn,
  });

  assert.equal(result.code, EXIT_GATEWAY);
  assert.equal(
    result.lines[1],
    `entry={"type":"http","url":"https://env.jfrog.io/mcp/${PROJECT}/${MCP_ID}"}`,
  );
  assert.equal(execs.length, 0);
});

test("missing arguments: legacy, no fetch", async () => {
  const { fetchFn, calls } = countingFetch();

  for (const args of [
    ["--project", PROJECT, "--config", CONFIG, "--remote"],
    ["--mcp", MCP_ID, "--config", CONFIG, "--remote"],
    ["--mcp", MCP_ID, "--project", PROJECT, "--remote"],
    ["--mcp", "--project", PROJECT, "--config", CONFIG, "--remote"],
  ]) {
    const result = await resolveMcpRoute({
      argv: args,
      env: gatedEnv(),
      fetchFn,
      execFileSyncFn: jfExport(),
    });
    assert.equal(result.code, EXIT_LEGACY);
    assert.deepEqual(result.lines, ["route=legacy", "detail=missing-args"]);
  }
  assert.equal(calls.length, 0);
});

test("parseArgs accepts both --flag value and --flag=value", () => {
  assert.deepEqual(
    parseArgs(["--mcp=com.supabase/mcp", "--project", PROJECT, "--remote"]),
    { mcp: "com.supabase/mcp", project: PROJECT, remote: true },
  );
  assert.equal(parseArgs(["--mcp", MCP_ID]).remote, false);
});
