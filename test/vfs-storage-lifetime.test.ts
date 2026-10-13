import { expect, it } from "vitest";
import { NodeSqlFileSystem } from "../src/testing/node.js";
import type { VfsSqlBinding, VfsSqlCursor, VfsSqlRow } from "../src/vfs/sql.js";

it("rejects an EOF read after the backing storage closes, even after metadata prefetch", async () => {
  const fs = new NodeSqlFileSystem();
  try {
    await fs.writeFile("/public", "body");
    await fs.writeFile("/other", "other");
    const user = fs.forCredentials({ uid: 1000, gid: 1000 });
    user.statMany?.(["/public", "/other"]);
    fs.close();
    expect(() =>
      user.readFile("/public", { range: { offset: Number.MAX_SAFE_INTEGER } }),
    ).toThrow();
  } finally {
    fs.close();
  }
});

it("observes a permission mutation at the next storage access after metadata prefetch", async () => {
  class BeforeQueryFileSystem extends NodeSqlFileSystem {
    beforeNextQuery: (() => void) | undefined;
    constructor() {
      super();
      const execute = this.sql.exec.bind(this.sql);
      this.sql.exec = <Row extends VfsSqlRow>(
        query: string,
        ...bindings: VfsSqlBinding[]
      ): VfsSqlCursor<Row> => {
        const before = this.beforeNextQuery;
        this.beforeNextQuery = undefined;
        before?.();
        return execute<Row>(query, ...bindings);
      };
    }
  }
  const fs = new BeforeQueryFileSystem();
  try {
    await fs.writeFile("/public", "body");
    await fs.writeFile("/other", "other");
    const user = fs.forCredentials({ uid: 1000, gid: 1000 });
    user.statMany?.(["/public", "/other"]);
    fs.beforeNextQuery = () => fs.setMetadata("/public", { mode: 0o100600 });
    expect(() => user.readFile("/public", { range: { offset: Number.MAX_SAFE_INTEGER } })).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
  } finally {
    fs.close();
  }
});
