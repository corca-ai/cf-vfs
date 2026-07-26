import { VfsError } from "../src/core/errors.js";
import { curlCommand } from "../src/shell/commands/curl.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { InteractiveInputBuffer, InteractiveShell } from "../src/shell/interactive.js";
import {
  LINUX_SHELL_OPTIONS,
  linuxShellEnvironment,
  provisionLinuxFilesystem,
} from "../src/shell/linux.js";
import type { ShellExecution } from "../src/shell/types.js";
import { VfsDurableObject } from "../src/vfs/durable-object.js";
import { demoNetwork } from "./network.js";
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage } from "./protocol.js";

interface TerminalSession {
  readonly shell: InteractiveShell;
  readonly input: InteractiveInputBuffer;
  pendingSourceBytes: number;
  execution: ShellExecution | undefined;
}

const DEMO_USER = "demo";
const DEMO_HOME = `/home/${DEMO_USER}`;
const MAX_PENDING_SOURCE_BYTES = 128 * 1024;
/**
 * How many candidates one completion answer carries.
 *
 * A cap the client can see in the hello message, so it can say "and more"
 * rather than presenting a truncated list as the whole answer.
 */
const MAX_COMPLETION_CANDIDATES = 48;
/**
 * Which workspace a request lands in: one per country.
 *
 * A workspace per visitor is unbounded — every browser that ever loads the page
 * leaves a Durable Object behind, and nothing here deletes one. Keying on the
 * country Cloudflare already resolved bounds the set to a couple of hundred and
 * makes the demo a shared room, which the page says outright rather than
 * leaving to be discovered.
 */
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;

function workspaceFor(request: Request): string {
  const country = (request as { cf?: { country?: string } }).cf?.country;
  const upper = typeof country === "string" ? country.toUpperCase() : "";
  // `T1` is Tor and local development has none at all; both share one room.
  return `country-${COUNTRY_PATTERN.test(upper) ? upper : "XX"}`;
}

const SHELL_LIMITS = {
  maxScriptBytes: MAX_PENDING_SOURCE_BYTES,
  maxTotalSourceBytes: MAX_PENDING_SOURCE_BYTES,
  maxAstNodes: 2_048,
  maxNestingDepth: 48,
  maxCommands: 1_000,
  maxSteps: 20_000,
  maxLoopIterations: 1_000,
  maxFunctionDepth: 32,
  maxSourceDepth: 8,
  maxCommandSubstitutionBytes: 256 * 1024,
  maxPipelineBytes: 1024 * 1024,
  maxStdoutBytes: 512 * 1024,
  maxStderrBytes: 512 * 1024,
  maxMaterializedOutputBytes: 1024 * 1024,
  maxTotalIoBytes: 4 * 1024 * 1024,
  maxBufferedBytes: 2 * 1024 * 1024,
  maxLineBytes: 256 * 1024,
  maxBufferedRecords: 10_000,
  maxGlobMatches: 2_000,
  maxExpansionWork: 1_000_000,
  maxExpansionChars: 256 * 1024,
  maxExpansionFields: 2_000,
  maxMutations: 500,
  deadlineMs: 10_000,
  outputIdleTimeoutMs: 5_000,
} as const;

const WELCOME_FILE = `cf-vfs interactive demo
=======================

This workspace is backed by a Cloudflare Durable Object and SQLite.
Files survive WebSocket reconnects and browser reloads.

Try:
  printf 'hello from cf-vfs\\n' > hello.txt
  cat hello.txt
  mkdir -p notes/2026
  printf 'persistent\\n' > notes/2026/demo.txt
  tree .
  find . -type f -print

The namespace is laid out the Linux way: /etc, /home, /tmp, /var, /workspace,
and a virtual /dev. Commands resolve through PATH, so \`which cat\` answers
/bin/cat and /bin/echo runs.

  ls /
  echo "$PATH"
  which grep
  /bin/echo absolute paths work too

/bin and /usr/bin resolve commands without being directories: nothing is
stored there, so \`ls /bin\` reports no such file. Everything else under / is
an ordinary directory you can write to.

This is the bounded Bash-compatible cf-vfs runtime, not an operating-system
shell. It cannot launch processes or access the host filesystem.
`;

