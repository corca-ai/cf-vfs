import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/**
 * Requires a changelog entry from a pull request that changes the library.
 *
 * `test/check-docs.mjs` asserts that the changelog is well formed, which is a
 * different question from whether it is complete. Nothing local can answer
 * completeness -- it needs the diff against the base branch -- so this runs in
 * CI, for the same reason `bench:check` moved there: a rule that is not
 * enforced on every pull request is a rule that drifts, and this one drifted
 * for twenty-two commits and one breaking change.
 *
 * `src/` is the trigger because it is what a consumer receives. A change to
 * tests, docs, benchmarks, or the demo does not need an entry, and a `src/`
 * change that genuinely has nothing to tell a consumer -- a comment, an
 * internal rename -- is released by the `no-changelog` label rather than by
 * writing an entry nobody wanted.
 *
 * Run locally as `node test/check-changelog.mjs origin/main`.
 */

const base = process.argv[2] ?? process.env.CHANGELOG_BASE_SHA;
assert(base, "usage: node test/check-changelog.mjs <base-ref>");

const labels = (process.env.CHANGELOG_PR_LABELS ?? "")
  .split(",")
  .map((label) => label.trim())
  .filter(Boolean);
if (labels.includes("no-changelog")) {
  process.stdout.write("changelog check skipped by the no-changelog label\n");
  process.exit(0);
}

const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

const library = changed.filter((path) => path.startsWith("src/"));
if (library.length === 0) {
  process.stdout.write("no library change, so no changelog entry required\n");
  process.exit(0);
}

assert(
  changed.includes("CHANGELOG.md"),
  `this pull request changes ${library.length} file(s) under src/ without a CHANGELOG.md entry:\n` +
    `${library.map((path) => `  ${path}`).join("\n")}\n\n` +
    "Add one under ## [Unreleased] saying what changed and why, or apply the\n" +
    "no-changelog label if a consumer has nothing to learn from this change.",
);

process.stdout.write(`changelog entry present for ${library.length} changed library file(s)\n`);
