import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { connect } from "../coding-durability-2026-10-10/protocol-client.mjs";

const root = `/home/demo/perf-3h-${Date.now()}`;
const client = connect(new URL("https://vfs.borca.ai"));
const checks = [];
try {
  await client.wait((message) => message.type === "hello");
  await client.run(
    `git init ${root}/repo; git -C ${root}/repo config user.name Perf; git -C ${root}/repo config user.email perf@example.invalid; printf original > ${root}/repo/a; git -C ${root}/repo add -A; git -C ${root}/repo commit -m first`,
  );
  await client.run(`git clone ${root}/repo ${root}/clone`);
  assert.equal(await client.run(`cat ${root}/clone/a`), "original");
  checks.push("local clone bytes");
  await client.run(`mkdir ${root}/private; printf secret > ${root}/private/a`);
  assert.equal(await client.run(`cat ${root}/private/a`), "secret");
  await client.run(`chmod 000 ${root}/private`);
  assert.equal(
    await client.run(`if cat ${root}/private/a; then printf UNSAFE; else printf DENIED; fi`),
    "DENIED",
  );
  await client.run(`chmod 700 ${root}/private`);
  assert.equal(await client.run(`cat ${root}/private/a`), "secret");
  checks.push("warm read -> chmod denial -> restored read");
  assert.equal(await client.run(`git -C ${root}/clone status --porcelain`), "");
  checks.push("clean clone status");
  await client.run(
    `printf changed > ${root}/repo/a; git -C ${root}/repo add -A; git -C ${root}/repo commit -m second; git -C ${root}/clone pull`,
  );
  assert.equal(await client.run(`cat ${root}/clone/a`), "changed");
  checks.push("local pull bytes");
  await writeFile(
    process.argv[2],
    JSON.stringify({ at: new Date().toISOString(), url: "https://vfs.borca.ai", checks }, null, 2) +
      "\n",
  );
  console.log(JSON.stringify(checks));
} finally {
  try {
    await client.run(`chmod 700 ${root}/private; rm -rf ${root}`);
  } finally {
    client.socket.close();
  }
}
