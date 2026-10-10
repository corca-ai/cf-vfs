import assert from "node:assert/strict";
import { cp, readFile, rm, writeFile } from "node:fs/promises";

const root = new URL("./compiled/", import.meta.url);
const source = new URL("point-change-feed/", root);
const target = new URL("json-entry-prototype/", root);
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true, verbatimSymlinks: true });
const { ENTRY_COLUMNS } = await import(new URL("src/vfs/sql-schema.js", source));
const fields = ENTRY_COLUMNS.match(/COALESCE\([^)]*\) AS \w+|e\.\w+/gu);
assert.equal(fields.length, 19);
const expression = `json_object(${fields
  .map((field) => {
    const [value, alias] = field.split(" AS ");
    return `'${alias ?? value.slice(2)}',${value}`;
  })
  .join(",")}) AS entry`;
const path = new URL("src/vfs/sql-path-base.js", target);
let value = await readFile(path, "utf8");
const start = value.indexOf("    oneEntry(path) {");
assert.ok(start >= 0);
const end = value.indexOf("\n    /**", start);
const method = value.slice(start, end);
assert.ok(method.includes("parseEntry(row, this.mutationEpoch)"));
const changed = method
  .replace("SELECT ${ENTRY_COLUMNS}", `SELECT ${expression}`)
  .replace(
    "parseEntry(row, this.mutationEpoch)",
    "parseEntry(JSON.parse(row.entry), this.mutationEpoch)",
  );
assert.notEqual(method, changed);
value = value.slice(0, start) + changed + value.slice(end);
await writeFile(path, value);
console.log("Prepared JSON entry prototype; immutable compiled baseline retained");
