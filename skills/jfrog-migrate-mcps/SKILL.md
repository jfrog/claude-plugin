---
name: jfrog-migrate-mcps
description: Convert the MCPs in this agent harness's MCP config files that the JFrog AI Catalog approves so they run through JFrog Agent Guard, or undo the last migration with the restore argument. Supports Claude Code, Cursor and VS Code.
disable-model-invocation: true
compatibility: >-
  Requires Node.js 18 or newer, and network access to the JFrog platform and
  to the Agent Guard npm registry.
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/scripts/jfrog-ai-governance-config.mjs" get) Bash(node "${CLAUDE_SKILL_DIR}/scripts/jfrog-agent-guard-check.mjs") AskUserQuestion
metadata:
  role: workflow
---

# /jfrog-migrate-mcps — move existing MCPs to Agent Guard

`/jfrog-migrate-mcps` converts the MCPs that the project's AI Catalog approves
so they run through Agent Guard. `/jfrog-migrate-mcps restore` undoes the last
migration (see [Restore](#restore)). Agent Guard (`--migrate-mcps`) makes
every decision. You run the fixed commands below, show their output, ask one
fixed question and act on the exit code.

## Step 0. Supported harness

Before anything else: run nothing unless you are in Claude Code, Cursor or
VS Code and the developer's current message is the `/jfrog-migrate-mcps`
command. Otherwise say that migration runs only from that command in those
harnesses, and stop.

## Rules

`<skill_path>` is this skill's directory: the parent directory of this
SKILL.md.

- NEVER read, edit or write an MCP config file or the plan file yourself.
- NEVER decide which MCPs are approved, and never add, drop or change flags.
  Run each command exactly as written, with every value in double quotes.
- Show each Agent Guard command's stdout to the developer **as is**.
- Act on the exit code of each `npx … @jfrog/agent-guard` command: `0` ok;
  `1` error (show stderr as is and STOP); `3` Agent Guard is off (show its
  message and STOP); any other non-zero exit (e.g. `npx` failed before Agent
  Guard started) → show stderr as is and STOP. The scripts in Steps 1 and 2
  have their own exit codes, listed in those steps.
- On a stop before apply or restore runs, tell the developer that nothing was
  changed. Apply and restore continue past a file that fails, so after them
  show stdout and stderr as is, whatever the exit code: stdout lists what was
  changed and what was not.

## Values

- `<REGISTRY_URL>`: the value of the `JFROG_AGENT_GUARD_REPO` environment
  variable if it is set (read it with
  `node -p "process.env.JFROG_AGENT_GUARD_REPO || ''"`), otherwise
  `https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/`.
- `<CLIENT>`: the agent harness you are running in: `claude-code`, `cursor`
  or `vscode`. Any other harness → STOP: migration supports Claude Code,
  Cursor and VS Code.
- `<WORKSPACE>`: the absolute path of the current working directory.

## Step 1. Server and project

```bash
node "<skill_path>/scripts/jfrog-ai-governance-config.mjs" get
```

`<SERVER_ID>` is the AI Governance server ID that `get` returned (`serverId`),
and `<JFROG_PROJECT_KEY>` is its project key (`project`). Then act on `status`:

- `ok` — continue with `<SERVER_ID>` and `<JFROG_PROJECT_KEY>`.
- `no_project` — the server is set, the project is not (e.g. the user told
  `/jfrog-init` they don't use AI Catalog). Ask: "Which AI Governance project
  on `<host>` should I use? I need its project key." (`<host>` is the host
  of the `jpdUrl` that `get` returned.) The answer is `<JFROG_PROJECT_KEY>`
  from now on. Save it by running
  `node "<skill_path>/scripts/jfrog-ai-governance-config.mjs" set "<SERVER_ID>" "<JFROG_PROJECT_KEY>"`.
  NEVER guess, NEVER assume `default`, NEVER invent JFrog project keys, and
  never take one from `JF_PROJECT` or existing MCP entries. There is no
  platform-wide / project-less mode: never offer a "no project" /
  "platform-wide" / "skip" option. If this save command rejects the key,
  ask once more; if that key is rejected too, show the error and stop.
  Never fall back to a project-less call.
- `ambiguous` — several servers are saved (e.g. set up for more than one JFrog
  platform) and none is marked as the AI Governance server. Run
  `node "<skill_path>/scripts/jfrog-ai-governance-config.mjs" list`, show the
  user each `serverId` with its `jpdUrl`, ask: "Which of these is your AI
  Governance server?", save the answer with
  `node "<skill_path>/scripts/jfrog-ai-governance-config.mjs" set "<SERVER_ID>"`,
  then run `get` again.
- `missing` — AI Governance was never set up on this machine; `corrupt` —
  `setup.json` can't be read. Ask the user to run `/jfrog-init` to set it up,
  and stop.
- If a `jfrog-ai-governance-config.mjs set` command above fails for any
  reason other than a rejected project key, show its error, ask the user to
  run `/jfrog-init` to repair the AI Governance setup, and stop.

## Step 2. Agent Guard must be on

```bash
node "<skill_path>/scripts/jfrog-agent-guard-check.mjs"
```

Run it exactly as shown, with no arguments — never pass a server ID, an MCP
name or a URL. It asks the AI Governance server from Step 1 whether Agent
Guard is on. Request network access for this command. If the first run fails
with a network error, timeout or HTTP 5xx (often the harness sandbox), run the
same command once more with network access and use that exit code. Do not
retry when the reason is missing credentials or missing jf config.

- Exit 0 → continue.
- Exit 2 → STOP. Agent Guard is not turned on for this account, so no MCPs
  were migrated.
- Exit 3 → several AI Governance servers are saved and none is the default:
  handle it like `ambiguous` in Step 1, then run Step 2 again.
- Any other exit → STOP. Show the script's one-line reason.

## Step 3. Plan

```bash
npx --yes --registry "<REGISTRY_URL>" @jfrog/agent-guard --migrate-mcps plan --client "<CLIENT>" --workspace "<WORKSPACE>" --project "<JFROG_PROJECT_KEY>" --server "<SERVER_ID>"
```

Show stdout as is. If it says `Nothing to migrate.`, STOP.

## Step 4. Ask

Ask exactly one question, with exactly these choices (use `AskUserQuestion`
or the harness's choice UI when it has one): **Yes** / **Yes + backup** /
**No**.

**No** → STOP.

## Step 5. Apply

**Yes:**

```bash
npx --yes --registry "<REGISTRY_URL>" @jfrog/agent-guard --migrate-mcps apply --client "<CLIENT>" --workspace "<WORKSPACE>"
```

**Yes + backup:**

```bash
npx --yes --registry "<REGISTRY_URL>" @jfrog/agent-guard --migrate-mcps apply --client "<CLIENT>" --workspace "<WORKSPACE>" --backup
```

Show stdout and stderr as is, and nothing else: stdout is the summary, and it
ends with the restart reminder. Don't repeat the plan or add your own summary.
If apply exits 1 with `this plan is for another project, run the plan again`
(another `/jfrog-migrate-mcps` run replaced the plan), show it as is and STOP: no
file was changed.

## Restore

Runs when the argument is `restore`. Local files only: skip Steps 1 to 5.
Same rules and values as above.

1. List what will be put back:

   ```bash
   npx --yes --registry "<REGISTRY_URL>" @jfrog/agent-guard --migrate-mcps restore --client "<CLIENT>" --workspace "<WORKSPACE>" --dry-run
   ```

   Show stdout as is. If it says `No backups found` or `Nothing to restore`,
   STOP.
2. Ask exactly one question:
   - If the output has this line, the developer chooses the files:

     ```text
     No record of the last apply: choose the files to restore, and pass each one with --file.
     ```

     Each file is one line under `Restore will put back:`. Its path is the
     text before `backup from` on that line, trimmed (a path can contain
     spaces). If one file is listed, ask **Yes** / **No** for that file. If
     more are listed, ask which of them to restore, as a multiple choice of
     exactly those paths. **No**, or none chosen → STOP. Then run step 3 with
     one `--file "<FILE>"` per chosen path.
   - Otherwise ask **Yes** / **No**. **No** → STOP.
3. Restore:

   ```bash
   npx --yes --registry "<REGISTRY_URL>" @jfrog/agent-guard --migrate-mcps restore --client "<CLIENT>" --workspace "<WORKSPACE>"
   ```

   or, when the developer chose files in step 2:

   ```bash
   npx --yes --registry "<REGISTRY_URL>" @jfrog/agent-guard --migrate-mcps restore --client "<CLIENT>" --workspace "<WORKSPACE>" --file "<FILE>" [--file "<FILE>" ...]
   ```

   Show stdout and stderr as is.
