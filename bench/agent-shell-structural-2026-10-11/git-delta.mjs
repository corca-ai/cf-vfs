import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const commitCycle = process.env.COMMIT_CYCLE === "1";
const [root, output, candidateRoot] = process.argv.slice(2),
  base = pathToFileURL(`${resolve(root)}/`);
const tracked = candidateRoot
  ? await import(
      new URL("src/shell/commands/git-tracked.js", pathToFileURL(`${resolve(candidateRoot)}/`))
    )
  : undefined;
const CandidateFs = candidateRoot
  ? (await import(new URL("src/testing/node.js", pathToFileURL(`${resolve(candidateRoot)}/`))))
      .NodeSqlFileSystem
  : undefined;
const CandidateShell = candidateRoot
  ? (await import(new URL("src/shell/shell.js", pathToFileURL(`${resolve(candidateRoot)}/`)))).Shell
  : undefined;
const { Shell } = await import(new URL("src/shell/shell.js", base));
const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", base));
const { gitCommand } = await import(new URL("src/shell/commands/git.js", base));
const { defaultShellCommands } = await import(new URL("src/shell/commands/default.js", base));
const engines = {};
const files = 1000,
  changed = 10;
async function run(shell, script) {
  const r = await shell.executeText({ script, cwd: "/repo" });
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.stderr, "");
  return r.stdout;
}
function makeShell(version, fs) {
  return new (version === "candidate" && CandidateShell ? CandidateShell : Shell)({
    fileSystem: fs,
    commands: [
      ...defaultShellCommands,
      version === "candidate" && tracked ? tracked.createTrackedGitCommand(fs) : gitCommand,
    ],
    now: () => 1700000000000,
  });
}
for (const version of ["baseline", "candidate"]) {
  const cost = { statements: 0, returnedRows: 0 };
  const fs = new (version === "candidate" && CandidateFs ? CandidateFs : NodeSqlFileSystem)({
    recordChanges: process.env.MATCH_RECORDING === "1" || version === "candidate",
    maxEntries: 20000,
    onStatement: (_q, rows) => {
      cost.statements++;
      cost.returnedRows += rows;
    },
  });
  fs.mkdir("/repo");
  for (let i = 0; i < files; i++)
    await fs.writeFile(`/repo/d${Math.floor(i / 20)}/f${i}.txt`, `original ${i}\n`, {
      createParents: true,
    });
  const shell = makeShell(version, fs);
  await run(
    shell,
    "git init; git config user.name Bench; git config user.email bench@example.com; git add .; git commit -m initial",
  );
  let cursor = 0;
  if (version === "candidate") {
    let page;
    do {
      page = fs.changesSince(cursor);
      cursor = page.cursor;
    } while (page.more);
  }
  engines[version] = { fs, shell, cost, cursor };
}
const rawMs = { baseline: [], candidate: [] },
  rawCosts = { baseline: [], candidate: [] },
  writeMs = { baseline: [], candidate: [] },
  writeCosts = { baseline: [], candidate: [] };
try {
  for (let pair = -3; pair < 20; pair++) {
    for (const version of pairOrder(pair + 3)) {
      const e = engines[version];
      if (process.env.COLD_COMMAND === "1") e.shell = makeShell(version, e.fs);
      e.cost.statements = 0;
      e.cost.returnedRows = 0;
      const ws = performance.now();
      for (let i = 0; i < changed; i++)
        await e.fs.writeFile(`/repo/d${i}/f${i * 20}.txt`, `edit ${pair}:${i}\n`);
      const wt = performance.now() - ws,
        wc = { ...e.cost };
      e.cost.statements = 0;
      e.cost.returnedRows = 0;
      const start = performance.now();
      let command = "git add .";
      if (version === "candidate" && !tracked) {
        const paths = new Set();
        let page;
        do {
          page = e.fs.changesSince(e.cursor);
          e.cursor = page.cursor;
          for (const c of page.changes)
            if (
              c.path.startsWith("/repo/") &&
              !c.path.startsWith("/repo/.git/") &&
              c.path !== "/repo/.git"
            )
              paths.add(c.path.slice(6));
        } while (page.more);
        // Restricted prototype: fixture edits only known regular files, with no permission,
        // ignore, HEAD, external index, concurrent or topology changes. NOT a general git add.
        command = `git add -- ${[...paths].map((p) => `'${p}'`).join(" ")}`;
      }
      await run(e.shell, command);
      const ms = performance.now() - start,
        cost = { ...e.cost };
      if (pair >= 0) {
        rawMs[version].push(ms);
        rawCosts[version].push(cost);
        writeMs[version].push(wt);
        writeCosts[version].push(wc);
      }
    }
    const a = await run(engines.baseline.shell, "git status --short"),
      b = await run(engines.candidate.shell, "git status --short");
    assert.equal(a, b);
    assert.equal(a.split("\n").filter(Boolean).length, changed);
    // Existing diff emits file blocks in completion order; compare exact blocks by path.
    const blocks = (s) => s.split(/(?=^diff --git )/m).sort();
    assert.deepEqual(
      blocks(await run(engines.baseline.shell, "git diff --cached")),
      blocks(await run(engines.candidate.shell, "git diff --cached")),
    );
    if (commitCycle)
      assert.equal(
        await run(engines.baseline.shell, `git commit -m round${pair}`),
        await run(engines.candidate.shell, `git commit -m round${pair}`),
      );
  }
} finally {
  for (const { fs } of Object.values(engines)) fs.close();
}
const result = {
  node: process.version,
  commitCycle,
  coldCommand: process.env.COLD_COMMAND === "1",
  files,
  changed,
  pairs: 20,
  warmups: 3,
  scope: tracked
    ? "tracked command prototype, ordinary git add . in both arms"
    : "trusted host proof, known regular-file edits only; not a production-safe Git implementation",
  rawMs,
  rawCosts,
  writeMs,
  writeCosts,
  ratio: pairedRatio(rawMs.baseline, rawMs.candidate),
  baseline: distribution(rawMs.baseline),
  candidate: distribution(rawMs.candidate),
  totalRatio: pairedRatio(
    rawMs.baseline.map((x, i) => x + writeMs.baseline[i]),
    rawMs.candidate.map((x, i) => x + writeMs.candidate[i]),
  ),
};
await writeFile(output, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    {
      ratio: result.ratio,
      totalRatio: result.totalRatio,
      baseline: result.baseline,
      candidate: result.candidate,
      costs: Object.fromEntries(Object.entries(rawCosts).map(([k, v]) => [k, v[0]])),
      writeCosts: Object.fromEntries(Object.entries(writeCosts).map(([k, v]) => [k, v[0]])),
    },
    null,
    2,
  ),
);
