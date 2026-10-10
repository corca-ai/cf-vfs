import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [before, after, out] = process.argv.slice(2);
const profiling = process.env.PROFILE_DIFF === "1";
const mode = "clone-two-generations";
async function trial(version, rootPath, n) {
  const root = pathToFileURL(`${resolve(rootPath)}/`);
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
  const { Shell } = await import(new URL("shell/shell.js", root));
  const { gitCommand } = await import(new URL("shell/commands/git.js", root));
  let sql = 0,
    reads = 0;
  const vfs = new NodeSqlFileSystem(profiling ? { onStatement: () => sql++ } : {});
  if (profiling) {
    const read = vfs.readFile.bind(vfs);
    vfs.readFile = (...args) => {
      reads++;
      return read(...args);
    };
  }
  const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
  const run = (script) => shell.executeText({ script, cwd: "/repo" });
  try {
    assert.equal((await shell.executeText({ script: "git init /repo" })).exitCode, 0);
    assert.equal(
      (await run("git config user.name Benchmark; git config user.email bench@example.invalid"))
        .exitCode,
      0,
    );
    for (let i = 0; i < 1000; i++) {
      let seed = i + 1;
      const body = Uint8Array.from({ length: 768 }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return 32 + ((seed >>> 24) % 95);
      });
      await vfs.writeFile(`/repo/f${i}`, body);
    }
    assert.equal((await run("git add -A && git commit -m initial")).exitCode, 0);
    assert.equal((await run("git branch base")).exitCode, 0);
    for (let i = 0; i < 1000; i++) {
      const body = new Uint8Array(
        await new Response(vfs.readFile(`/repo/f${i}`).stream).arrayBuffer(),
      );
      body[0] = body[0] === 32 ? 33 : 32;
      await vfs.writeFile(`/repo/f${i}`, body);
    }
    assert.equal((await run("git add -A; git commit -m next")).exitCode, 0);
    const script = "git clone /repo /copy";
    sql = 0;
    reads = 0;
    const started = performance.now();
    const result = await run(script);
    const ms = performance.now() - started;
    assert.equal(result.exitCode, 0, result.stderr);
    const counters = { sql, reads };
    assert.equal(
      (await shell.executeText({ script: "git status --porcelain", cwd: "/copy" })).stdout,
      "",
    );
    const text = await new Response(vfs.readFile("/copy/f0").stream).text();
    assert.equal(text.length, 768);
    return { version, n, ms, ...(profiling ? counters : {}) };
  } finally {
    vfs.close();
  }
}
const rows = [];
for (let n = -3; n < (profiling ? 1 : 10); n++) {
  for (const version of pairOrder(n)) {
    const row = await trial(version, version === "baseline" ? before : after, n);
    if (n >= 0) rows.push(row);
  }
}
const first = rows.filter((row) => row.version === "baseline"),
  second = rows.filter((row) => row.version === "candidate");
const result = {
  mode,
  profiling,
  node: process.version,
  before: distribution(first.map((row) => row.ms)),
  after: distribution(second.map((row) => row.ms)),
  ratio: pairedRatio(
    first.map((row) => row.ms),
    second.map((row) => row.ms),
  ),
  rows,
};
await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify({
    mode,
    profiling,
    before: result.before,
    after: result.after,
    ratio: result.ratio,
  }),
);
