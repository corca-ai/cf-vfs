import { VfsError } from "../core/errors.js";

/**
 * Interpreters an executable VFS script may name.
 *
 * Every one of them selects the same thing: the cf-vfs shell profile exported
 * as `BASH_COMPATIBILITY_VERSION`. A script that says `#!/bin/bash` gets that
 * profile, not host Bash, and a script naming anything else is refused rather
 * than silently run by something it did not ask for.
 */
export const SHELL_INTERPRETERS: readonly string[] = [
  "/bin/sh",
  "/bin/bash",
  "/usr/bin/sh",
  "/usr/bin/bash",
];

/**
 * The name `ShellPolicy.allowedCommands` must list to permit running an
 * executable VFS file.
 *
 * Running a script is running the shell profile, so one entry authorizes it
 * rather than every script path an application might ever store.
 */
export const SHELL_PROFILE_COMMAND = "sh";

/** `#!/usr/bin/env NAME` forms this profile accepts. */
const ENV_INTERPRETERS: readonly string[] = ["/usr/bin/env", "/bin/env"];

/** Bare interpreter names `/usr/bin/env` may select. */
export const ENV_INTERPRETER_NAMES: readonly string[] = ["sh", "bash"];

/**
 * Bytes of a script the shebang scan may read.
 *
 * Linux caps the interpreter line at 256 bytes (`BINPRM_BUF_SIZE`). Matching
 * that keeps the scan a small fixed prefix rather than a function of file size,
 * and makes an absurd first line a deterministic failure rather than work.
 */
export const MAX_SHEBANG_BYTES = 256;

const HASH = 0x23;
const BANG = 0x21;
const NEWLINE = 0x0a;
const NUL = 0x00;

export interface ShebangResult {
  /** The interpreter line without `#!`, or `undefined` when there is none. */
  readonly line: string | undefined;
}

/**
 * Reads the interpreter line from a byte prefix.
 *
 * This runs before the file is decoded: an interpreter line is ASCII by
 * construction, and a file whose first line is not valid ASCII is not a script
 * this profile can run. Returning the raw line keeps the policy decision in one
 * place instead of spreading it across the byte scan.
 */
export function readShebangLine(bytes: Uint8Array): ShebangResult {
  if (bytes.length < 2 || bytes[0] !== HASH || bytes[1] !== BANG) return { line: undefined };
  const limit = Math.min(bytes.length, MAX_SHEBANG_BYTES);
  let end = 2;
  while (end < limit && bytes[end] !== NEWLINE) end += 1;
  if (end === limit && (bytes[end] ?? NEWLINE) !== NEWLINE) {
    throw new VfsError("ENOEXEC", `interpreter line exceeds ${MAX_SHEBANG_BYTES} bytes`);
  }
  let line = "";
  for (let index = 2; index < end; index += 1) {
    const byte = bytes[index] ?? NUL;
    if (byte === NUL || byte > 0x7f) {
      throw new VfsError("ENOEXEC", "interpreter line is not ASCII");
    }
    line += String.fromCharCode(byte);
  }
  return { line: line.endsWith("\r") ? line.slice(0, -1) : line };
}

/**
 * Decides whether an interpreter line selects the cf-vfs shell profile.
 *
 * Linux hands everything after the interpreter to it as one argument. This
 * profile accepts only an `env` form with a bare interpreter name, so that one
 * argument is the whole option surface: no interpreter flags, no `env -S`, and
 * no assignments.
 */
export function selectsShellProfile(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  const separator = trimmed.search(/\s/u);
  const interpreter = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim();
  if (SHELL_INTERPRETERS.includes(interpreter)) return argument === "";
  if (!ENV_INTERPRETERS.includes(interpreter)) return false;
  return ENV_INTERPRETER_NAMES.includes(argument);
}

/** Whether any mode class marks a path executable. */
export function isExecutableMode(mode: number): boolean {
  return (mode & 0o111) !== 0;
}
