import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import WebSocket from "ws";

const [output = "public-smoke.json", mode = "check"] = process.argv.slice(2);
const oracle = JSON.parse(await readFile(new URL("./oracle.json", import.meta.url), "utf8"));
const socket = new WebSocket("wss://vfs.borca.ai/ws", {
  headers: { Origin: "https://vfs.borca.ai" },
});
const waiters = new Set();
let chunks = [];
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "output") chunks.push(message);
  for (const waiter of waiters) waiter(message);
});
function waitFor(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(receive);
      reject(new Error("Shell timeout"));
    }, 60000);
    function receive(message) {
      if (message.type === type || message.type === "error") {
        clearTimeout(timer);
        waiters.delete(receive);
        if (message.type === "error") reject(new Error(message.message));
        else resolve(message);
      }
    }
    waiters.add(receive);
  });
}
const rows = [];
try {
  await waitFor("hello");
  for (const row of oracle.rows) {
    chunks = [];
    const done = waitFor("complete");
    socket.send(JSON.stringify({ type: "line", line: row.script }));
    const result = await done;
    const stdout = chunks
      .filter((m) => m.stream === "stdout")
      .map((m) => m.data)
      .join("");
    const stderr = chunks
      .filter((m) => m.stream === "stderr")
      .map((m) => m.data)
      .join("");
    const matches =
      result.exitCode === row.exitCode && stdout === row.stdout && stderr === row.stderr;
    rows.push({ script: row.script, stdout, stderr, exitCode: result.exitCode, matches });
    if (mode === "check") assert.ok(matches, JSON.stringify(rows.at(-1)));
  }
} finally {
  socket.close();
  await writeFile(
    new URL(output, import.meta.url),
    JSON.stringify({ at: new Date().toISOString(), rows }, null, 2),
  );
}
console.log(
  `Public Bash cases: ${rows.filter((row) => row.matches).length}/${rows.length} matched`,
);
