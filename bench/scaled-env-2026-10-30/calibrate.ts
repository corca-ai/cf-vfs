import { readFileSync, writeFileSync } from "node:fs";
import {
  evalShell,
  provisionEvalWorkspace,
  type SeedFile,
  seedEvalWorkspace,
} from "../../eval/profile.js";
import type { ShellEvent } from "../../src/shell/events.js";
import { NodeSqlFileSystem } from "../../src/testing/node.js";

// Usage (bundled like eval:replay):
//   node calibrate.mjs FIXTURES [OUT.json]
// FIXTURES holds s3.json (2,000 pages) and s3-10k.json (10,000 pages) from
// bench/awiki-scenarios-2026-10-30/fixtures.py.
//
// Runs probe scripts, the commands agents ran over the wiki, in the
// evaluation shell profile: once over 10,000 pages with the default limits,
// once over 2,000 pages with limits scaled by 0.2. A scaled environment stands
// in for the large one when the same probes succeed or stop at the same limit.

const PROBES: readonly [string, string][] = [
  ["find count", "find wiki -name '*.md' | wc -l"],
  ["find type f head", "find wiki -type f | head -3 | wc -l"],
  ["ls -R count", "ls -R wiki | wc -l"],
  ["for over $(find)", "n=0; for f in $(find wiki -name '*.md'); do n=$((n+1)); done; echo $n"],
  ["for over glob", "n=0; for f in wiki/*/*.md wiki/*/*/*.md; do n=$((n+1)); done; echo $n"],
  ["while read find", "find wiki -name '*.md' | while read -r f; do head -1 \"$f\"; done | wc -l"],
  ["xargs grep -l", "find wiki -name '*.md' | xargs grep -l 'tags:' | wc -l"],
  ["find -exec grep -L", "find wiki -name '*.md' -exec grep -L '^owner:' {} + | wc -l"],
  ["grep -rl", "grep -rl 'owner:' wiki | wc -l"],
  ["grep -rc sum", "grep -rc '\\[\\[' wiki | awk -F: '{ s += $2 } END { print s }'"],
  [
    "grep -o links ranked",
    "grep -rhoE '\\[\\[[^]|#]+' wiki | sort | uniq -c | sort -rn | head -3 | wc -l",
  ],
  [
    "grep -o inbound pipeline",
    "grep -roE '\\[\\[[^]|#]+' --include='*.md' wiki | sed -e 's|^wiki/||' -e 's|\\.md:\\[\\[| |' | awk '{ n = $1; sub(/.*\\//, \"\", n); if (n != $2) print n, $2 }' | sort -u | awk '{ print $2 }' | sort | uniq -c | wc -l",
  ],
  ["cat glob wc", "cat wiki/*/*.md wiki/*/*/*.md | wc -c"],
  ["wc -l $(find)", "wc -l $(find wiki -name '*.md') | tail -1"],
  ["awk over $(find)", "awk 'FNR == 1 { n++ } END { print n }' $(find wiki -name '*.md')"],
  ["awk owners", "awk '/^owner:/ { n++ } END { print n }' $(find wiki -name '*.md')"],
  ["sed -n over find", "find wiki -name '*.md' | head -500 | xargs sed -n '2p' | wc -l"],
  ["awiki lint", "awiki lint -r -root wiki | head -1 | cut -c1-20"],
  ["awiki graph orphans", "awiki graph -r -root wiki | grep -c ' inbound=0 '"],
  ["awiki graph -json jq", "awiki graph -r -root wiki -json | jq '.documents | length'"],
  ["awiki wanted", "awiki wanted -r -root wiki -n 3 | wc -l"],
];

interface Outcome {
  readonly exitCode: number;
  readonly limit: string | null;
  readonly ms: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function seeded(files: Record<string, string>): Promise<NodeSqlFileSystem> {
  const fileSystem = new NodeSqlFileSystem();
  provisionEvalWorkspace(fileSystem);
  const entries: SeedFile[] = Object.entries(files).map(([path, content]) => ({
    path: `wiki/${path}`,
    content,
  }));
  for (let at = 0; at < entries.length; at += 500) {
    await seedEvalWorkspace(fileSystem, entries.slice(at, at + 500));
  }
  return fileSystem;
}

async function probe(
  fileSystem: NodeSqlFileSystem,
  scale: number,
  script: string,
): Promise<Outcome> {
  let limit: string | null = null;
  const shell = evalShell(fileSystem, "/workspace", {
    scale,
    onEvent: (event: ShellEvent) => {
      if (event.type === "shell.limit" && limit === null) limit = event.limit;
    },
  });
  const start = performance.now();
  const result = await shell.executeText({ script });
  return {
    exitCode: result.exitCode,
    limit,
    ms: performance.now() - start,
    stdout: result.stdout.trim().slice(0, 60),
    stderr: result.stderr.trim().slice(0, 120),
  };
}

const [fixtures, out] = process.argv.slice(2);
const load = (name: string) =>
  (
    JSON.parse(readFileSync(`${fixtures}/${name}.json`, "utf8")) as {
      files: Record<string, string>;
    }
  ).files;
const large = await seeded(load("s3-10k"));
const small = await seeded(load("s3"));
const rows = [];
for (const [name, script] of PROBES) {
  const full = await probe(large, 1, script);
  const scaled = await probe(small, 0.2, script);
  const unscaled = await probe(small, 1, script);
  const parity = (full.exitCode === 0) === (scaled.exitCode === 0) && full.limit === scaled.limit;
  const unscaledParity =
    (full.exitCode === 0) === (unscaled.exitCode === 0) && full.limit === unscaled.limit;
  rows.push({ name, script, full, scaled, unscaled, parity, unscaledParity });
  const cell = (o: Outcome) =>
    `${o.exitCode === 0 ? "ok" : `exit ${o.exitCode}`}${o.limit ? ` [${o.limit}]` : ""} ${o.ms.toFixed(0)}ms`;
  console.log(
    `${parity ? "  " : "!!"} ${name.padEnd(26)} 10k: ${cell(full).padEnd(36)} 2k@0.2: ${cell(scaled).padEnd(36)} ratio ${(full.ms / Math.max(scaled.ms, 1)).toFixed(1).padStart(4)}  2k@1: ${unscaledParity ? "same" : cell(unscaled)}`,
  );
}
if (out !== undefined) writeFileSync(out, `${JSON.stringify(rows, null, 1)}\n`);
