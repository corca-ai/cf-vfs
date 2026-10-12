import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [before, after, output] = process.argv.slice(2);
const engines = {};
for (const [version, root] of [
  ["baseline", before],
  ["candidate", after],
]) {
  const url = pathToFileURL(root + "/");
  const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", url));
  const { Shell } = await import(new URL("src/shell/shell.js", url));
  const { defaultShellCommands } = await import(new URL("src/shell/commands/default.js", url));
  const { gitCommand } = await import(new URL("src/shell/commands/git.js", url));
  const cost = { statements: 0, returnedRows: 0, traversals: 0 };
  const queries = new Map();
  const fs = new NodeSqlFileSystem({
    onStatement:
      process.env.PROFILE === "1"
        ? (q, n) => {
            cost.statements++;
            queries.set(q, (queries.get(q) ?? 0) + 1);
            cost.returnedRows += n;
            if (q.includes("SELECT path, kind, mode, uid, gid")) cost.traversals++;
          }
        : undefined,
  });
  fs.setMetadata("/", { mode: 0o40777 });
  const view = fs.forCredentials({ uid: 1000, gid: 1000 });
  view.mkdir("/repo");
  for (let i = 0; i < 1000; i++)
    await view.writeFile(
      `/repo/src/d${i % Number(process.env.DIRS ?? 20)}/f${i}.txt`,
      `export const value = 'state0'; // ${i}\n`,
      { createParents: true },
    );
  const shell = new Shell({
    fileSystem: fs,
    commands: [...defaultShellCommands, gitCommand],
    now: () => 1700000000000,
  });
  async function run(script) {
    const r = await shell.executeText({
      script,
      cwd: "/repo",
      credentials: { uid: 1000, gid: 1000 },
    });
    assert.equal(r.exitCode, 0, JSON.stringify(r));
    assert.equal(r.stderr, "");
    return r.stdout;
  }
  await run(
    "git init; git config user.name Bench; git config user.email bench@example.invalid; git add .; git commit -m initial",
  );
  engines[version] = { fs, run, cost, queries };
}
const rows = [];
const outputs = new Map();
try {
  for (let pair = -2; pair < Number(process.env.PAIRS ?? 10); pair++)
    for (const version of pairOrder(pair + 2)) {
      const e = engines[version],
        next = `state${pair + 3}`,
        prev = "state[0-9]*";
      const phases = {
        inspect: "git status --short",
        edit: Array.from(
          { length: 20 },
          (_, i) =>
            `sed 's/${prev}/${next}/g' src/d${i}/f${i}.txt > src/d${i}/next.txt; cat src/d${i}/next.txt > src/d${i}/f${i}.txt; rm src/d${i}/next.txt`,
        ).join("; "),
        verify: Array.from({ length: 20 }, (_, i) => `grep -c ${next} src/d${i}/f${i}.txt`).join(
          "; ",
        ),
        stage: "git add .",
        commit: `git commit -m round${pair}`,
      };
      for (const [phase, script] of Object.entries(phases)) {
        Object.assign(e.cost, { statements: 0, returnedRows: 0, traversals: 0 });
        e.queries.clear();
        const t = performance.now();
        const stdout = await e.run(script);
        const ms = performance.now() - t;
        if (phase === "inspect") assert.equal(stdout, "");
        if (phase === "verify") assert.equal(stdout, "1\n".repeat(20));
        const key = `${pair}:${phase}`;
        if (outputs.has(key)) assert.equal(stdout, outputs.get(key));
        else outputs.set(key, stdout);
        if (pair >= 0)
          rows.push({
            pair,
            version,
            phase,
            ms,
            sql: { ...e.cost },
            queries: [...e.queries.entries()].sort((a, b) => b[1] - a[1]),
          });
      }
    }
} finally {
  for (const e of Object.values(engines)) e.fs.close();
}
const summary = [...new Set(rows.map((r) => r.phase)), "total"].map((phase) => {
  const values = (version) =>
    Array.from({ length: Number(process.env.PAIRS ?? 10) }, (_, i) =>
      rows
        .filter(
          (r) => r.version === version && r.pair === i && (phase === "total" || r.phase === phase),
        )
        .reduce((s, r) => s + r.ms, 0),
    );
  return {
    phase,
    before: distribution(values("baseline")),
    after: distribution(values("candidate")),
    ratio: pairedRatio(values("baseline"), values("candidate")),
  };
});
await writeFile(
  output,
  JSON.stringify(
    {
      profile: process.env.PROFILE === "1",
      pairs: Number(process.env.PAIRS ?? 10),
      warmups: 2,
      directories: Number(process.env.DIRS ?? 20),
      files: 1000,
      changed: 20,
      rows,
      summary,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary, null, 2));
