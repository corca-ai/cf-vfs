// Counts what each calibration script charges, per budget class, on Node.
// Usage: node count.mjs FIXTURE.json scripts.json, after `npm run build`.
import { readFileSync } from "node:fs";

const dist = new URL("../../dist/", import.meta.url);
const { ExecutionBudget } = await import(new URL("shell/budget.js", dist).href);
const { Shell } = await import(new URL("shell/shell.js", dist).href);
const { defaultShellCommands } = await import(new URL("shell/commands/default.js", dist).href);
const { awkCommand } = await import(new URL("shell/commands/awk.js", dist).href);
const { NodeSqlFileSystem } = await import(new URL("testing/node.js", dist).href);
const counts = {};
const add = (k, n) => {
  counts[k] = (counts[k] ?? 0) + n;
};
const P = ExecutionBudget.prototype;
const wrap = (name, f) => {
  const o = P[name];
  P[name] = function (...a) {
    f(...a);
    return o.apply(this, a);
  };
};
wrap("step", (n = 1) => add("step", n));
wrap("command", () => add("command", 1));
wrap("loop", () => add("loop", 1));
wrap("io", (n) => add("io", n));
wrap("read", (n) => add("read", n));
wrap("expansionWork", (n = 1) => add("expansion", n));
const { files } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const fs = new NodeSqlFileSystem();
const entries = Object.entries(files);
for (let i = 0; i < entries.length; i += 200)
  await fs.writeFiles(
    entries.slice(i, i + 200).map(([p, body]) => ({ path: `/wiki/${p}`, body })),
    { createParents: true },
  );
const shell = new Shell({ fileSystem: fs, commands: [...defaultShellCommands, awkCommand] });
const scripts = JSON.parse(readFileSync(process.argv[3], "utf8"));
const out = {};
for (const [name, script] of Object.entries(scripts)) {
  for (const k of Object.keys(counts)) delete counts[k];
  const r = await shell.executeText({ cwd: "/", script });
  out[name] = { exit: r.exitCode, err: r.stderr.slice(0, 80), ...counts };
}
console.log(JSON.stringify(out, null, 1));
fs.close();
