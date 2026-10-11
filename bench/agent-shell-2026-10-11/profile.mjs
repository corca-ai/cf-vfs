import { writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { files, scenarios } from "./scenarios.ts";

const base = pathToFileURL(`${resolve(process.argv[2])}/src/`);
const { Shell } = await import(new URL("shell/shell.js", base));
const { NodeSqlFileSystem } = await import(new URL("testing/node.js", base));
const { defaultShellCommands } = await import(new URL("shell/commands/default.js", base));
const fs = new NodeSqlFileSystem();
for (const [path, body] of Object.entries(files)) await fs.writeFile(path, body);
const shell = new Shell({ fileSystem: fs, commands: defaultShellCommands });
const profiler = new Session();
profiler.connect();
await profiler.post("Profiler.enable");
await profiler.post("Profiler.start");
for (let i = 0; i < 200; i++)
  for (const scenario of scenarios) {
    const result = await shell.executeText({ script: scenario.script });
    if (result.exitCode !== 0 || result.stdout !== scenario.stdout || result.stderr)
      throw new Error(JSON.stringify(result));
  }
const { profile } = await profiler.post("Profiler.stop");
await writeFile(process.argv[3], JSON.stringify(profile));
console.log(
  profile.nodes
    .filter((n) => n.hitCount)
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, 20)
    .map((n) => ({
      name: n.callFrame.functionName,
      file: n.callFrame.url.split("/").slice(-2).join("/"),
      samples: n.hitCount,
    })),
);
profiler.disconnect();
fs.close();
