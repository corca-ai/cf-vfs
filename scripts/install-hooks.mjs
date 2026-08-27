import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Points git at the tracked hooks directory, if this is a working tree.
 *
 * Run from `prepare`, so a contributor gets the hook from `npm ci` rather than
 * from remembering to read a document. `prepare` also runs when someone
 * installs this package from a git reference, which is why every failure here
 * is swallowed: a hook is a convenience for this repository and must never be
 * the reason another project's install fails.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  if (!existsSync(resolve(root, ".githooks/commit-msg"))) process.exit(0);
  execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
} catch {
  // No git, no working tree, or a read-only checkout. Nothing to install.
}
