import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The Conventional Commits rule this repository already follows by habit.
 *
 * Everything downstream reads it. The changelog groups by type, a release
 * derives the version bump from `feat` against `fix` and from `!`, and both
 * are only as reliable as the subjects they parse -- so the discipline that
 * made this repository's history unusually machine-readable is worth
 * guaranteeing rather than remembering.
 *
 * **Merges here are squashed, so the subject that lands on `main` is the pull
 * request title, not any commit on the branch.** That is why the same rule is
 * applied in two places: the `commit-msg` hook keeps a branch tidy and gives
 * the feedback immediately, and the CI job checks the title, which is the one
 * that becomes history.
 *
 * The length limit is measured against a real ceiling: the longest subject in
 * 113 commits is 77 characters before GitHub appends `(#NNN)` on squash, so a
 * stricter limit would reject subjects this repository was right to write.
 */

/** `feat` and `fix` drive the version bump; the rest are cosmetic to a release. */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "demo",
  "revert",
];

const MAXIMUM_SUBJECT_LENGTH = 80;

// A scope is not whitelisted -- it names a part of the repository and those
// move -- but it is shaped, so `(VFS)` and `(vfs )` fail rather than quietly
// becoming a scope nothing else uses.
const SUBJECT = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\([a-z0-9-]+\\))?(!)?: (.+)$`, "u");

// GitHub appends this when it squashes, so the same subject is measured the
// same way whether it arrives as a pull request title or as merged history.
const SQUASH_SUFFIX = /\s*\(#\d+\)$/u;

/** The reason `subject` is not acceptable, or null if it is. */
export function validateCommitSubject(subject) {
  const trimmed = subject.trim();
  if (trimmed === "") return "the subject is empty";
  // Not authored by a person and not something a rule should reject.
  if (/^(Merge|Revert) /u.test(trimmed)) return null;

  const match = SUBJECT.exec(trimmed);
  if (match === null) {
    return (
      `"${trimmed}" is not a Conventional Commit subject.\n` +
      `Expected <type>[(scope)][!]: <description>, where type is one of:\n  ${COMMIT_TYPES.join(", ")}\n` +
      "Use ! for a breaking change, as in feat(vfs)!: remove ifRevision."
    );
  }

  const description = match[4];
  if (description.endsWith(".")) return "the description must not end with a period";
  if (description !== description.trimStart()) return "the description has leading whitespace";

  const measured = trimmed.replace(SQUASH_SUFFIX, "");
  if (measured.length > MAXIMUM_SUBJECT_LENGTH) {
    return `the subject is ${measured.length} characters, over the ${MAXIMUM_SUBJECT_LENGTH}-character limit`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, value] = process.argv.slice(2);
  assert(
    (flag === "--file" || flag === "--text") && value !== undefined,
    "usage: node test/check-commit-message.mjs --file <path> | --text <subject>",
  );
  const message = flag === "--file" ? readFileSync(value, "utf8") : value;
  // Comments are what `git commit` writes below the message for the author.
  const subject = message.split("\n").find((line) => line.trim() !== "" && !line.startsWith("#"));
  const failure = validateCommitSubject(subject ?? "");
  assert(failure === null, failure ?? "");
  process.stdout.write("commit subject follows Conventional Commits\n");
}
