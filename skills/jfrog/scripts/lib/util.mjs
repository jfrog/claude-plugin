// util.mjs — tiny generic Node helpers shared by this skill's scripts.
// Kept local to the `jfrog` skill rather than imported from
// jfrog-init/scripts/lib/jf.mjs — skills stay self-contained/portable.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `import.meta.url === pathToFileURL(process.argv[1]).href` looks right for
// the standard ESM "was I run directly?" check, but Node's ESM loader
// resolves symlinks when computing import.meta.url while pathToFileURL(argv[1])
// does not — so the comparison silently fails whenever the invoking path
// passes through a symlink (exactly how skills are installed locally).
// Resolving both sides through realpathSync fixes it.
export function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
