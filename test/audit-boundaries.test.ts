import { expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { MemoryOpaqueStore } from "../src/testing/opaque-store.js";
import { createBashHarness } from "./helpers/bash.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it.each(["move", "copy"] as const)(
  "preserves non-BMP subtree paths during %s",
  async (operation) => {
    const fs = createTestFileSystem();
    await fs.writeFile("/😀/nested/한글", "body", { createParents: true });
    if (operation === "move") await fs.move("/😀", "/dest");
    else await fs.copy("/😀", "/dest", { recursive: true });
    const stat = fs.stat("/dest/nested/한글");
    expect(stat.parentPath).toBe("/dest/nested");
    await fs.writeFile(stat.path, "guarded", { ifMutationToken: stat.mutationToken });
    expect(fs.list("/dest").map((entry) => entry.path)).toEqual(["/dest/nested"]);
  },
);

it.each([100, 900_000])(
  "refuses expired R2 verification after HEAD (TTL %i)",
  async (expiresInMs) => {
    let now = 1000;
    class SlowHeadStore extends MemoryOpaqueStore {
      override async head(key: string) {
        const result = await super.head(key);
        now += 60_001;
        return result;
      }
    }
    const store = new SlowHeadStore();
    const fs = createTestFileSystem({ opaqueStore: store, now: () => now });
    const upload = await fs.beginOpaqueUpload("/blob", { expiresInMs });
    await store.putIfAbsent(upload.objectKey, "body");
    await expect(fs.commitOpaqueUpload(upload.uploadId)).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    expect(() => fs.stat("/blob")).toThrow();
    now += 1_000_000;
    await fs.drainGarbage();
    expect(await store.head(upload.objectKey)).toBeNull();
  },
);

it.each(["--argjson n 1 --arg s text", "--arg s text --argjson n 1"])(
  "preserves jq binding order: %s",
  async (options) => {
    const { shell } = createBashHarness();
    expect(await shell.executeText({ script: `jq -nc ${options} '[$n,$s]'` })).toMatchObject({
      exitCode: 0,
      stdout: '[1,"text"]\n',
      stderr: "",
    });
  },
);
it("accepts dash-leading jq binding values", async () => {
  const { shell } = createBashHarness();
  expect(await shell.executeText({ script: "jq -nr --arg x -hello '$x'" })).toMatchObject({
    exitCode: 0,
    stdout: "-hello\n",
  });
});
it("bounds AWK scalar concatenation before materialization", async () => {
  const { shell } = createBashHarness({
    commands: [awkCommand],
    limits: { maxExpansionChars: 1024, maxBufferedBytes: 1024 },
  });
  const result = await shell.executeText({
    script: "awk 'BEGIN { x=\"x\"; for(i=0;i<20;i++) x=x x; print length(x) }'",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/limit/);
});

it("accounts for multiple retained AWK scalar strings", async () => {
  const { shell } = createBashHarness({
    commands: [awkCommand],
    limits: { maxExpansionChars: 2048, maxBufferedBytes: 1024 },
  });
  const result = await shell.executeText({
    script:
      'awk \'BEGIN { a=sprintf("%0600d",1); b=sprintf("%0600d",2); print length(a)+length(b) }\'',
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/limit/);
});

it("bounds sed pattern-space expansion even when the result is discarded", async () => {
  const { shell } = createBashHarness({ limits: { maxExpansionChars: 1024 } });
  const result = await shell.executeText({
    script: `sed -n 's/.*/${"&".repeat(20)}/;d'`,
    stdin: "x".repeat(100),
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/limit/);
});

it("bounds AWK record rebuilding against the byte limit", async () => {
  const { shell } = createBashHarness({
    commands: [awkCommand],
    limits: { maxExpansionChars: 10000, maxBufferedBytes: 1024 },
  });
  const result = await shell.executeText({
    script: 'awk \'BEGIN { OFS=sprintf("%0600d",1); $5="x"; print "done" }\'',
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/limit/);
});

it("retains the current AWK record alongside scalar strings", async () => {
  const { shell } = createBashHarness({
    commands: [awkCommand],
    limits: { maxBufferedBytes: 1024 },
  });
  const result = await shell.executeText({
    script: 'awk \'BEGIN { $0=sprintf("%0600d",1); x=sprintf("%0600d",2); print "done" }\'',
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/limit/);
});
