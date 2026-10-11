import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2] ?? "/tmp/cf-vfs-capabilities-baseline";
const { NodeSqlFileSystem } = await import(
  pathToFileURL(resolve(root, "src/testing/node.js")).href
);

import { writeFile } from "node:fs/promises";

const rows = [];
for (const credentials of [false, true]) {
  const cost = { statements: 0, returnedRows: 0 };
  const fs = new NodeSqlFileSystem({
    recordChanges: true,
    onStatement: (_q, n) => {
      cost.statements++;
      cost.returnedRows += n;
    },
  });
  fs.mkdir("/work");
  await fs.writeFiles(
    Array.from({ length: 1000 }, (_, i) => ({ path: `/work/f${i}`, body: "hello" })),
  );
  const view = credentials ? fs.forCredentials({ uid: 1000, gid: 1000 }) : fs;
  const paths = Array.from({ length: 1000 }, (_, i) => `/work/f${i}`);
  for (let warm = 0; warm < 3; warm++) paths.map((p) => view.lstat(p));
  for (let pair = 0; pair < 10; pair++) {
    cost.statements = 0;
    cost.returnedRows = 0;
    const start = performance.now();
    const result = paths.map((p) => view.lstat(p));
    const ms = performance.now() - start;
    rows.push({ credentials, pair, ms, ...cost, entries: result.length });
  }
  const cursor = fs.changesSince(0).cursor;
  await fs.writeFile("/work/f0", "changed");
  cost.statements = 0;
  cost.returnedRows = 0;
  const start = performance.now();
  const all = fs.find({ path: "/work", includeRoot: true });
  rows.push({
    operation: "full-refresh",
    ms: performance.now() - start,
    ...cost,
    entries: all.length,
    changes: fs.changesSince(cursor).changes.length,
  });
  fs.close();
}
await writeFile(new URL("./baseline.json", import.meta.url), `${JSON.stringify(rows, null, 2)}\n`);
console.log(rows);
