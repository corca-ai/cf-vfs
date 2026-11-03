import { meterSqlStorage, type SqlMeter } from "../bench/metered-sql.js";
import { CollaborativeFileSystem } from "../src/collab/index.js";
import { VfsError } from "../src/core/errors.js";
import { curlCommand } from "../src/shell/commands/curl.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { InteractiveInputBuffer, InteractiveShell } from "../src/shell/interactive.js";
import {
  LINUX_SHELL_OPTIONS,
  linuxShellEnvironment,
  provisionLinuxFilesystem,
} from "../src/shell/linux.js";
import type { ShellExecution } from "../src/shell/types.js";
import { VfsDurableObject } from "../src/vfs/durable-object.js";
import type { VfsStat } from "../src/vfs/types.js";
import { DEMO_BUDGET_NAME } from "./demo-budget.js";
import { DemoDocuments, type DocumentNotice } from "./document.js";
import {
  DEMO_CREDENTIALS,
  DEMO_IDENTITY_RESOLVER,
  DEMO_USER,
  ensureDemoOwnership,
  migrateDemoOwnership,
} from "./identity.js";
import { demoNetwork } from "./network.js";
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage } from "./protocol.js";
import { addressKey, COST, RoomBudget } from "./room-budget.js";
import { WorkspaceOperations } from "./workspace-operations.js";

interface TerminalSession {
  /** The visitor's address (an IPv6 /64), which budgets and session caps count by. */
  readonly address: string;
  /** Messages the session may still send before it is closed for flooding. */
  tokens: number;
  tokensAt: number;
  readonly shell: InteractiveShell;
  readonly input: InteractiveInputBuffer;
  /** Documents this socket has open, so a change reaches only who is looking. */
  readonly watching: Set<string>;
  pendingSourceBytes: number;
  execution: ShellExecution | undefined;
  pending: AbortController | undefined;
  /** Closes the session once nobody has typed for {@link IDLE_SESSION_MS}. */
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Closes the session at the end of {@link MAX_SESSION_MS}. */
  expiry: ReturnType<typeof setTimeout> | undefined;
}

const DEMO_HOME = `/home/${DEMO_USER}`;
const DEMO_IDENTITY_VERSION = 1;
const DEMO_IDENTITY_VERSION_KEY = "demo:identity-version";
const MAX_PENDING_SOURCE_BYTES = 128 * 1024;
/**
 * How long a session may go without input before it is closed. An open
 * socket keeps the room's Durable Object running, and the page's keepalive
 * would keep a forgotten tab open indefinitely; the page reconnects on the
 * next key instead. Files are durable and survive; the session is not.
 */
const IDLE_SESSION_MS = 10 * 60 * 1000;
/** However busy, a session ends after an hour; the page reconnects on the next key. */
const MAX_SESSION_MS = 60 * 60 * 1000;
/**
 * Close codes the page understands. It reconnects only on the visitor's next
 * key after any of them, never on its own, so none of them becomes a loop.
 */
const CLOSE = {
  idle: 4000,
  roomFull: 4001,
  tooManySessions: 4002,
  budget: 4003,
  expired: 4004,
} as const;
/** Sessions one room holds at once, and sessions one address may hold in it. */
const MAX_ROOM_SESSIONS = 32;
const MAX_ADDRESS_SESSIONS = 4;
/** Messages a session may send: a burst, refilled at a steady rate. */
const MESSAGE_BURST = 100;
const MESSAGES_PER_SECOND = 20;
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

/**
 * A fortieth of the default work (about a quarter second of CPU, what 0.5's
 * demo expansion limit allowed), an eighth of its memory, half its depth and
 * 500 changed entries' rows: a public room serves visitors who pay nothing.
 */
const SHELL_LIMITS = {
  deadlineMs: 10_000,
  maxWork: 250_000,
  maxMemoryBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxRowsWritten: 2_000,
} as const;

