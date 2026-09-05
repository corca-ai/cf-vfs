import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeSqlFileSystem as Current } from "../dist/testing/node.js";

assert.ok(process.argv[2], "Pass a saved baseline dist directory");
const { NodeSqlFileSystem: Baseline } = await import(
  new URL("testing/node.js", pathToFileURL(`${resolve(process.argv[2])}/`))
);
const a = new Baseline({ now: () => 1, createId: () => "epoch" });
const b = new Current({ now: () => 1, createId: () => "epoch" });
let comparisons = 0;
try {
  for (const name of [
    "a",
    "aa",
    "b.txt",
    "b.txt.bak",
    "target",
    "target\n",
    "target\r\n",
    "😀",
    "\ue000",
    "nested/a",
    "nested/deep/b",
    "[a]",
    "x*",
  ]) {
    for (const fs of [a, b]) await fs.writeFile(`/tree/${name}`, "x", { createParents: true });
  }
  for (const name of [
    undefined,
    "*",
    "a",
    "?",
    "*.txt",
    "target",
    "target*",
    "[ab]*",
    "\\[a\\]",
    "😀*",
    "*\n",
    "",
  ]) {
    for (const maxDepth of [undefined, 0, 0.5, 1, 1.5, 2, -1, Infinity, NaN]) {
      for (const cursor of [undefined, "", "/tree/a", "/tree/😀", "/tree/\ue000", "/z"]) {
        for (const limit of [1, 3, 100]) {
          for (const type of [undefined, "file", "directory", "symlink"]) {
            for (const includeRoot of [false, true]) {
              const options = { path: "/tree", name, maxDepth, cursor, limit, type, includeRoot };
              for (const method of ["find", "findPage"]) {
                assert.deepEqual(
                  b[method](options),
                  a[method](options),
                  `${method}: ${JSON.stringify(options)}`,
                );
                comparisons++;
              }
            }
          }
        }
      }
    }
  }
  console.log(JSON.stringify({ comparisons, baseline: process.argv[2] }));
} finally {
  a.close();
  b.close();
}
