import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Usage: node grep-bench.mjs ROOT, where ROOT is a built checkout (dist/).

const root = process.argv[2];
const { NodeSqlFileSystem } = await import(`${root}/dist/testing/node.js`);
const { Shell } = await import(`${root}/dist/shell/shell.js`);
const { defaultShellCommands } = await import(`${root}/dist/shell/commands/default.js`);
const files = JSON.parse(
  gunzipSync(readFileSync(new URL("./s3-files.json.gz", import.meta.url))).toString(),
);
const fs = new NodeSqlFileSystem();
for (const [path, content] of Object.entries(files))
  await fs.writeFile(`/w/${path}`, content, { createParents: true });
const shell = new Shell({
  fileSystem: fs,
  commands: defaultShellCommands,
  limits: { maxTotalIoBytes: 1 << 30 },
});
const scripts = {
  fixed: "grep -rc owner /w | wc -l",
  regex: "grep -rhoE '\\[\\[[^]]*\\]\\]' /w | wc -l",
  bre: "grep -rh 'see here' /w | wc -l",
  cat: "cat $(find /w -type f) | wc -c",
};
for (const [name, script] of Object.entries(scripts)) {
  const times = [];
  let out = "";
  for (let i = 0; i < 5; i += 1) {
    const t = performance.now();
    const r = await shell.executeText({ script });
    times.push(performance.now() - t);
    out = r.stdout.trim() + (r.stderr ? ` ERR ${r.stderr}` : "");
  }
  times.sort((a, b) => a - b);
  console.log(name, out, "median ms", times[2].toFixed(0), "min", times[0].toFixed(0));
}
