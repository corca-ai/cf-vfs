import { isVfsError, VfsError } from "../core/errors.js";
import { normalizePath } from "../core/path.js";
import { supportsPosixCredentials } from "../vfs/capabilities.js";
import { bodyToStream, readAllBytes } from "../vfs/streams.js";
import type { VirtualFileSystem } from "../vfs/types.js";
import { ExecutionBudget, resolveShellLimits } from "./budget.js";
import {
  APPLET_DIRECTORIES,
  type AppletRegistry,
  createAppletRegistry,
} from "./commands/applet.js";
import type { ShellContentReader } from "./content.js";
import { ReservedPathFileSystem } from "./devices.js";
import type { ShellEventSink } from "./events.js";
import type { ShellIdentityResolver } from "./identity.js";
import type { ShellNetwork } from "./network.js";
import { ScopedFileSystem } from "./policy.js";
import { createShellSession } from "./session.js";
import { describeCommands } from "./shell-resolve.js";
import { executeShellSessionStream } from "./shell-session-execution.js";
import type {
  ExecuteBytesResult,
  ExecuteStreamOptions,
  ExecuteTextOptions,
  ExecuteTextResult,
  ShellCommandDescription,
  ShellExecution,
  ShellFileSystem,
  ShellLimits,
  ShellOptions,
  ShellPolicy,
  ShellSession,
} from "./types.js";

export class Shell {
  private readonly commands: AppletRegistry;
  #appletListing: readonly string[] | undefined;
  private readonly pathLookup: boolean;
  private readonly fileSystem: ShellOptions["fileSystem"];
  private readonly policy: ShellPolicy;
  private readonly content: ShellContentReader | undefined;
  private readonly network: ShellNetwork | undefined;
  private readonly identityResolver: ShellIdentityResolver | undefined;
  private readonly limits: ShellLimits;
  private readonly now: () => number;
  private readonly onEvent: ShellEventSink | undefined;

  constructor(options: ShellOptions) {
    this.commands = createAppletRegistry(options.commands);
    this.pathLookup = options.commandResolution === "path";
    this.fileSystem = options.fileSystem;
    this.content = options.content;
    this.network = options.network;
    this.identityResolver = options.identityResolver;
    this.policy = Object.freeze({
      ...(options.policy?.readRoots === undefined
        ? {}
        : {
            readRoots: Object.freeze(options.policy.readRoots.map((path) => normalizePath(path))),
          }),
      ...(options.policy?.writeRoots === undefined
        ? {}
        : {
            writeRoots: Object.freeze(options.policy.writeRoots.map((path) => normalizePath(path))),
          }),
      ...(options.policy?.opaqueContent === undefined
        ? {}
        : { opaqueContent: options.policy.opaqueContent }),
      ...(options.policy?.network === undefined ? {} : { network: options.policy.network }),
      ...(options.policy?.allowedCommands === undefined
        ? {}
        : { allowedCommands: Object.freeze([...options.policy.allowedCommands]) }),
      ...(options.policy?.maxMutations === undefined
        ? {}
        : { maxMutations: options.policy.maxMutations }),
    });
    this.limits = Object.freeze(
      resolveShellLimits({
        ...options.limits,
        ...(options.policy?.maxMutations === undefined
          ? {}
          : { maxMutations: options.policy.maxMutations }),
      }),
    );
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  /**
   * Describes every registered applet, in UTF-8 byte order by name.
   *
   * The same list `help` sees. It is public because completion runs before any
   * command exists, in the interactive layer, which has no command context to
   * ask.
   */
  listCommands(): readonly ShellCommandDescription[] {
    return describeCommands({ commands: this.commands });
  }

  /**
   * What a session may be offered, from the same rules that would run it.
   *
   * Built here rather than assembled by a subclass out of fields, because both
   * halves are policy decisions the shell owns. The filesystem is the scoped
   * one every execution uses, so completion cannot list a directory the
   * session could not read — discovery through a different door than
   * execution is how a sandbox leaks. The names are filtered by the command
   * allowlist and include the applet path spellings that actually resolve, so
   * completion never advertises a command that would fail with 126 or 127.
   */
  /**
   * The names this session could actually run, in resolution order.
   *
   * Filtered by the command allowlist and joined with the session's own
   * functions, so nothing offered or listed is a command that would be refused.
   */
  #runnableNames(functions: ReadonlySet<string>): string[] {
    const allowed = this.policy.allowedCommands;
    const names: string[] = [];
    for (const command of this.commands.names()) {
      if (allowed !== undefined && !allowed.includes(command)) continue;
      names.push(command);
    }
    for (const name of functions) if (!names.includes(name)) names.push(name);
    return names.sort();
  }

