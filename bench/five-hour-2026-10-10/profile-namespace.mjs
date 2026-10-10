import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [graph, output] = process.argv.slice(2);
const base = pathToFileURL(`${resolve(graph)}/`);
const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", base));
const queries = new Map();
let phase;
const raw = new NodeSqlFileSystem({
  onStatement(query, returnedRows) {
    if (phase === undefined) return;
    const key = `${phase}\0${query}`;
    const value = queries.get(key) ?? { phase, query, statements: 0, returnedRows: 0 };
    value.statements++;
    value.returnedRows += returnedRows;
    queries.set(key, value);
  },
});
const fs = process.env.CREDENTIALS === "demo" ? raw.forCredentials({ uid: 1000, gid: 1000 }) : raw;
raw.setMetadata("/", { mode: 0o40777 });
const sql = Reflect.get(raw, "sql");
const actualBindings = new Map();
Reflect.set(
  raw,
  "sql",
  new Proxy(sql, {
    get(target, property) {
      if (property === "exec")
        return (query, ...bindings) => {
          if (phase !== undefined) actualBindings.set(`${phase}\0${query}`, bindings);
          return target.exec(query, ...bindings);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
);
const results = [];
try {
  for (let index = 0; index < 1000; index++)
    await fs.writeFile(`/source/f${index}`, `file ${index}`, { createParents: true });
  phase = "rename";
  results.push(await fs.move("/source/f0", "/source/renamed"));
  phase = "copy-tree";
  results.push(await fs.copy("/source", "/copy", { recursive: true }));
  phase = "copy-file";
  results.push(await fs.copy("/source/f1", "/point-copy"));
  phase = undefined;
  for (const value of queries.values()) {
    if (/^(?:BEGIN|COMMIT|ROLLBACK)$/u.test(value.query.trim())) continue;
    value.bindings = actualBindings.get(`${value.phase}\0${value.query}`);
    value.plan = sql.exec(`EXPLAIN QUERY PLAN ${value.query}`, ...value.bindings).toArray();
  }
  const rows = [...queries.values()];
  await writeFile(
    output,
    `${JSON.stringify({ note: "Node query-plan diagnostic, not native CF billed rows or latency evidence", graph, results, rows }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      rows.filter((row) => row.plan?.some((step) => String(step.detail).includes("SCAN"))),
      null,
      2,
    ),
  );
} finally {
  raw.close();
}