const WELCOME_FILE = `cf-vfs interactive demo
=======================

This workspace is backed by a Cloudflare Durable Object and SQLite.
Files survive WebSocket reconnects and browser reloads.

Try:
  id
  groups
  stat -c '%U:%G %a %n' .
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
  private readonly operations = new WorkspaceOperations();
  /** The room this object is, so a session can say which one it joined. */
  private readonly workspaceName: string;
  private readonly documents: DemoDocuments;
  /**
   * What the shells run against.
   *
   * A write to a file someone has open becomes an edit to their document
   * rather than a publication that would discard it, and a read of one sees
   * text that has not been written back yet.
   */
  private readonly editable: CollaborativeFileSystem;
  /** The room's share of the public demo's daily budget. */
  private readonly budget: RoomBudget;
  /** Rows the room's storage has read and written, to charge to the budget. */
  private readonly meter: SqlMeter;
  private charged = { rowsRead: 0, rowsWritten: 0, at: Date.now() };

  constructor(ctx: DurableObjectState, env: VfsBenchmarkEnv) {
    // Built before `super()` because the filesystem takes it as an event sink,
    // which is how a document follows a `mv` or an `rm` typed in the terminal.
    // Legal only because nothing here touches `this`.
    const documents = new DemoDocuments();
    // The filesystem's storage is metered, so what the room costs is counted
    // from the rows SQLite reports rather than estimated from commands.
    const meter = meterSqlStorage(ctx.storage);
    super(
      ctx,
      env,
      {
        workspaceId: ctx.id.toString(),
        onEvent: (event) => documents.observe(event),
        // A room shared by a whole country, so it is deliberately small: a
        // visitor who fills it can only have written fifty kilobytes, and
        // whoever arrives next can free it by deleting something. The welcome
        // file and the profile's directories account for well under a kilobyte
        // of that.
        maxInlineFileBytes: 16 * 1024,
        maxInlineLogicalBytes: 50 * 1024,
        maxEntries: 256,
        maxInFlightBufferedBytes: 2 * 1024 * 1024,
      },
      meter.storage,
    );
    // `getByName` keeps the name on the identifier, which is the room's label.
    this.workspaceName = ctx.id.name ?? "country-XX";
    this.documents = documents;
    this.meter = meter;
    this.budget = new RoomBudget((day, units) =>
      env.DEMO_BUDGET.getByName(DEMO_BUDGET_NAME).reserve(day, units),
    );
    this.editable = new CollaborativeFileSystem(this.fileSystem, documents.registry);
    documents.attach(
      this.editable,
      (notice) => this.announce(notice),
      (operation) => this.operations.run(operation),
    );
    ctx.blockConcurrencyWhile(async () => {
      // The Linux profile's directories, created once per workspace. `/bin` and
      // `/usr/bin` are deliberately not among them: they resolve applets
      // without a namespace entry, so a row there would be a directory that
      // could be removed while `/bin/cat` kept working.
      const profileEntries = provisionLinuxFilesystem(this.fileSystem, { user: DEMO_USER });
      let welcome: VfsStat;
      try {
        welcome = this.fileSystem.stat(`${DEMO_HOME}/README.txt`);
      } catch (error) {
        if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
        await this.fileSystem.writeFile(`${DEMO_HOME}/README.txt`, WELCOME_FILE);
        welcome = this.fileSystem.stat(`${DEMO_HOME}/README.txt`);
      }
      // Existing rooms predate POSIX execution identity and their entries are
      // owned by the raw administration identity. Claim them once before the
      // first credential-bound session so persistent files remain usable.
      const identityVersion = await ctx.storage.get<number>(DEMO_IDENTITY_VERSION_KEY);
      if (identityVersion !== DEMO_IDENTITY_VERSION) {
        migrateDemoOwnership(this.fileSystem);
        await ctx.storage.put(DEMO_IDENTITY_VERSION_KEY, DEMO_IDENTITY_VERSION);
      } else {
        // Provisioning can recreate a profile path or README a visitor removed.
        // Those administration writes need the demo identity even after the
        // legacy whole-tree migration has already run.
        ensureDemoOwnership(this.fileSystem, [...profileEntries, welcome]);
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const address = addressKey(request.headers.get("CF-Connecting-IP"));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // An open socket keeps the room running and each session holds a shell,
    // so a room and an address may only hold so many, and none once today's
    // budget is spent. A refusal is a close code the page will not retry by
    // itself, where a failed upgrade would be retried every few seconds.
    let held = 0;
    for (const open of this.sessions.values()) if (open.address === address) held += 1;
    const refusal = this.budget.exhausted
      ? CLOSE.budget
      : this.sessions.size >= MAX_ROOM_SESSIONS
        ? CLOSE.roomFull
        : held >= MAX_ADDRESS_SESSIONS
          ? CLOSE.tooManySessions
          : undefined;
    if (refusal !== undefined) {
      server.close(refusal, "refused");
      return new Response(null, { status: 101, webSocket: client });
    }

    const session: TerminalSession = {
      address,
      tokens: MESSAGE_BURST,
      tokensAt: Date.now(),
      shell: new InteractiveShell({
        fileSystem: this.editable,
        commands: [...defaultShellCommands, curlCommand, gitCommand],
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
        credentials: DEMO_CREDENTIALS,
        identityResolver: DEMO_IDENTITY_RESOLVER,
        limits: SHELL_LIMITS,
        network: demoNetwork(),
        policy: { maxRowsWritten: SHELL_LIMITS.maxRowsWritten, network: "allow" },
      }),
      input: new InteractiveInputBuffer({
        limits: {
          maxMemoryBytes: SHELL_LIMITS.maxMemoryBytes,
          maxDepth: SHELL_LIMITS.maxDepth,
        },
      }),
      watching: new Set<string>(),
      pendingSourceBytes: 0,
      execution: undefined,
      pending: undefined,
      idle: undefined,
      expiry: undefined,
    };
    this.chargeUsage();
    this.sessions.set(server, session);
    this.keepAlive(server, session);
    session.expiry = setTimeout(() => this.endSession(server, CLOSE.expired), MAX_SESSION_MS);

    server.addEventListener("message", (event) => {
      void this.handleMessage(server, event.data).catch((error: unknown) => {
        // A visitor's own mistakes are answered, not logged: logged events are
        // billed, and a client could send malformed messages without end.
        if (!(error instanceof VfsError)) {
          console.error(
            JSON.stringify({
              message: "terminal WebSocket message failed",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
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
      features: ["completion", "resize-hint", "sigint", "continuation", "documents"],
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

  /**
   * Restarts the idle timer, which only a command or an edit does: a keepalive,
   * a resize or a completion request does not keep a room running. A command
   * still running defers the close.
   */
  private keepAlive(socket: WebSocket, session: TerminalSession): void {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      if (session.execution !== undefined || session.pending !== undefined) {
        this.keepAlive(socket, session);
        return;
      }
      this.endSession(socket, CLOSE.idle);
    }, IDLE_SESSION_MS);
  }

  private endSession(socket: WebSocket, code: number): void {
    if (socketIsOpen(socket)) socket.close(code, "ended");
    this.removeSession(socket);
  }

  /**
   * Charges what the room has cost since the last charge — rows its storage
   * read and wrote, and the time open sessions kept it running — to the
   * budget, and to `address` when that work was its.
   */
  private chargeUsage(address?: string): void {
    const now = Date.now();
    const { rowsRead, rowsWritten } = this.meter;
    const units =
      (rowsWritten - this.charged.rowsWritten) * COST.rowWritten +
      (rowsRead - this.charged.rowsRead) * COST.rowRead +
      (this.sessions.size > 0 ? ((now - this.charged.at) / 1000) * COST.awakeSecond : 0);
    this.charged = { rowsRead, rowsWritten, at: now };
    this.budget.charge(units, address);
  }

  /** Whether `session` may send another message; a flood closes it. */
  private admits(socket: WebSocket, session: TerminalSession): boolean {
    const now = Date.now();
    session.tokens = Math.min(
      MESSAGE_BURST,
      session.tokens + ((now - session.tokensAt) / 1000) * MESSAGES_PER_SECOND,
    );
    session.tokensAt = now;
    if (session.tokens < 1) {
      if (socketIsOpen(socket)) socket.close(1008, "too many messages");
      this.removeSession(socket);
      return false;
    }
    session.tokens -= 1;
    return true;
  }

  private removeSession(socket: WebSocket): void {
    const session = this.sessions.get(socket);
    if (session !== undefined) this.chargeUsage();
    clearTimeout(session?.idle);
    clearTimeout(session?.expiry);
    session?.pending?.abort();
    session?.execution?.cancel();
    this.sessions.delete(socket);
    // A document nobody is looking at any more is dropped, but only after the
    // socket is out of the map so it does not count as its own watcher.
    void this.operations
      .run(async () => {
        await this.documents.flush();
        for (const path of session?.watching ?? []) {
          if (
            !this.watchedElsewhere(socket, path) &&
            this.documents.registry.get(path)?.dirty !== true
          )
            this.documents.close(path);
        }
      })
      .catch((error: unknown) => console.error("document close failed", error));
  }

  private watchedElsewhere(except: WebSocket, path: string): boolean {
    for (const [socket, session] of this.sessions) {
      if (socket !== except && session.watching.has(path)) return true;
    }
    return false;
  }

  /** Acknowledges the writer and updates every other subscriber. */
  private broadcastDocument(path: string): void {
    const document = this.documents.get(path);
    if (document === undefined) return;
    for (const [socket, session] of this.sessions) {
      if (!session.watching.has(path)) continue;
      send(socket, { type: "doc", path, version: document.version(), text: document.text() });
    }
  }

  /** Relays what the namespace did to an open document. */
  private announce(notice: DocumentNotice): void {
    if (notice.kind === "error") {
      for (const [socket, session] of this.sessions) {
        if (session.watching.has(notice.path))
          send(socket, {
            type: "error",
            message: `${notice.path}: ${notice.message ?? "document could not be saved"}`,
          });
      }
      return;
    }
    if (notice.kind === "changed") {
      this.broadcastDocument(notice.path);
      return;
    }
    for (const [socket, session] of this.sessions) {
      if (!session.watching.has(notice.path)) continue;
      session.watching.delete(notice.path);
      if (notice.to !== undefined) session.watching.add(notice.to);
      send(socket, {
        type: "doc-gone",
        path: notice.path,
        ...(notice.to === undefined ? {} : { to: notice.to }),
      });
    }
  }

  private async handleMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(socket);
    if (session === undefined) return;
    if (!this.admits(socket, session)) return;
    const message = parseClientMessage(rawMessage);

    if (message.type === "ping") {
      send(socket, { type: "pong" });
      return;
    }
    if (message.type === "signal") {
      if (session.pending !== undefined) {
        session.pending.abort();
        if (session.execution !== undefined) session.execution.cancel();
        else {
          session.pending = undefined;
          prompt(socket, session);
        }
      } else {
        session.input.clear();
        session.pendingSourceBytes = 0;
        prompt(socket, session);
      }
      return;
    }
    if (
      message.type === "doc-open" ||
      message.type === "doc-close" ||
      message.type === "doc-edit"
    ) {
      await this.operations.run(async () => {
        if (this.sessions.get(socket) !== session) return;
        if (message.type === "doc-open") {
          const document = await this.documents.open(message.path);
          if (this.sessions.get(socket) !== session) {
            if (!this.watchedElsewhere(socket, message.path)) this.documents.close(message.path);
            return;
          }
          session.watching.add(message.path);
          send(socket, {
            type: "doc",
            path: message.path,
            version: document.version(),
            text: document.text(),
          });
          return;
        }
        if (message.type === "doc-close") {
          await this.documents.flush();
          if (this.documents.registry.get(message.path)?.dirty === true)
            throw new VfsError(
              "EAGAIN",
              "Document is still unsaved; free space and retry closing",
              message.path,
            );
          // Closed only when this was the last socket looking at it: the room is
          // shared, and one visitor closing a tab must not take the document out
          // from under another who is still editing it.
          if (!this.watchedElsewhere(socket, message.path)) this.documents.close(message.path);
          session.watching.delete(message.path);
          return;
        }
        if (message.type === "doc-edit") {
          const refused = await this.budget.refusal(session.address);
          if (refused !== undefined) throw new VfsError("ENOSPC", refused);
          this.keepAlive(socket, session);
          this.chargeUsage(session.address);
          session.watching.add(message.path);
          const applied = this.documents.applyClientText(message.path, message.base, message.text);
          const document = this.documents.get(message.path);
          if (document === undefined) return;
          if (applied === "stale") {
            // Say what is true now rather than taking text typed against something
            // that has since been replaced.
            send(socket, {
              type: "doc",
              path: message.path,
              version: document.version(),
              text: document.text(),
            });
            return;
          }
          this.broadcastDocument(message.path);
          return;
        }
      });
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
    if (session.execution !== undefined || session.pending !== undefined) {
      send(socket, { type: "error", message: "A command is already running or queued" });
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
    this.keepAlive(socket, session);
    if (this.budget.exhausted) {
      throw new VfsError(
        "ENOSPC",
        "the public demo has used today's budget; it resets at 00:00 UTC",
      );
    }
    const pending = new AbortController();
    session.pending = pending;
    send(socket, { type: "running" });
    try {
      await this.operations.run(async () => {
        if (pending.signal.aborted || this.sessions.get(socket) !== session) return;
        await this.documents.flush();
        this.chargeUsage();
        if (pending.signal.aborted) return;
        // Checked here, at its turn, so commands queued before the budget ran
        // out do not run after it.
        const refused = await this.budget.refusal(session.address);
        if (refused !== undefined) {
          send(socket, { type: "error", message: refused });
          prompt(socket, session);
          return;
        }
        try {
          await this.execute(socket, session, submitted.source, pending.signal);
        } finally {
          this.chargeUsage(session.address);
        }
      });
    } finally {
      if (session.pending === pending) session.pending = undefined;
    }
  }

  private async execute(
    socket: WebSocket,
    session: TerminalSession,
    source: string,
    signal: AbortSignal,
  ): Promise<void> {
    const execution = session.shell.runStream({ script: source, signal });
    session.execution = execution;
    try {
      const [result] = await Promise.all([
        execution.completed,
        pumpOutput(socket, execution.stdout, "stdout"),
        pumpOutput(socket, execution.stderr, "stderr"),
      ]).finally(async () => {
        this.documents.noticeShellWrites();
        await this.documents.flush();
      });
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
