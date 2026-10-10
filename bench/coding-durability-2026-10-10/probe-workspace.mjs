import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "./protocol-client.mjs";

const base = new URL(process.env.CF_VFS_PROBE_URL ?? "https://vfs.borca.ai");
const root = `/home/demo/queue-recovery-${Date.now()}`;
const a = connect(base),
  b = connect(base),
  admin = connect(base),
  clients = [a, b, admin];
const checks = [];
try {
  await Promise.all(clients.map((client) => client.wait((message) => message.type === "prompt")));
  assert.equal(
    new Set(
      clients.map(
        (client) => client.messages.find((message) => message.type === "hello").workspace,
      ),
    ).size,
    1,
  );
  await admin.run(`mkdir ${root}; printf seed > ${root}/f`);
  let started = a.messages.length;
  let held = a.run(`sleep 1; cat ${root}/f`);
  await a.wait((message) => message.type === "running", started);
  const writer = b.run(`printf later > ${root}/f`);
  assert.equal(await held, "seed");
  await writer;
  assert.equal(await admin.run(`cat ${root}/f`), "later");
  checks.push("Two shells run in order; the earlier command reads stable bytes");
  for (const client of [a, b]) {
    const start = client.messages.length;
    client.send({ type: "doc-open", path: `${root}/f` });
    await client.wait((message) => message.type === "doc", start);
  }
  const version = b.messages.filter((message) => message.type === "doc").at(-1).version;
  started = a.messages.length;
  held = a.run(`sleep 1; cat ${root}/f`);
  await a.wait((message) => message.type === "running", started);
  const editStart = b.messages.length;
  b.send({ type: "doc-edit", path: `${root}/f`, base: version, text: "editor" });
  assert.equal(await held, "later");
  await b.wait((message) => message.type === "doc" && message.text === "editor", editStart);
  assert.equal(await admin.run(`cat ${root}/f`), "editor");
  checks.push("Editor change waits for the command and is flushed before the next command");
  const staleBase = b.messages.filter((message) => message.type === "doc").at(-1).version;
  started = a.messages.length;
  held = a.run(`sleep 1; printf shell > ${root}/f`);
  await a.wait((message) => message.type === "running", started);
  b.send({ type: "doc-edit", path: `${root}/f`, base: staleBase, text: "stale" });
  await held;
  assert.equal(await admin.run(`cat ${root}/f`), "shell");
  checks.push("Queued editor update based on pre-command version is refused");
  started = a.messages.length;
  held = a.run("sleep 5");
  await a.wait((message) => message.type === "running", started);
  let queuedStart = b.messages.length;
  b.send({ type: "line", line: `printf bad > ${root}/cancelled` });
  await b.wait((message) => message.type === "running", queuedStart);
  b.send({ type: "signal", signal: "SIGINT" });
  await b.wait((message) => message.type === "prompt", queuedStart);
  await held;
  await admin.run(`test -e ${root}/cancelled; test $? -eq 1`);
  assert.equal(await b.run("printf resumed"), "resumed");
  checks.push("Cancelling a queued shell drops its mutation and leaves the session usable");
  started = a.messages.length;
  a.send({ type: "line", line: "sleep 5" });
  await a.wait((message) => message.type === "running", started);
  await delay(100);
  a.send({ type: "signal", signal: "SIGINT" });
  const cancelled = await a.wait(
    (message) => message.type === "complete" || message.type === "error",
    started,
  );
  if (cancelled.type === "complete") assert.notEqual(cancelled.exitCode, 0);
  else assert.match(cancelled.message, /cancel/iu);
  await a.wait((message) => message.type === "prompt", started);
  assert.equal(await b.run("printf released"), "released");
  checks.push("Cancelling an active command releases the room queue");
  const disconnected = connect(base);
  clients.push(disconnected);
  await disconnected.wait((message) => message.type === "prompt");
  started = a.messages.length;
  held = a.run("sleep 5");
  await a.wait((message) => message.type === "running", started);
  queuedStart = disconnected.messages.length;
  disconnected.send({ type: "line", line: `printf bad > ${root}/disconnected` });
  await disconnected.wait((message) => message.type === "running", queuedStart);
  disconnected.socket.close();
  await held;
  await admin.run(`test -e ${root}/disconnected; test $? -eq 1`);
  checks.push("Disconnecting a queued caller prevents its mutation");
  await admin.run(
    `git init ${root}/repo; git -C ${root}/repo config user.name Smoke; git -C ${root}/repo config user.email smoke@example.invalid; printf committed > ${root}/repo/a; git -C ${root}/repo add a; git -C ${root}/repo commit -m initial; printf dirty > ${root}/repo/a; printf keep > ${root}/repo/untracked`,
  );
  await admin.run(`git -C ${root}/repo checkout main; test $? -ne 0`);
  await admin.run(`git -C ${root}/repo checkout --force main`);
  assert.equal(await admin.run(`cat ${root}/repo/a`), "committed");
  assert.equal(await admin.run(`cat ${root}/repo/untracked`), "keep");
  checks.push(
    "Public Git force checkout repairs tracked bytes and keeps unrelated untracked content",
  );
} finally {
  for (const client of [a, b]) client.send({ type: "doc-close", path: `${root}/f` });
  try {
    await admin.run(`rm -rf ${root}`);
  } finally {
    for (const client of clients) client.socket.close();
  }
}
const result = { url: base.origin, root, checks };
await writeFile(
  new URL(`workspace-${base.hostname === "vfs.borca.ai" ? "cf" : "local"}.json`, import.meta.url),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result));