  /**
   * The filesystem a session sees: the policy's, with the reserved paths in
   * front of it.
   *
   * The applet directories are listable rather than absent, so `which cat`
   * answering `/bin/cat` and `ls /bin` showing it are the same fact. They hold
   * no rows — a row there could be removed while `/bin/cat` kept working —
   * which is why they are reserved here instead of provisioned.
   */
  #reservedView(
    budget: ExecutionBudget,
    fileSystem: VirtualFileSystem = this.fileSystem,
  ): ShellFileSystem {
    this.#appletListing ??= this.#buildAppletListing();
    return new ReservedPathFileSystem(new ScopedFileSystem(fileSystem, this.policy, budget), {
      applets: { directories: APPLET_DIRECTORIES, names: this.#appletListing },
    });
  }

  #sessionFileSystem(session: ShellSession): VirtualFileSystem {
    if (session.credentials === undefined) return this.fileSystem;
    if (!supportsPosixCredentials(this.fileSystem)) {
      throw new VfsError("ENOTSUP", "filesystem does not support POSIX credentials");
    }
    return this.fileSystem.forCredentials(session.credentials, { umask: session.umask });
  }

  /**
   * The applet directory listing, which depends only on the registry and the
   * policy and so is computed once rather than per execution.
   *
   * Session functions are deliberately not an input: a function is not a
   * program, so it has no path form and the filter below would drop it anyway.
   */
  #buildAppletListing(): readonly string[] {
    const directory = APPLET_DIRECTORIES[0] ?? "/bin";
    const allowed = this.policy.allowedCommands;
    const listed: string[] = [];
    for (const name of this.commands.names()) {
      if (allowed !== undefined && !allowed.includes(name)) continue;
      // Only names that resolve as a path belong in the listing, which is what
      // keeps a session-built-in like `cd` from appearing as `/bin/cd` and
      // then failing with 127.
      if (this.commands.findPath(`${directory}/${name}`) === undefined) continue;
      // And only names that survive being written as one. `.` is a real
      // applet, but `/bin/.` normalizes back to `/bin`, so listing it would
      // put the directory inside itself.
      if (name === "." || name === ".." || name.includes("/")) continue;
      listed.push(name);
    }
    return listed.sort();
  }

  protected completionSource(session: ShellSession): {
    fileSystem: ShellFileSystem;
    commands: readonly string[];
    appletDirectories: readonly string[];
  } {
    const budget = new ExecutionBudget(this.limits, this.now, this.onEvent);
    // A shell function is a name this session created, and it resolves before
    // any applet does.
    const names = this.#runnableNames(new Set(session.functions.keys()));
    return {
      fileSystem: this.#reservedView(budget, this.#sessionFileSystem(session)),
      commands: names,
      // An absolute applet path resolves before any PATH search, so these
      // spell a runnable command whether or not PATH lookup is enabled.
      appletDirectories: APPLET_DIRECTORIES,
    };
  }

  executeStream(options: ExecuteStreamOptions): ShellExecution {
    return this.executeSessionStream(options, createShellSession(options));
  }

  protected executeSessionStream(
    options: ExecuteStreamOptions,
    session: ShellSession,
  ): ShellExecution {
    return executeShellSessionStream(options, session, {
      commands: this.commands,
      pathLookup: this.pathLookup,
      now: this.now,
      fileSystem: (budget, activeSession) =>
        this.#reservedView(budget, this.#sessionFileSystem(activeSession)),
      content: this.content,
      network: this.network,
      identityResolver: this.identityResolver,
      limits: this.limits,
      policy: this.policy,
      onEvent: this.onEvent,
    });
  }

  async executeText(options: ExecuteTextOptions): Promise<ExecuteTextResult> {
    return this.executeSessionText(options, createShellSession(options));
  }

  protected async executeSessionText(
    options: ExecuteTextOptions,
    session: ShellSession,
  ): Promise<ExecuteTextResult> {
    const result = await this.executeSessionBytes(options, session);
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdoutBytes),
      stderr: new TextDecoder().decode(result.stderrBytes),
    };
  }

  async executeBytes(options: ExecuteTextOptions): Promise<ExecuteBytesResult> {
    return this.executeSessionBytes(options, createShellSession(options));
  }

  protected async executeSessionBytes(
    options: ExecuteTextOptions,
    session: ShellSession,
  ): Promise<ExecuteBytesResult> {
    const { stdin: input, ...streamOptions } = options;
    const stdin =
      typeof input === "string" || input instanceof Uint8Array ? bodyToStream(input) : input;
    const execution = this.executeSessionStream(
      {
        ...streamOptions,
        ...(stdin === undefined ? {} : { stdin }),
      },
      session,
    );
    const collectOutput = async (
      stream: ReadableStream<Uint8Array>,
      maximumBytes: number,
    ): Promise<Uint8Array> => {
      try {
        return await readAllBytes(stream, maximumBytes);
      } catch (error) {
        if (isVfsError(error)) return new Uint8Array();
        throw error;
      }
    };
    const [stdoutBytes, stderrBytes, result] = await Promise.all([
      collectOutput(execution.stdout, this.limits.maxStdoutBytes),
      collectOutput(execution.stderr, this.limits.maxStderrBytes),
      execution.completed,
    ]);
    if (stdoutBytes.byteLength + stderrBytes.byteLength > this.limits.maxMaterializedOutputBytes) {
      return {
        exitCode: 1,
        stdoutBytes: new Uint8Array(),
        stderrBytes: new Uint8Array(),
      };
    }
    return {
      exitCode: result.exitCode,
      stdoutBytes,
      stderrBytes,
    };
  }
}
