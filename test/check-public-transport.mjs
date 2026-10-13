import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const buildId = "a".repeat(64);
const runId = "transport-test-run";
const directory = await mkdtemp(join(tmpdir(), "cf-vfs-public-transport-"));
async function exercise(loseClaim) {
  let claims = 0;
  let polls = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      claims++;
      assert.equal(request.headers.authorization, "Bearer transport-test-only");
      if (loseClaim) return request.socket.destroy();
      response.end(JSON.stringify({ status: "running", runId, buildId, deploymentId: "test" }));
    } else if (++polls === 1) {
      request.socket.destroy();
    } else {
      response.end(JSON.stringify({ status: "ready", result: { runId, buildId, verified: 1 } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const output = join(directory, loseClaim ? "lost-claim.json" : "recovered.json");
  try {
    const child = spawn(
      process.execPath,
      [
        "bench/public-remote.mjs",
        "--url",
        `http://127.0.0.1:${server.address().port}`,
        "--build",
        buildId,
        "--out",
        output,
      ],
      {
        env: { ...process.env, CF_VFS_PUBLIC_BENCHMARK_TOKEN: "transport-test-only" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(claims, 1, "A lost connection must never create a second benchmark");
    if (loseClaim) {
      assert.notEqual(code, 0, stderr);
      assert.equal(polls, 0);
    } else {
      assert.equal(code, 0, stderr);
      assert.equal(JSON.parse(await readFile(output, "utf8")).result.runId, runId);
      assert.equal(JSON.parse(await readFile(`${output}.claim.json`, "utf8")).runId, runId);
      assert.match(stderr, /retrying GET/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
try {
  await exercise(false);
  await exercise(true);
  console.log("Public benchmark transport recovery and single-claim checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
