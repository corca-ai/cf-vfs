import { once } from "node:events";
import process from "node:process";
import { defaultShellCommands } from "../dist/shell/commands/default.js";
import { InteractiveShell } from "../dist/shell/interactive.js";
import { MemoryFileSystem } from "../dist/vfs/memory.js";
import { runRepl } from "./repl-ui.mjs";

const shell = new InteractiveShell({
  fileSystem: new MemoryFileSystem(),
  commands: defaultShellCommands,
  env: { HOME: "/" },
});
let currentExecution;

async function writeOutput(stream, output) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!output.write(value)) await once(output, "drain");
    }
  } finally {
    reader.releaseLock();
  }
}

await runRepl({
  get cwd() {
    return shell.cwd;
  },
  get isClosed() {
    return shell.isClosed;
  },
  get lastExitCode() {
    return shell.lastExitCode;
  },
  async run(source) {
    const execution = shell.runStream({ script: source });
    currentExecution = execution;
    try {
      const [, , result] = await Promise.all([
        writeOutput(execution.stdout, process.stdout),
        writeOutput(execution.stderr, process.stderr),
        execution.completed,
      ]);
      return result;
    } finally {
      currentExecution = undefined;
    }
  },
  cancel() {
    currentExecution?.cancel();
  },
}, "cf-vfs interactive shell (memory backend)");
