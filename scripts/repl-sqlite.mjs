import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runRepl } from "./repl-ui.mjs";

async function availablePort() {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("could not allocate a local port");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

async function waitUntilReady(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited before startup\n${logs.value}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The local listener is not ready yet.
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for wrangler dev\n${logs.value}`);
}

const repository = fileURLToPath(new URL("..", import.meta.url));
const stateDirectory = await mkdtemp(join(tmpdir(), "cf-vfs-repl-sqlite-"));
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const wrangler = process.platform === "win32"
  ? fileURLToPath(new URL("../node_modules/.bin/wrangler.cmd", import.meta.url))
  : fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));
const logs = { value: "" };
const child = spawn(
  wrangler,
  [
    "dev",
    "--config",
    "wrangler.repl.jsonc",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    stateDirectory,
    "--show-interactive-dev-session=false",
    "--log-level",
    "error",
  ],
  {
    cwd: repository,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
for (const output of [child.stdout, child.stderr]) {
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    logs.value = `${logs.value}${chunk}`.slice(-16_384);
  });
}

let cwd = "/";
let lastExitCode = 0;
let isClosed = false;

try {
  await waitUntilReady(baseUrl, child, logs);
  await runRepl({
    get cwd() {
      return cwd;
    },
    get isClosed() {
      return isClosed;
    },
    get lastExitCode() {
      return lastExitCode;
    },
    async run(source) {
      const response = await fetch(`${baseUrl}/execute`, {
        method: "POST",
        body: source,
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      cwd = result.cwd;
      lastExitCode = result.exitCode;
      isClosed = result.isClosed;
      return result;
    },
    async cancel() {
      await fetch(`${baseUrl}/cancel`, { method: "POST" });
    },
  }, "cf-vfs interactive shell (ephemeral workerd SQLite backend)");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(5_000)]);
  }
  await rm(stateDirectory, { recursive: true, force: true });
}
