#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Fast SessionStart hook: register FileChanged watchPaths before the slower
// align-plugin-mcps.mjs (npx) finishes, so mid-session plugin installs are watched.

import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const configDir =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
const plugins = path.join(configDir, "plugins");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      watchPaths: [
        path.join(plugins, "installed_plugins.json"),
        path.join(plugins, "known_marketplaces.json"),
      ],
    },
  }),
);
process.exit(0);
