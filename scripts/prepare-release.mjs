import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Turns the accumulated `Unreleased` section into a version, in one step.
 *
 * The steps this replaces are the ones a person gets wrong: renaming the
 * heading, dating it, opening a fresh `Unreleased`, repointing the comparison
 * link, adding the new one, and bumping `package.json` to the same number the
 * tag will carry. Missing any of them produces a release that is only slightly
 * wrong, which is the kind that ships.
 *
 * It changes files and stops. Review the diff, commit it, and open a pull
 * request; pushing the tag is what publishes, and that stays a decision.
 *
 * Usage: npm run release:prepare -- 0.2.0
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
assert(
  version !== undefined && /^\d+\.\d+\.\d+$/u.test(version),
  "usage: npm run release:prepare -- <major.minor.patch>",
);

const manifestPath = resolve(root, "package.json");
const manifest = readFileSync(manifestPath, "utf8");
const previous = JSON.parse(manifest).version;
assert.notEqual(previous, version, `package.json is already at ${version}`);

const changelogPath = resolve(root, "CHANGELOG.md");
let changelog = readFileSync(changelogPath, "utf8");

const unreleased = changelog.indexOf("## [Unreleased]");
assert(unreleased !== -1, "CHANGELOG.md has no Unreleased section");
const body = changelog.slice(unreleased + "## [Unreleased]".length);
const nextHeading = body.search(/^## /mu);
const pending = (nextHeading === -1 ? body : body.slice(0, nextHeading)).trim();
assert(pending !== "", "the Unreleased section is empty, so there is nothing to release");

// The date the release is cut, which is the only thing here that is not
// derivable from the repository.
const today = execFileSync("date", ["-u", "+%Y-%m-%d"], { encoding: "utf8" }).trim();

changelog = changelog.replace(
  `## [Unreleased]\n\n${pending}`,
  `## [Unreleased]\n\n## [${version}] — ${today}\n\n${pending}`,
);
changelog = changelog.replace(
  `[Unreleased]: https://github.com/corca-ai/cf-vfs/compare/v${previous}...HEAD`,
  `[Unreleased]: https://github.com/corca-ai/cf-vfs/compare/v${version}...HEAD\n` +
    `[${version}]: https://github.com/corca-ai/cf-vfs/compare/v${previous}...v${version}`,
);
assert(changelog.includes(`[${version}]: `), "the Unreleased comparison link was not where expected");

writeFileSync(changelogPath, changelog);
writeFileSync(manifestPath, manifest.replace(`"version": "${previous}"`, `"version": "${version}"`));

process.stdout.write(
  `prepared ${previous} -> ${version}\n` +
    "review the diff, commit it, and open a pull request; the tag is what publishes\n",
);
