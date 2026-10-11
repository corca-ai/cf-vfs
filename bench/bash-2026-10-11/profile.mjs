import { pathToFileURL } from "node:url";

const root = pathToFileURL(`${process.argv[2]}/`);
const { Shell } = await import(new URL("src/shell/shell.js", root));
const { NodeSqlFileSystem } = await import(new URL("src/testing/node.js", root));
const { defaultShellCommands } = await import(new URL("src/shell/commands/default.js", root));
const fs = new NodeSqlFileSystem();
const shell = new Shell({ fileSystem: fs, commands: defaultShellCommands });
const script = `for i in {1..150}; do : ${"x".repeat(4096)}; done; printf done`;
try {
  for (let i = 0; i < 150; i++) {
    const result = await shell.executeText({ script });
    if (result.stdout !== "done" || result.exitCode) throw Error("profile output failed");
  }
} finally {
  fs.close();
}