function socketIsOpen(socket: WebSocket): boolean {
  return socket.readyState === WebSocket.OPEN;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socketIsOpen(socket)) socket.send(JSON.stringify(message));
}

function prompt(socket: WebSocket, session: TerminalSession, continuation = false): void {
  send(socket, {
    type: "prompt",
    cwd: session.shell.cwd,
    continuation,
    exitCode: session.shell.lastExitCode,
  });
}

async function pumpOutput(
  socket: WebSocket,
  stream: ReadableStream<Uint8Array>,
  channel: "stdout" | "stderr",
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const data = decoder.decode(result.value, { stream: true });
      if (data.length > 0) send(socket, { type: "output", stream: channel, data });
    }
    const finalData = decoder.decode();
    if (finalData.length > 0) {
      send(socket, { type: "output", stream: channel, data: finalData });
    }
  } finally {
    reader.releaseLock();
  }
}

export function handleTerminalRequest(
  request: Request,
  env: VfsBenchmarkEnv,
): Response | Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const origin = request.headers.get("Origin");
  if (origin === null) return new Response("Missing Origin", { status: 403 });
  try {
    if (new URL(origin).origin !== url.origin) {
      return new Response("Origin not allowed", { status: 403 });
    }
  } catch {
    return new Response("Invalid Origin", { status: 403 });
  }

  return env.DEMO_WORKSPACES.getByName(workspaceFor(request)).fetch(request);
}

export class DemoWorkspace extends VfsDurableObject<VfsBenchmarkEnv> {
  private readonly sessions = new Map<WebSocket, TerminalSession>();
  /** The room this object is, so a session can say which one it joined. */
  private readonly workspaceName: string;

  constructor(ctx: DurableObjectState, env: VfsBenchmarkEnv) {
    super(ctx, env, {
      workspaceId: ctx.id.toString(),
      // A room shared by a whole country, so it is deliberately small: a
      // visitor who fills it can only have written fifty kilobytes, and
      // whoever arrives next can free it by deleting something. The welcome
      // file and the profile's directories account for well under a kilobyte
      // of that.
      maxInlineFileBytes: 16 * 1024,
      maxInlineLogicalBytes: 50 * 1024,
      maxEntries: 256,
      maxInFlightBufferedBytes: 2 * 1024 * 1024,
    });
    // `getByName` keeps the name on the identifier, which is the room's label.
    this.workspaceName = ctx.id.name ?? "country-XX";
    ctx.blockConcurrencyWhile(async () => {
      // The Linux profile's directories, created once per workspace. `/bin` and
      // `/usr/bin` are deliberately not among them: they resolve applets
      // without a namespace entry, so a row there would be a directory that
      // could be removed while `/bin/cat` kept working.
      provisionLinuxFilesystem(this.fileSystem, { user: DEMO_USER });
      try {
        this.fileSystem.stat(`${DEMO_HOME}/README.txt`);
      } catch (error) {
        if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
        await this.fileSystem.writeFile(`${DEMO_HOME}/README.txt`, WELCOME_FILE);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const session: TerminalSession = {
      shell: new InteractiveShell({
        fileSystem: this.fileSystem,
        commands: [...defaultShellCommands, curlCommand],
        // PATH lookup and the profile's environment are one decision, not two:
        // without `commandResolution` a `PATH` is an ordinary variable and
        // every applet answers to its bare name regardless of it.
        ...LINUX_SHELL_OPTIONS,
        cwd: DEMO_HOME,
        env: {
          ...linuxShellEnvironment({ user: DEMO_USER }),
          // Not part of the profile: it describes the client, not the runtime,
          // and nothing here claims a terminal.
          TERM: "xterm-256color",
        },
        limits: SHELL_LIMITS,
        network: demoNetwork(),
        policy: { maxMutations: SHELL_LIMITS.maxMutations, network: "allow" },
      }),
      input: new InteractiveInputBuffer({
        limits: {
          maxAstNodes: SHELL_LIMITS.maxAstNodes,
          maxNestingDepth: SHELL_LIMITS.maxNestingDepth,
        },
      }),
      pendingSourceBytes: 0,
      execution: undefined,
    };
    this.sessions.set(server, session);

    server.addEventListener("message", (event) => {
      void this.handleMessage(server, event.data).catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "terminal WebSocket message failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        send(server, {
          type: "error",
          message: error instanceof VfsError ? error.message : "Terminal request failed",
        });
        const current = this.sessions.get(server);
        if (current !== undefined && current.execution === undefined) {
          prompt(server, current);
        }
      });
    });
    server.addEventListener("close", () => this.removeSession(server));
    server.addEventListener("error", () => this.removeSession(server));

