import { VfsError } from "../src/core/errors.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { InteractiveInputBuffer, InteractiveShell } from "../src/shell/interactive.js";
import type { ShellExecution } from "../src/shell/types.js";
import { VfsDurableObject } from "../src/vfs/durable-object.js";

const MAX_PENDING_SOURCE_BYTES = 128 * 1024;
const MAX_MESSAGE_BYTES = MAX_PENDING_SOURCE_BYTES + 1024;
const WORKSPACE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

This is the bounded Bash-compatible cf-vfs runtime, not an operating-system
shell. It cannot launch processes or access the host filesystem.
`;

type ClientMessage =
  | { readonly type: "line"; readonly line: string }
  | { readonly type: "signal"; readonly signal: "SIGINT" }
  | { readonly type: "ping" };

type ServerMessage =
  | { readonly type: "hello"; readonly cwd: string }
  | {
      readonly type: "output";
      readonly stream: "stdout" | "stderr";
      readonly data: string;
    }
  | {
      readonly type: "prompt";
      readonly cwd: string;
      readonly continuation: boolean;
      readonly exitCode: number;
    }
  | { readonly type: "running" }
  | { readonly type: "complete"; readonly cwd: string; readonly exitCode: number }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly exitCode: number }
  | { readonly type: "pong" };

interface TerminalSession {
  readonly shell: InteractiveShell;
  readonly input: InteractiveInputBuffer;
  pendingSourceBytes: number;
  execution: ShellExecution | undefined;
}

function parseClientMessage(message: string | ArrayBuffer): ClientMessage {
  if (typeof message !== "string") {
    throw new VfsError("EINVAL", "binary WebSocket messages are not supported");
  }
  if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
    throw new VfsError("E2BIG", "WebSocket message is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new VfsError("EINVAL", "WebSocket message must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VfsError("EINVAL", "WebSocket message must be an object");
  }

  const input = value as Readonly<Record<string, unknown>>;
  if (input["type"] === "ping") return { type: "ping" };
  if (input["type"] === "signal" && input["signal"] === "SIGINT") {
    return { type: "signal", signal: "SIGINT" };
  }
  if (input["type"] === "line" && typeof input["line"] === "string") {
    return { type: "line", line: input["line"] };
  }
  throw new VfsError("EINVAL", "unsupported WebSocket message");
}

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

  const workspaceId = url.searchParams.get("workspace");
  if (workspaceId === null || !WORKSPACE_PATTERN.test(workspaceId)) {
    return new Response("Invalid workspace", { status: 400 });
  }
  return env.DEMO_WORKSPACES.getByName(workspaceId).fetch(request);
}

export class DemoWorkspace extends VfsDurableObject<VfsBenchmarkEnv> {
  private readonly sessions = new Map<WebSocket, TerminalSession>();

  constructor(ctx: DurableObjectState, env: VfsBenchmarkEnv) {
    super(ctx, env, {
      workspaceId: ctx.id.toString(),
      maxInlineFileBytes: 1024 * 1024,
      maxInlineLogicalBytes: 8 * 1024 * 1024,
      maxEntries: 2_048,
      maxInFlightBufferedBytes: 2 * 1024 * 1024,
    });
    ctx.blockConcurrencyWhile(async () => {
      this.fileSystem.mkdir("/home/demo", true);
      this.fileSystem.mkdir("/tmp", true);
      try {
        this.fileSystem.stat("/home/demo/README.txt");
      } catch (error) {
        if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
        await this.fileSystem.writeFile("/home/demo/README.txt", WELCOME_FILE);
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
        commands: defaultShellCommands,
        cwd: "/home/demo",
        env: {
          HOME: "/home/demo",
          TMPDIR: "/tmp",
          TERM: "xterm-256color",
        },
        limits: SHELL_LIMITS,
        policy: { maxMutations: SHELL_LIMITS.maxMutations },
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

    send(server, { type: "hello", cwd: session.shell.cwd });
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
