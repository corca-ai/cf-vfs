import { readFileSync } from "node:fs";

// A client for the SQL lab Worker (eval/sql-lab). The bearer token comes from
// eval/sql-lab/.secrets.json and is never printed.

const BASE = "https://lab.vfs.borca.ai/lab";
const token = JSON.parse(
  readFileSync(new URL("../../eval/sql-lab/.secrets.json", import.meta.url), "utf8"),
).LAB_TOKEN;
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "cf-vfs-sql-lab/1",
};

async function call(method, path, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
  return text === "" ? undefined : JSON.parse(text);
}

export function lab(name) {
  return {
    /** Seeds files, `{ path: content }`, through the filesystem in request-sized batches. */
    async seed(files) {
      let batch = [];
      let bytes = 0;
      for (const [path, content] of Object.entries(files)) {
        const size = Buffer.byteLength(content) + path.length + 64;
        if (batch.length === 1000 || bytes + size > 7 * 1024 * 1024) {
          await call("POST", `/${name}/seed`, { files: batch });
          batch = [];
          bytes = 0;
        }
        batch.push({ path, content });
        bytes += size;
      }
      if (batch.length > 0) await call("POST", `/${name}/seed`, { files: batch });
    },
    /** `[sql, params?]` statements; returns results and the request's milliseconds. */
    sql(statements, { repeat = 1, maxRows = 20 } = {}) {
      return call("POST", `/${name}/sql`, {
        statements: statements.map(([sql, params]) => ({ sql, params: params ?? [] })),
        repeat,
        maxRows,
      });
    },
    read(paths, mode = "stream") {
      return call("POST", `/${name}/read`, { paths, mode });
    },
    micro(kind, n) {
      return call("POST", `/${name}/micro`, { kind, n });
    },
    /** Runs a script in a fresh evaluation shell; `bulk: false` withholds readMany. */
    shell(script, { bulk = true } = {}) {
      return call("POST", `/${name}/shell`, { script, bulk });
    },
    destroy() {
      return call("DELETE", `/${name}`);
    },
  };
}
