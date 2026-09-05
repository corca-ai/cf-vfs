import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The notes for a release, and the assertions that the release is coherent.
 *
 * Run from the release workflow, before anything is published. A tag that
 * disagrees with `package.json`, or a version with no changelog section, is a
 * release that would ship the wrong thing or describe nothing -- both are
 * mistakes a person makes exactly once and then automates away.
 *
 * The install block is the reason `v0.1.0` exists: a consumer that pins
 * `ignore-scripts=true` never runs `prepare`, so it cannot build `dist/` from
 * a git reference and needs the packed tarball. `--integrity` is what `npm
 * pack --json` reported for that tarball, published so the artifact can be
 * checked against what npm would resolve.
 */

const REPOSITORY = "https://github.com/corca-ai/cf-vfs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const tag = argument("tag");
assert(tag, "usage: node scripts/release-notes.mjs --tag vX.Y.Z [--integrity sha512-...]");

const version = tag.replace(/^v/u, "");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.equal(
  manifest.version,
  version,
  `the tag ${tag} does not match package.json version ${manifest.version}`,
);

const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const heading = new RegExp(`^## \\[${version.replace(/\./gu, "\\.")}\\][^\\n]*$`, "mu");
const start = changelog.search(heading);
assert(start !== -1, `CHANGELOG.md has no released section for ${version}`);

const body = changelog.slice(start);
const next = body.slice(1).search(/^## /mu);
const section = (next === -1 ? body : body.slice(0, next + 1)).split("\n").slice(1).join("\n");
assert(section.trim() !== "", `the CHANGELOG.md section for ${version} is empty`);

// The changelog is reference-linked and its definitions live at the end of the
// file, outside whatever section is being extracted. Without carrying them
// along, every `([#109])` renders in the release notes as literal brackets.
const definitions = new Map(
  [...changelog.matchAll(/^(\[[^\]]+\]):\s*(\S+)$/gmu)].map((match) => [match[1], match[2]]),
);
const used = [...new Set([...section.matchAll(/\[[^\]]+\](?![(:])/gu)].map((match) => match[0]))]
  .filter((reference) => definitions.has(reference))
  .map((reference) => `${reference}: ${definitions.get(reference)}`);

const tarball = `${manifest.name.replace("@", "").replace("/", "-")}-${version}.tgz`;
const integrity = argument("integrity");
const linkedSection = section.trim().replace(/\]\(((?:docs|bench)\/[^)\s]+)\)/gu, (_match, path) =>
  `](${REPOSITORY}/blob/${tag}/${path})`,
);

process.stdout.write(
  `${linkedSection}\n\n` +
    (used.length === 0 ? "" : `${used.join("\n")}\n\n`) +
    "## Installing without build scripts\n\n" +
    "A consumer that pins `ignore-scripts=true` never runs `prepare`, so it cannot build\n" +
    "`dist/` from a git reference. The attached tarball is `npm pack` of this tag, `dist/`\n" +
    "included.\n\n" +
    "```jsonc\n" +
    `"${manifest.name}": "${REPOSITORY}/releases/download/${tag}/${tarball}"\n` +
    "```\n" +
    (integrity === undefined ? "" : `\nPacked integrity: \`${integrity}\`\n`),
);
