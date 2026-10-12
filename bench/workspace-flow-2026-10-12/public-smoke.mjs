import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import WebSocket from "ws";

const [output = "public-smoke.json"] = process.argv.slice(2);
const workspace = `/home/demo/.agent-perf-${randomUUID()}`;
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const task = `set -e
name=$(jq -r .name package.json)
jq -c '. + {version: "2.0.0"}' package.json > next.json
mv -f next.json package.json
sed 's/old/new/g' source.ts > next.ts
printf '%s:%s\\n' "$name" "$(grep -c new next.ts)"
jq -r .version package.json
printf '%s\\n' z é 𐀀  é | sort | uniq
`;
const gitTask = `set -e
mkdir -p repo/src/a repo/src/b
cd repo
git init > /dev/null
git config user.name PublicCheck
git config user.email public-check@example.invalid
printf 'before\\n' > src/a/file
printf 'other\\n' > src/b/file
git add .
git commit -m initial > /dev/null
sed 's/before/after/g' src/a/file > next
mv -f next src/a/file
git add .
git commit -m edited > /dev/null
test -z "$(git status --short)"
git clone . ../clone > /dev/null
test "$(git rev-parse HEAD)" = "$(git -C ../clone rev-parse HEAD)"
test "$(cat ../clone/src/a/file)" = after
printf 'git-workflow-ok\\n'
`;
const manifest = JSON.stringify({ name: "agent-demo", version: "1.0.0" });
const oracle = {
  rows: [
    {
      script: `set -e; mkdir -p ${quote(workspace)}; cd ${quote(workspace)}; printf '%s' ${quote(manifest)} > package.json; printf '%s' ${quote("old 한글\nold 😀\n")} > source.ts; printf '%s' ${quote(task)} > task.sh; bash task.sh; cat next.ts; ${gitTask}`,
      stdout: "agent-demo:2\n2.0.0\nz\né\n\n𐀀\nnew 한글\nnew 😀\ngit-workflow-ok\n",
      stderr: `Cloned local repository into '${workspace}/clone'.\n`,
      exitCode: 0,
    },
  ],
};
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
    assert.ok(matches, JSON.stringify(rows.at(-1)));
  }
} finally {
  if (socket.readyState === WebSocket.OPEN) {
    const done = waitFor("complete");
    socket.send(
      JSON.stringify({ type: "line", line: `cd /home/demo; rm -rf ${quote(workspace)}` }),
    );
    await done;
  }
  socket.close();
  await writeFile(
    new URL(output, import.meta.url),
    JSON.stringify({ at: new Date().toISOString(), rows }, null, 2),
  );
}
console.log(
  `Public agent workflows: ${rows.filter((row) => row.matches).length}/${rows.length} matched`,
);
