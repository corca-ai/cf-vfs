import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { connect } from "./protocol-client.mjs";

const expected = process.argv[2] ?? "after";
const base = new URL(process.env.CF_VFS_PROBE_URL ?? "https://vfs.borca.ai");
const path = `/home/demo/editor-queue-probe-${Date.now()}`;
const a = connect(base),
  b = connect(base),
  admin = connect(base);
const clients = [a, b, admin];
let observations;
try {
  await Promise.all(clients.map((client) => client.wait((message) => message.type === "prompt")));
  const rooms = clients.map(
    (client) => client.messages.find((message) => message.type === "hello").workspace,
  );
  assert.equal(new Set(rooms).size, 1);
  await admin.run(`printf seed > ${path}`);
  for (const client of [a, b]) {
    client.send({ type: "doc-open", path });
    await client.wait((message) => message.type === "doc" && message.path === path);
  }
  const firstStartA = a.messages.length,
    firstStartB = b.messages.length;
  a.send({ type: "doc-edit", path, base: 0, text: "first" });
  await delay(1000);
  const firstAck = a.messages
    .slice(firstStartA)
    .find((message) => message.type === "doc" && message.path === path);
  const firstBroadcast = b.messages
    .slice(firstStartB)
    .find((message) => message.type === "doc" && message.path === path);
  const secondStart = a.messages.length;
  a.send({ type: "doc-edit", path, base: firstAck?.version ?? 0, text: "second" });
  await delay(1000);
  const secondAck = a.messages
    .slice(secondStart)
    .find((message) => message.type === "doc" && message.path === path);
  observations = {
    url: base.origin,
    expected,
    rooms,
    path,
    firstAck: firstAck ?? null,
    firstBroadcast: firstBroadcast ?? null,
    secondAck: secondAck ?? null,
  };
  if (expected === "before") {
    assert.equal(firstAck, undefined);
    assert.equal(firstBroadcast, undefined);
    assert.equal(secondAck.text, "first");
  } else {
    assert.equal(firstAck.text, "first");
    assert.equal(firstBroadcast.text, "first");
    assert.equal(secondAck.text, "second");
  }
} finally {
  for (const client of [a, b])
    if (client.socket.readyState === WebSocket.OPEN) client.send({ type: "doc-close", path });
  try {
    await admin.run(`rm -f ${path}`);
  } finally {
    for (const client of clients) client.socket.close();
  }
}
await writeFile(
  new URL(
    `editor-${base.hostname === "vfs.borca.ai" ? "cf" : "local"}-${expected}.json`,
    import.meta.url,
  ),
  `${JSON.stringify(observations, null, 2)}\n`,
);
console.log(JSON.stringify(observations));
