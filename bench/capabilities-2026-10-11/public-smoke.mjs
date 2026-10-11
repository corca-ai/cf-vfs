import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import WebSocket from "ws";

// Country workspaces are shared: create and remove only our unique directory.
const root = `/home/demo/.capability-smoke-${randomUUID()}`;
const socket = new WebSocket("wss://vfs.borca.ai/ws", {
  headers: { Origin: "https://vfs.borca.ai" },
});
const messages = [];
const waiters = new Set();
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  messages.push(message);
  for (const waiter of waiters) waiter(message);
});
function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(receive);
      reject(new Error("Public shell response timed out"));
    }, 60_000);
    function receive(message) {
      if (message.type === "error" || predicate(message)) {
        clearTimeout(timer);
        waiters.delete(receive);
        if (message.type === "error") reject(new Error(message.message));
        else resolve(message);
      }
    }
    waiters.add(receive);
  });
}
async function send(message, predicate) {
  const pending = waitFor(predicate);
  socket.send(JSON.stringify(message));
  return pending;
}
async function run(line, expected = 0) {
  const at = messages.length;
  const result = await send({ type: "line", line }, (m) => m.type === "complete");
  const output = messages
    .slice(at)
    .filter((m) => m.type === "output")
    .map((m) => m.data)
    .join("");
  assert.equal(result.exitCode, expected, `${line}\n${output}`);
  return output;
}
let created = false;
try {
  await waitFor((m) => m.type === "hello");
  await run(`mkdir '${root}'`);
  created = true;
  await run(
    `cd '${root}'; mkdir repo; cd repo; git init; git config user.name CapabilitySmoke; git config user.email smoke@example.invalid; printf 'first\n' > f; git add .; git commit -m first`,
  );
  assert.equal(await run("git status --porcelain"), "");
  const path = `${root}/repo/f`;
  const doc = await send({ type: "doc-open", path }, (m) => m.type === "doc" && m.path === path);
  const text = "edited through document overlay\n";
  await send(
    { type: "doc-edit", path, base: doc.version, text },
    (m) => m.type === "doc" && m.path === path && m.text === text,
  );
  assert.match(await run("git status --porcelain"), / M .*f/);
  assert.equal(await run("cat f"), text);
  socket.send(JSON.stringify({ type: "doc-close", path }));
  await run("git add .; git commit -m overlay");
  assert.equal(await run("git status --porcelain"), "");
  await run("cd ..; git clone repo clone");
  assert.equal(await run("cat clone/f"), text);
  await run("chmod 000 repo");
  await run("ls repo", 1);
  await run("chmod 755 repo");
} finally {
  if (created && socket.readyState === WebSocket.OPEN) {
    await run(`chmod 755 '${root}/repo' 2>/dev/null || true`);
    await run(`cd /home/demo; rm -rf '${root}'`);
  }
  socket.close();
  await writeFile(
    new URL("./public-smoke.json", import.meta.url),
    `${JSON.stringify({ at: new Date().toISOString(), root, messages }, null, 2)}\n`,
  );
}
console.log("Public Git, collaboration overlay, local clone and DAC smoke passed.");
