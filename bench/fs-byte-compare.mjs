import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { measurePairs } from "./comparison.mjs";

const baseline = process.env.FS_BASELINE;
const candidate = process.env.FS_CANDIDATE;
if (!baseline || !candidate)
  throw new Error("set FS_BASELINE and FS_CANDIDATE to compiled dist directories");
const output = [];
for (const size of [80, 800, 8192]) {
  const suites = {};
  for (const [name, root] of Object.entries({ baseline, candidate })) {
    const { NodeSqlFileSystem } = await import(pathToFileURL(path.join(root, "testing/node.js")));
    let vfs, statements, returnedRows;
    suites[name] = {
      prepare: async () => {
        vfs?.close();
        statements = 0;
        returnedRows = 0;
        vfs = new NodeSqlFileSystem({
          onStatement: (_q, n) => {
            statements++;
            returnedRows += n;
          },
        });
        vfs.mkdir("/dir");
        statements = 0;
        returnedRows = 0;
      },
      run: async () => {
        await suites[name].prepare();
        const body = new Uint8Array(size).fill(1);
        for (let i = 0; i < 1000; i++) await vfs.writeFile(`/dir/f${i}`, body);
        return { statements, returnedRows };
      },
      close: () => vfs?.close(),
    };
  }
  try {
    output.push({ size, ...(await measurePairs(suites, `byte-${size}`, 4, 20)) });
  } finally {
    for (const suite of Object.values(suites)) suite.close();
  }
}
fs.writeFileSync(
  process.env.FS_COMPARE_OUTPUT || new URL("./fs-byte-comparison.json", import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log(JSON.stringify(output));
