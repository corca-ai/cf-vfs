import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [before, after, output] = process.argv.slice(2);
const constructors = await Promise.all(
  [before, after].map(
    async (root) =>
      (await import(new URL("src/testing/node.js", pathToFileURL(root + "/")))).NodeSqlFileSystem,
  ),
);
const counts = {};
let checked = 0;
for (const initialSeed of [12345, 998877]) {
  let seed = initialSeed,
    time = 1700000000000;
  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed >>> 16) % n;
  };
  const engines = constructors.map((Fs) => {
    let ids = 0;
    return new Fs({
      now: () => time,
      createId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    });
  });
  try {
    for (const fs of engines) {
      fs.mkdir("/w");
      fs.setMetadata("/w", { mode: 0o40777 });
      for (let d = 0; d < 8; d++) {
        fs.mkdir(`/w/d${d}`);
        fs.setMetadata(`/w/d${d}`, { mode: 0o40777 });
        for (let f = 0; f < 4; f++) {
          await fs.writeFile(`/w/d${d}/f${f}`, "initial");
          fs.setMetadata(`/w/d${d}/f${f}`, { mode: 0o100666 });
        }
      }
    }
    for (let step = 0; step < 2000; step++) {
      time++;
      const directory = `/w/d${random(8)}`,
        path = directory + `/f${random(4)}`,
        other = `/w/d${random(8)}/f${random(4)}`,
        uid = [0, 1000, 2000][random(3)],
        operation = random(13),
        parents = random(2) === 1,
        body = `body-${initialSeed}-${step}`,
        mode = [0o777, 0o700, 0o555, 0][random(4)];
      const results = [];
      for (const fs of engines) {
        const view = fs.forCredentials({ uid, gid: uid });
        try {
          view.stat(directory);
        } catch {}
        try {
          let result;
          switch (operation) {
            case 0:
              result = await view.writeFile(path, body, { createParents: parents });
              break;
            case 1:
              result = await view.writeFiles(
                [
                  { path, body },
                  { path: other, body: new TextEncoder().encode(body) },
                ],
                { createParents: parents },
              );
              break;
            case 2:
              result = await view.appendFile(path, body);
              break;
            case 3:
              result = await view.remove(parents ? directory : path, { recursive: parents });
              break;
            case 4:
              result = view.mkdir(directory, parents);
              break;
            case 5:
              result = fs.setMetadata(parents ? directory : path, {
                mode: (parents ? 0o40000 : 0o100000) | mode,
              });
              break;
            case 6:
              result = fs.setOwnership(parents ? directory : path, { uid, gid: uid });
              break;
            case 7:
              result = view.symlink(path, other);
              break;
            case 8:
              result = await view.move(path, other);
              break;
            case 9:
              result = await view.copy(path, other);
              break;
            case 10:
              result = view.getMutationToken(parents ? directory : path, { follow: parents });
              break;
            case 11:
              result = view.stat(parents ? directory : path);
              break;
            case 12: {
              const read = view.readFile(path);
              result = { stat: read.stat, body: await new Response(read.stream).text() };
              break;
            }
          }
          results.push({ result });
        } catch (error) {
          results.push({ error: { code: error.code, path: error.path, message: error.message } });
        }
      }
      assert.deepEqual(
        results[1],
        results[0],
        JSON.stringify({ initialSeed, step, operation, path, other, uid, parents }),
      );
      assert.deepEqual(
        engines[1].find({ path: "/w" }),
        engines[0].find({ path: "/w" }),
        `namespace ${initialSeed}:${step}`,
      );
      const key = `${operation}:${results[0].error?.code ?? "success"}`;
      counts[key] = (counts[key] ?? 0) + 1;
      checked++;
    }
  } finally {
    for (const fs of engines) fs.close();
  }
}
await writeFile(output, JSON.stringify({ seeds: [12345, 998877], checked, counts }, null, 2));
console.log({
  checked,
  successes: Object.entries(counts)
    .filter(([key]) => key.endsWith(":success"))
    .reduce((n, [, v]) => n + v, 0),
});
