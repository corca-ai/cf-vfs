import process from "node:process";
import { createInterface } from "node:readline";
import { InteractiveInputBuffer } from "../dist/shell/interactive.js";

export async function runRepl(backend, banner) {
  const input = new InteractiveInputBuffer();
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
    historySize: 1_000,
  });
  let running = false;

  function prompt() {
    if (readline.terminal) {
      readline.setPrompt(input.hasPendingSource ? "> " : `cf-vfs:${backend.cwd}$ `);
      readline.prompt();
    }
  }

  readline.on("SIGINT", () => {
    if (running) {
      void Promise.resolve(backend.cancel()).catch(() => undefined);
    } else {
      input.clear();
    }
    process.stdout.write("^C\n");
    if (!running) prompt();
  });

  if (readline.terminal) process.stdout.write(`${banner}; Ctrl-D or exit to quit\n`);
  prompt();

  for await (const line of readline) {
    const submitted = input.push(line);
    if (submitted.status === "incomplete") {
      prompt();
      continue;
    }
    running = true;
    let result;
    try {
      result = await backend.run(submitted.source);
    } finally {
      running = false;
    }
    if (backend.isClosed) {
      process.exitCode = result.exitCode;
      break;
    }
    prompt();
  }

  readline.close();
  if (!backend.isClosed) process.exitCode = backend.lastExitCode;
}
