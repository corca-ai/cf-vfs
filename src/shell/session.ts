import { normalizePath } from "../core/path.js";
import { ShellEnvironment } from "./environment.js";
import type { ShellSession } from "./types.js";

export interface ShellSessionOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  args?: readonly string[];
}

export function createShellSession(options: ShellSessionOptions = {}): ShellSession {
  const cwd = normalizePath(options.cwd ?? "/");
  const session: ShellSession = {
    cwd,
    env: new ShellEnvironment(Object.entries(options.env ?? {})),
    args: [...(options.args ?? [])],
    lastExitCode: 0,
    exitRequested: false,
    requestedExitCode: 0,
    pipefail: false,
    errexit: false,
    nounset: false,
    functions: new Map(),
    functionDepth: 0,
    sourceDepth: 0,
    loopDepth: 0,
    localFrames: [],
    localGetoptsFrames: [],
    getopts: undefined,
    flow: { type: "none" },
  };
  session.env.set("PWD", cwd);
  session.env.set("0", session.env.get("0") ?? "cf-vfs");
  session.env.set("IFS", " \t\n");
  if (!session.env.has("OPTIND")) session.env.set("OPTIND", "1");
  session.env.set("LC_ALL", "C");
  session.env.set("TZ", "UTC");
  return session;
}

export function cloneShellSession(session: ShellSession): ShellSession {
  return {
    cwd: session.cwd,
    env: session.env instanceof ShellEnvironment
      ? session.env.clone()
      : new ShellEnvironment(session.env),
    args: [...session.args],
    lastExitCode: session.lastExitCode,
    exitRequested: false,
    requestedExitCode: 0,
    pipefail: session.pipefail,
    errexit: session.errexit === true,
    nounset: session.nounset === true,
    functions: new Map(session.functions),
    functionDepth: session.functionDepth,
    sourceDepth: session.sourceDepth,
    loopDepth: session.loopDepth,
    localFrames: session.localFrames.map((frame) => new Map(frame)),
    localGetoptsFrames: session.localGetoptsFrames.map((frame) => ({
      captured: frame.captured,
      state: frame.state === undefined ? undefined : { ...frame.state },
    })),
    getopts: session.getopts === undefined ? undefined : { ...session.getopts },
    flow: { type: "none" },
  };
}

export function prepareShellSessionUnit(session: ShellSession): void {
  session.exitRequested = false;
  session.requestedExitCode = 0;
  session.functionDepth = 0;
  session.sourceDepth = 0;
  session.loopDepth = 0;
  session.localFrames.length = 0;
  session.localGetoptsFrames.length = 0;
  session.flow = { type: "none" };
}
