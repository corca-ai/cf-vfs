import { VfsError } from "../../core/errors.js";

export interface GitArguments {
  readonly operands: string[];
  readonly flags: Set<string>;
  readonly values: Map<string, string>;
}

/** Only explicitly supported options are accepted; no silently ignored flags. */
export function gitArguments(
  argv: readonly string[],
  flags: readonly string[] = [],
  valued: readonly string[] = [],
): GitArguments {
  const parsed: GitArguments = { operands: [], flags: new Set(), values: new Map() };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === undefined) continue;
    if (literal || !argument.startsWith("-") || argument === "-") {
      parsed.operands.push(argument);
      continue;
    }
    if (argument === "--") {
      literal = true;
      continue;
    }
    if (flags.includes(argument)) {
      parsed.flags.add(argument);
      continue;
    }
    const option = valueOption(argument, argv[i + 1], valued);
    parsed.values.set(option.name, option.value);
    if (option.consumed) i++;
  }
  return parsed;
}

export function gitOperands(args: GitArguments, minimum: number, maximum = minimum): void {
  if (args.operands.length < minimum || args.operands.length > maximum)
    throw new VfsError("EINVAL", "git: incorrect number of operands");
}

export function localGitPath(value: string, cwd: string): string {
  let path = value;
  if (value.startsWith("file://")) {
    const url = new URL(value);
    if (url.hostname !== "" || url.search !== "" || url.hash !== "")
      throw new VfsError("ENOTSUP", "git: only local file URLs are supported");
    path = decodeURIComponent(url.pathname);
  } else if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw new VfsError("ENOTSUP", "git: only local repository paths are supported");
  }
  return normalizeFileSystemPath(path, cwd);
}

import { normalizeFileSystemPath } from "../../core/path.js";

function valueOption(argument: string, next: string | undefined, allowed: readonly string[]) {
  const split = argument.indexOf("=");
  const name = split < 0 ? argument : argument.slice(0, split);
  if (!allowed.includes(name)) throw new VfsError("EINVAL", `git: unsupported option ${argument}`);
  const value = split < 0 ? next : argument.slice(split + 1);
  if (value === undefined || value === "")
    throw new VfsError("EINVAL", `git: ${name} requires a value`);
  return { name, value, consumed: split < 0 };
}
