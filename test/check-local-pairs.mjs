import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(join(tmpdir(), "cf-vfs-local-pairs-"));
try {
  const graphs = [];
  for (const version of ["baseline", "candidate"]) {
    const graph = join(directory, version);
    graphs.push(graph);
    await mkdir(join(graph, "demo"), { recursive: true });
    await mkdir(join(graph, "src/testing"), { recursive: true });
    await writeFile(join(graph, "package.json"), '{"type":"module"}');
    await writeFile(
      join(graph, "src/testing/node.js"),
      `export {NodeSqlFileSystem} from ${JSON.stringify(pathToFileURL(resolve("dist/testing/node.js")).href)};`,
    );
    await writeFile(
      join(graph, "demo/benchmark-suite.js"),
      `
      import assert from 'node:assert/strict';
      import {appendFile} from 'node:fs/promises';
      export function benchmarkPlan(){return [100,200].flatMap(files=>['write','read'].map(operation=>({group:'files',operation,files,cache:false,trial:0})));}
      export class PublicBenchmarkSuite{
        constructor(fs){this.fs=fs;}
        onEvent(){}
        async run(stage){
          await appendFile(process.env.CF_VFS_PROTOCOL_TRACE,${JSON.stringify(version)}+':'+stage.files+':'+stage.operation+'\\n');
          if(stage.operation==='write'){
            assert.throws(()=>this.fs.stat('/marker'),error=>error.code==='ENOENT','Each arm/group requires fresh storage');
            await this.fs.writeFile('/marker',String(stage.files));
          } else assert.equal(await new Response(this.fs.readFile('/marker').stream).text(),String(stage.files));
          return {iterations:1,verified:1};
        }
        async cleanup(){}
      }
    `,
    );
  }
  for (const orderOffset of [0, 1]) {
    const trace = join(directory, `trace-${orderOffset}`),
      output = join(directory, `result-${orderOffset}.json`);
    const child = spawn(process.execPath, ["bench/local-pairs.mjs", ...graphs, output], {
      env: {
        ...process.env,
        PAIRS: "1",
        WARMUPS: "0",
        ORDER_OFFSET: String(orderOffset),
        CREDENTIALS: "",
        BENCH_GROUPS: "",
        CF_VFS_PROTOCOL_TRACE: trace,
      },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 15_000,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.complete, true);
    assert.equal(result.protocol.id, "local-group-v1");
    assert.equal(result.orderOffset, orderOffset);
    assert.equal(result.rows.length, 16);
    assert.ok(result.rows.filter((row) => !row.profile).every((row) => row.statements === 0));
    assert.ok(result.rows.filter((row) => row.profile).every((row) => row.statements > 0));
    const versions = orderOffset ? ["candidate", "baseline"] : ["baseline", "candidate"];
    const pass = [100, 200].flatMap((files) =>
      versions.flatMap((version) =>
        ["write", "read"].map((operation) => `${version}:${files}:${operation}`),
      ),
    );
    assert.deepEqual((await readFile(trace, "utf8")).trim().split("\n"), [...pass, ...pass]);
  }
  console.log(
    "Local paired groups, fresh SQLite fixtures, both starting orders and separate cost replay verified",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
