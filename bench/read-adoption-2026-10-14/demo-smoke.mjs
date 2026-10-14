import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const WebSocket = require("ws");
const root = "bench/read-adoption-2026-10-14";
const cleanupOnly = process.argv.includes("--cleanup-old");
const prior = cleanupOnly
  ? JSON.parse(await readFile(`${root}/demo-smoke-initial.json`, "utf8"))
  : null;
const directory = prior?.directory ?? `/tmp/cf-vfs-adoption-${randomUUID()}`;
assert.match(directory, /^\/tmp\/cf-vfs-adoption-[0-9a-f-]{36}$/);
const socket = new WebSocket("wss://vfs.borca.ai/ws", {
  headers: { Origin: "https://vfs.borca.ai" },
  family: 4,
  handshakeTimeout: 20000,
});
let pending;
let hello;
let initialResolve, initialReject;
const initial = new Promise((resolve, reject) => {
  initialResolve = resolve;
  initialReject = reject;
});
const watchdog = setTimeout(() => {
  const e = Error("Smoke handshake timed out");
  initialReject(e);
  socket.terminate();
}, 25000);
socket.on("error", (error) => {
  initialReject(error);
  pending?.reject(error);
});
socket.on("message", (bytes) => {
  const m = JSON.parse(bytes.toString());
  if (m.type === "hello") hello = { protocol: m.protocol, workspace: m.workspace, cwd: m.cwd };
  if (m.type === "error") {
    pending?.reject(Error(m.message));
    return;
  }
  if (m.type === "output" && pending) pending[m.stream] += m.data;
  if (m.type === "complete" && pending) {
    pending.exitCode = m.exitCode;
    pending.cwd = m.cwd;
  }
  if (m.type === "prompt") {
    if (pending) {
      const p = pending;
      pending = undefined;
      clearTimeout(p.timeout);
      p.resolve({
        stdout: p.stdout,
        stderr: p.stderr,
        exitCode: p.exitCode ?? m.exitCode,
        cwd: m.cwd,
      });
    } else {
      clearTimeout(watchdog);
      initialResolve();
    }
  }
});
async function execute(line) {
  assert.equal(pending, undefined);
  return await new Promise((resolve, reject) => {
    pending = {
      resolve,
      reject,
      stdout: "",
      stderr: "",
      timeout: setTimeout(() => {
        reject(Error("Smoke command timed out"));
        socket.terminate();
      }, 30000),
    };
    socket.send(JSON.stringify({ type: "line", line }));
  });
}
const record = {
  at: new Date().toISOString(),
  note: "Real public demo WebSocket, own UUID temporary directory only; commands validate init/add/commit/status/local-clone/body and clean up. Untimed functional smoke, not benchmark samples.",
  directory,
};
try {
  await initial;
  record.hello = hello;
  if (prior) assert.equal(hello.workspace, prior.hello.workspace);
  const script = [
    `mkdir -p ${directory}`,
    `cd ${directory}`,
    "git init -b main",
    "git config user.name AdoptionSmoke",
    "git config user.email adoption@example.invalid",
    "printf 'hello\\n' > first.txt",
    "git add -A",
    "git commit -m first",
    `test -z "$(git status --porcelain)"`,
    "git clone . copy",
    `test "$(cat copy/first.txt)" = hello`,
    "cd copy",
    `test -z "$(git status --porcelain)"`,
    "git log -n 1 --oneline",
    "printf 'adoption-smoke-ok\\n'",
  ].join(" && ");
  if (!cleanupOnly) {
    record.scriptHash = createHash("sha256").update(script).digest("hex");
    record.result = await execute(script);
    assert.equal(record.result.exitCode, 0);
    assert.ok(record.result.stdout.includes("adoption-smoke-ok"));
  }
} catch (error) {
  record.error = String(error);
  process.exitCode = 1;
} finally {
  if (socket.readyState === WebSocket.OPEN && !pending) {
    try {
      record.cleanup = await execute(`cd /tmp && rm -rf ${directory}`);
      assert.equal(record.cleanup.exitCode, 0);
      record.absence = await execute(`test -d ${directory}`);
      assert.equal(record.absence.exitCode, 1);
    } catch (error) {
      record.cleanupError = String(error);
      process.exitCode = 1;
    }
  }
  clearTimeout(watchdog);
  if (pending) clearTimeout(pending.timeout);
  socket.close();
  await writeFile(
    `${root}/${cleanupOnly ? "demo-smoke-initial-cleanup" : "demo-smoke"}.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      success: !record.error && !record.cleanupError,
      exitCode: record.result?.exitCode,
      cleanupExitCode: record.cleanup?.exitCode,
    }),
  );
}