    send(server, {
      type: "hello",
      cwd: session.shell.cwd,
      protocol: 1,
      features: ["completion", "resize-hint", "sigint", "continuation"],
      limits: {
        maxMessageBytes: MAX_MESSAGE_BYTES,
        maxSourceBytes: MAX_PENDING_SOURCE_BYTES,
        maxCompletionCandidates: MAX_COMPLETION_CANDIDATES,
      },
      durability: { files: "durable", session: "connection" },
      workspace: this.workspaceName,
    });
    prompt(server, session);
    return new Response(null, { status: 101, webSocket: client });
  }

  private removeSession(socket: WebSocket): void {
    const session = this.sessions.get(socket);
    session?.execution?.cancel();
    this.sessions.delete(socket);
  }

  private async handleMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(socket);
    if (session === undefined) return;
    const message = parseClientMessage(rawMessage);

    if (message.type === "ping") {
      send(socket, { type: "pong" });
      return;
    }
    if (message.type === "signal") {
      if (session.execution !== undefined) {
        session.execution.cancel();
      } else {
        session.input.clear();
        session.pendingSourceBytes = 0;
        prompt(socket, session);
      }
      return;
    }
    if (message.type === "resize") {
      // A presentation hint and nothing more. It is published as `COLUMNS` and
      // `LINES` because that is the only form a shell script can read, and
      // publishing nothing would leave a message whose comment described an
      // effect it did not have. No terminal mode or ioctl is implied.
      const columns = Math.max(1, Math.min(1000, message.columns));
      const rows = Math.max(1, Math.min(1000, message.rows));
      session.shell.setEnv("COLUMNS", String(columns));
      session.shell.setEnv("LINES", String(rows));
      return;
    }
    if (message.type === "complete") {
      // Answered even while a command runs: completion reads the session and
      // does not touch the execution, and a user typing the next line should
      // not have to wait for the current one.
      const result = session.shell.complete(message.line, message.cursor, {
        maxCandidates: MAX_COMPLETION_CANDIDATES,
      });
      send(socket, {
        type: "candidates",
        token: message.token,
        start: result.start,
        end: result.end,
        commonPrefix: result.commonPrefix,
        truncated: result.truncated,
        values: result.candidates.map((candidate: { value: string; kind: string }) => ({
          value: candidate.value,
          kind: candidate.kind,
        })),
      });
      return;
    }
    if (session.execution !== undefined) {
      send(socket, { type: "error", message: "A command is already running" });
      return;
    }

    session.pendingSourceBytes += new TextEncoder().encode(`${message.line}\n`).byteLength;
    if (session.pendingSourceBytes > MAX_PENDING_SOURCE_BYTES) {
      session.input.clear();
      session.pendingSourceBytes = 0;
      throw new VfsError("E2BIG", "pending shell source is too large");
    }

    const submitted = session.input.push(message.line);
    if (submitted.status === "incomplete") {
      prompt(socket, session, true);
      return;
    }
    session.pendingSourceBytes = 0;
    await this.execute(socket, session, submitted.source);
  }

  private async execute(
    socket: WebSocket,
    session: TerminalSession,
    source: string,
  ): Promise<void> {
    send(socket, { type: "running" });
    const execution = session.shell.runStream({ script: source });
    session.execution = execution;
    try {
      const [result] = await Promise.all([
        execution.completed,
        pumpOutput(socket, execution.stdout, "stdout"),
        pumpOutput(socket, execution.stderr, "stderr"),
      ]);
      send(socket, {
        type: "complete",
        cwd: session.shell.cwd,
        exitCode: result.exitCode,
      });
      if (session.shell.isClosed) {
        send(socket, { type: "closed", exitCode: result.exitCode });
        if (socketIsOpen(socket)) socket.close(1000, "shell session closed");
        return;
      }
      prompt(socket, session);
    } finally {
      session.execution = undefined;
    }
  }
}
