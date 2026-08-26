# Remote MCP Gateway routing

Reference for Install → Step 3.5 of the `jfrog-mcp-management` skill, which
decides whether a remote MCP is written as a JFrog Remote MCP Gateway entry or
as today's Agent Guard stdio entry. You do NOT need this file to run that step —
its branch table is self-contained. Read this only for the contract behind it.

The route is decided once, at add time, and is expressed entirely by the config
entry that gets written. It is never a runtime decision, and there is no runtime
fallback: an IDE binds a server's transport when it starts, so a server stays on
the path its entry names for the life of the session. A Gateway 401 is the normal
start of the OAuth flow, not a signal to re-route.

## What decides the route

`scripts/jfrog-resolve-mcp-route.mjs`. It only ever reports a verdict — it never
edits a config file, and the model does every write, exactly as it does today.

| Exit | stdout | Meaning |
| --- | --- | --- |
| 0 | `route=legacy` + `detail=<code>` | Write the Agent Guard stdio entry (today's flow, unchanged). |
| 3 | `route=gateway` + `entry=<compact JSON>` | Write that JSON verbatim. |
| 4 | `route=exists` + `mcp=<id>` | Already configured; write nothing. |
| other | — | Treat as 0. The catch-all is mandatory, so these numbers are never load-bearing. |

`detail=` is a fixed diagnostic vocabulary (`gate-disabled`,
`no-eligibility-base`, `not-claude-harness`, `not-remote`, `missing-args`,
`no-credentials`, `not-eligible`, `missing-field`, `unparseable-body`,
`http-<status>`, `timeout`, `request-failed`, `unexpected-error`). It is for
debugging only — never surface it to the user, and never branch on it.

Everything fails closed to exit 0: gate off, non-Claude harness, local MCP,
missing arguments, unresolvable credentials, a non-2XX, an unparseable body, a
missing field, a network error, a timeout, or any unexpected throw. The only
input that produces exit 3 is an explicit 2XX carrying `"eligible": true`.

## The two env vars that gate it

Both are required; either one missing means legacy, and the script then reads no
credentials and makes no network call at all.

| Variable | Purpose |
| --- | --- |
| `REMOTE_GW_ELIGIBILITY_ENABLED` | Must be exactly `true`. The feature flag. |
| `JF_MCP_ELIGIBILITY_BASE_URL` | Origin the eligibility question is sent to. |

The second key is deliberately a mock override rather than a real setting. The
eligibility base would otherwise be resolved from `jf config`, which every
customer already has, so "base resolvable" would be no gate at all. When the
endpoint ships for real this becomes optional and the gate reduces to the flag.

These are intentionally absent from the plugin README's env table: they are
dev-only and not part of the public contract.

`JF_MCP_ROUTE_DEBUG=true` adds tracing on stderr. The JFrog access token is
never printed, traced, or included in any output.

## The eligibility endpoint

```
GET <base>/ai-catalog/mcp-gateway/{project}/{mcp-id}/eligibility
Authorization: Bearer <token from `jf config export`>
```

No request body. The response is one of:

```json
{ "eligible": true }
{ "eligible": false, "reason": "UNSUPPORTED" }
{ "eligible": false, "reason": "NOT_ALLOWED_IN_PROJECT" }
```

Both path segments are load-bearing: `{project}` scopes the governance approval
the check reads, so the same MCP can be eligible in one project and not in
another.

**`reason` is accepted and ignored in this phase.** Any `"eligible": false`
produces the legacy entry byte-for-byte, whatever the reason says. Nothing is
parsed from it, surfaced, or logged, which is why no `detail=` code can leak it.
Telling the user why an MCP is on the local path is future work.

A 200 means the check ran and `eligible` is the answer — including for an
upstream the gateway could not reach, which is a verdict, not an error. Any
other status means the check did **not** run (404 for an `{mcp-id}` the registry
does not hold, 403 for a caller who may not add MCPs in this project, 429 for
the per-tenant rate limit, 503 when the registry is unavailable). All of them
route to legacy.

Timeout is 5000 ms with an `AbortController`, matching the Step 0 gate. Worth
knowing: the endpoint may make up to four calls to a third party while the
caller waits, so a slow upstream can exhaust that budget and land on legacy.
That is the intended failure direction, but it does mean the timeout — not the
gateway — sometimes decides the route.

## How each value is resolved

| Value | Source |
| --- | --- |
| `{mcp-id}` | `spec.packageName` from `--inspect` — the same string the legacy entry writes as `mcp=` inside `_JF_ARGS`. |
| `{project}` | `<JFROG_PROJECT_KEY>`, per the pre-flight chain in [agent-guard-common.md](agent-guard-common.md). |
| `<base>` | `JF_MCP_ELIGIBILITY_BASE_URL`, else the resolved server's JPD, normalized to the platform root. |
| Bearer token | `jf config export` for the resolved server (base64 JSON carrying `url` / `accessToken` / `serverId`). |
| `<jpd>` in the entry | Always the resolved server's real JPD — never `JF_MCP_ELIGIBILITY_BASE_URL`, which only says where the question was asked. |

Credential resolution mirrors the Step 0 gate exactly: with `--server`, that jf
server first and the `JFROG_URL`+token env pair second; without `--server`, env
first and the default jf server second. That order matters — on the env path the
skill passes no `--server`, and falling straight through to the CLI's default
server could build a Gateway URL for a different JPD than the one the user is
authenticated against.

`jf config export` is used rather than reading `~/.jfrog/jfrog-cli.conf.v6`
because newer CLIs do not persist the access token in that file.

### `{project}` and `{mcp-id}` are substituted raw

No percent-encoding, in either URL. This matches how Agent Guard already carries
the same two values — see the `_JF_ARGS` rule in
[harness-common.md](harness-common.md). A `spec.packageName` containing `/`
therefore spans more than one path segment (`com.supabase/mcp` becomes
`.../mcp-gateway/<project>/com.supabase/mcp/eligibility`), which is what the
Gateway's own URL grammar expects.

## The entry that gets written

```json
{ "type": "http", "url": "<jpd>/mcp/<project>/<mcp-id>" }
```

Note the serving path (`/mcp/`) is not the eligibility path
(`/ai-catalog/mcp-gateway/`). Both are built from the same raw `{project}` and
`{mcp-id}`, so the question and the answer always name the same MCP.

## Scope limits

- **Claude Code only.** Every other harness resolves to legacy, so this is the
  one place in the skill where a harness-specific top-level key (`mcpServers`)
  is assumed.
- **The duplicate check runs only on the Gateway path, and only after a positive
  verdict.** The legacy path has no duplicate check today and must not gain one:
  checking earlier would make a remote-but-ineligible MCP that is already
  installed report "already exists" where today it just writes the legacy entry.
- **No prefix or domain enforcement.** The skill never pattern-matches the JPD
  hostname; self-hosted JPDs have no fixed `*.jfrog.io` shape. Restricting which
  URLs a Gateway entry may name belongs in the harness's managed-settings
  allowlist (for Claude Code, `allowedMcpServers` in `managed-settings.json`),
  not here.
- **No client-side probing.** Nothing on the developer's machine contacts the
  MCP's upstream to judge eligibility. The Gateway is the only authority, which
  is why trusting the model-supplied `--remote` flag is safe: omitting it can
  only cost a Gateway route, never grant one.
