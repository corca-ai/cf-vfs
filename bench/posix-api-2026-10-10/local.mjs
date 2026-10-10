import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution, pairedRatio, pairOrder } from "../comparison.mjs";

const [before, after, out] = process.argv.slice(2);
const rows = [],
  queries = {};
const names = process.env.OPERATIONS?.split(",") ?? [
  "stat-shallow",
  "stat-deep",
  "stat-link",
  "stat-denied",
  "read-deep",
  "overwrite",
  "append-small",
  "append-large-tail",
  "mkdir-wide",
  "mkdir-deep",
  "rename",
  "unlink",
  "rmdir",
];
const count = 300;
for (let pair = -2; pair < (process.env.PROFILE === "1" ? 1 : 10); pair++)
  for (const version of pairOrder(pair)) {
    const { NodeSqlFileSystem } = await import(
      new URL(
        "testing/node.js",
        pathToFileURL(`${resolve(version === "baseline" ? before : after)}/`),
      )
    );
    for (const name of names) {
      let statements = 0;
      const q = [];
      const root = new NodeSqlFileSystem({
        onStatement:
          process.env.PROFILE === "1"
            ? (sql) => {
                statements++;
                q.push(sql);
              }
            : undefined,
        maxEntries: 10000,
        maxInlineLogicalBytes: 64 * 1024 * 1024,
      });
      try {
        root.mkdir("/work");
        root.setOwnership("/work", { uid: 1000, gid: 1000 });
        const fs = root.forCredentials({
          uid: 1000,
          gid: 1000,
          supplementaryGids: Array.from(
            { length: Number(process.env.GROUPS_COUNT ?? 0) },
            (_, index) => index + 1,
          ),
        });
        const deep = "/work/a/b/c/d/e/f/g/h/i/j/k/l";
        fs.mkdir(deep, true);
        await fs.writeFile("/work/file", "a".repeat(768));
        await fs.writeFile(`${deep}/file`, "a".repeat(768));
        if (name === "stat-link") fs.symlink("/work/link", deep);
        fs.mkdir("/work/denied");
        fs.setMetadata("/work/denied", { mode: 0 });
        if (["rename", "unlink"].includes(name))
          for (let i = 0; i < count; i++) await fs.writeFile(`/work/f${i}`, "data");
        if (name === "rmdir") for (let i = 0; i < count; i++) fs.mkdir(`/work/d${i}`);
        if (name === "append-large-tail")
          for (let i = 0; i < count; i++) await fs.writeFile(`/work/f${i}`, "x".repeat(60000));
        statements = 0;
        q.length = 0;
        const start = performance.now();
        for (let i = 0; i < count; i++) {
          switch (name) {
            case "stat-shallow":
              assert.equal(fs.stat("/work/file").sizeBytes, 768);
              break;
            case "stat-deep":
              assert.equal(fs.stat(`${deep}/file`).sizeBytes, 768);
              break;
            case "stat-link":
              assert.equal(fs.stat("/work/link/file").sizeBytes, 768);
              break;
            case "stat-denied":
              assert.throws(
                () => fs.stat("/work/denied/file"),
                (e) => e.code === "EACCES",
              );
              break;
            case "read-deep":
              assert.equal(
                (await new Response(fs.readFile(`${deep}/file`).stream).arrayBuffer()).byteLength,
                768,
              );
              break;
            case "overwrite":
              await fs.writeFile("/work/file", "z".repeat(768));
              break;
            case "append-small":
              await fs.appendFile("/work/file", "xyz");
              break;
            case "append-large-tail":
              await fs.appendFile(`/work/f${i}`, "xyz");
              break;
            case "mkdir-wide":
              fs.mkdir(`/work/d${i}`);
              break;
            case "mkdir-deep":
              fs.mkdir(`${deep}/d${i}`);
              break;
            case "rename":
              await fs.move(`/work/f${i}`, `/work/g${i}`);
              break;
            case "unlink":
              await fs.remove(`/work/f${i}`);
              break;
            case "rmdir":
              await fs.remove(`/work/d${i}`);
              break;
          }
        }
        const ms = performance.now() - start;
        if (pair >= 0) rows.push({ pair, version, name, ms, statements });
        if (pair === 0 && version === "baseline")
          queries[name] = Object.entries(
            q.reduce((m, s) => {
              m[s] = (m[s] ?? 0) + 1;
              return m;
            }, {}),
          ).sort((a, b) => b[1] - a[1]);
        if (name === "append-small") assert.equal(fs.stat("/work/file").sizeBytes, 1668);
        if (name === "mkdir-wide")
          assert.equal(fs.stat("/work").nlink ?? fs.stat("/work").linkCount, 304);
      } finally {
        root.close();
      }
    }
  }
const summary = {};
for (const name of names) {
  const a = rows.filter((r) => r.name === name && r.version === "baseline"),
    b = rows.filter((r) => r.name === name && r.version === "candidate");
  summary[name] = {
    before: distribution(a.map((r) => r.ms)),
    after: distribution(b.map((r) => r.ms)),
    ratio: pairedRatio(
      a.map((r) => r.ms),
      b.map((r) => r.ms),
    ),
    statements: [a[0]?.statements, b[0]?.statements],
  };
}
await writeFile(
  out,
  `${JSON.stringify(
    { count, summary, rows, ...(process.env.PROFILE === "1" ? { queries } : {}) },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(summary));
