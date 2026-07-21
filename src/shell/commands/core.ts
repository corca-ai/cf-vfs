import { VfsError } from "../../core/errors.js";
import { normalizePath } from "../../core/path.js";
import { optindGeneration, setOptindFromGetopts } from "../environment.js";
import { readInputRecord } from "../input.js";
import type { ShellCommandContext } from "../types.js";
import {
  commandPath,
  defineCommand,
  parseInteger,
  readFileText,
  writeText,
} from "./helpers.js";

export const colonCommand = /* @__PURE__ */ defineCommand(":", () => 0);
export const trueCommand = /* @__PURE__ */ defineCommand("true", () => 0);
export const falseCommand = /* @__PURE__ */ defineCommand("false", () => 1);

export const echoCommand = /* @__PURE__ */ defineCommand("echo", async (_context, argv, fds) => {
  let newline = true;
  let start = 0;
  if (argv[0] === "-n") {
    newline = false;
    start = 1;
  }
  await writeText(fds[1], `${argv.slice(start).join(" ")}${newline ? "\n" : ""}`);
  return 0;
});

function formatPrintfOnce(format: string, values: readonly string[]): {
  output: string;
  consumed: number;
} {
  let index = 0;
  let output = "";
  for (let offset = 0; offset < format.length; offset += 1) {
    const character = format[offset];
    if (character === "\\") {
      const next = format[++offset];
      if (next === "n") output += "\n";
      else if (next === "t") output += "\t";
      else if (next === "r") output += "\r";
      else if (next === "\\") output += "\\";
      else output += next ?? "\\";
      continue;
    }
    if (character !== "%") {
      output += character;
      continue;
    }
    const specifier = format[++offset];
    if (specifier === "%") output += "%";
    else if (specifier === "s") output += values[index++] ?? "";
    else if (specifier === "d") output += String(Number.parseInt(values[index++] ?? "0", 10) || 0);
    else if (specifier === "b") output += decodeBackslashEscapes(values[index++] ?? "");
    else throw new VfsError("EINVAL", `printf: unsupported conversion %${specifier ?? ""}`);
  }
  return { output, consumed: index };
}

function decodeBackslashEscapes(value: string): string {
  let output = "";
  for (let offset = 0; offset < value.length; offset += 1) {
    const character = value[offset];
    if (character !== "\\") {
      output += character;
      continue;
    }
    const next = value[++offset];
    if (next === "n") output += "\n";
    else if (next === "t") output += "\t";
    else if (next === "r") output += "\r";
    else if (next === "\\") output += "\\";
    else output += next ?? "\\";
  }
  return output;
}

function formatPrintf(format: string, values: readonly string[]): string {
  let output = "";
  let offset = 0;
  do {
    const result = formatPrintfOnce(format, values.slice(offset));
    output += result.output;
    offset += result.consumed;
    if (result.consumed === 0) break;
  } while (offset < values.length);
  return output;
}

export const printfCommand = /* @__PURE__ */ defineCommand("printf", async (_context, argv, fds) => {
  if (argv.length === 0) throw new VfsError("EINVAL", "printf: missing format");
  await writeText(fds[1], formatPrintf(argv[0] ?? "", argv.slice(1)));
  return 0;
});

export const pwdCommand = /* @__PURE__ */ defineCommand("pwd", async (context, _argv, fds) => {
  await writeText(fds[1], `${context.session.cwd}\n`);
  return 0;
});

export const cdCommand = /* @__PURE__ */ defineCommand("cd", async (context, argv) => {
  if (argv.length > 1) throw new VfsError("EINVAL", "cd: too many arguments");
  const target = normalizePath(argv[0] ?? context.session.env.get("HOME") ?? "/", context.session.cwd);
  const stat = await context.fileSystem.stat(target);
  if (stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", target);
  context.session.cwd = target;
  context.session.env.set("PWD", target);
  return 0;
});

function assignment(value: string): { name: string; value: string } {
  const separator = value.indexOf("=");
  const name = separator < 0 ? value : value.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new VfsError("EINVAL", `invalid variable name: ${name}`);
  }
  return { name, value: separator < 0 ? "" : value.slice(separator + 1) };
}

export const exportCommand = /* @__PURE__ */ defineCommand("export", (context, argv) => {
  for (const value of argv) {
    const parsed = assignment(value);
    context.session.env.set(
      parsed.name,
      value.includes("=") ? parsed.value : context.session.env.get(parsed.name) ?? "",
    );
  }
  return 0;
});

export const unsetCommand = /* @__PURE__ */ defineCommand("unset", (context, argv) => {
  for (const name of argv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new VfsError("EINVAL", `unset: invalid variable name: ${name}`);
    }
    context.session.env.delete(name);
  }
  return 0;
});

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const READ_IFS = /[ \t\n]/u;

function readVariableNames(argv: readonly string[]): { names: string[]; reply: boolean } {
  if (argv[0] !== "-r") {
    throw new VfsError("EINVAL", "read: only read -r [name ...] is supported");
  }
  const operands = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
  const names = operands.length === 0 ? ["REPLY"] : [...operands];
  for (const name of names) {
    if (!VARIABLE_NAME.test(name)) {
      throw new VfsError("EINVAL", `read: invalid variable name: ${name}`);
    }
  }
  return { names, reply: operands.length === 0 };
}

function readAssignments(
  value: string,
  names: readonly string[],
  reply: boolean,
): Array<{ name: string; value: string }> {
  if (reply) return [{ name: "REPLY", value }];
  const assignments: Array<{ name: string; value: string }> = [];
  let offset = 0;
  while (offset < value.length && READ_IFS.test(value[offset] ?? "")) offset += 1;
  for (const [index, name] of names.entries()) {
    if (index === names.length - 1) {
      let end = value.length;
      while (end > offset && READ_IFS.test(value[end - 1] ?? "")) end -= 1;
      assignments.push({ name, value: value.slice(offset, end) });
      break;
    }
    let end = offset;
    while (end < value.length && !READ_IFS.test(value[end] ?? "")) end += 1;
    assignments.push({ name, value: value.slice(offset, end) });
    offset = end;
    while (offset < value.length && READ_IFS.test(value[offset] ?? "")) offset += 1;
  }
  return assignments;
}

export const readCommand = /* @__PURE__ */ defineCommand("read", async (context, argv, fds) => {
  const { names, reply } = readVariableNames(argv);
  const record = await readInputRecord(fds[0], context.budget, context.signal);
  for (const value of readAssignments(record.value, names, reply)) {
    context.session.env.set(value.name, value.value);
  }
  return record.terminated ? 0 : 1;
});

export const shiftCommand = /* @__PURE__ */ defineCommand("shift", (context, argv) => {
  if (argv.length > 1) throw new VfsError("EINVAL", "shift: too many arguments");
  const count = argv[0] === undefined ? 1 : parseInteger(argv[0], "shift count");
  if (count > context.session.args.length) return 1;
  context.session.args.splice(0, count);
  return 0;
});

function validateGetoptsSpec(optstring: string, name: string): void {
  if (!VARIABLE_NAME.test(name)) {
    throw new VfsError("EINVAL", `getopts: invalid variable name: ${name}`);
  }
  const specification = optstring.startsWith(":") ? optstring.slice(1) : optstring;
  for (let index = 0; index < specification.length; index += 1) {
    const option = specification[index] ?? "";
    if (option === ":" || option === "?" || option === "-") {
      throw new VfsError("EINVAL", `getopts: invalid option specification: ${option}`);
    }
    if (specification[index + 1] === ":") index += 1;
  }
}

export const getoptsCommand = /* @__PURE__ */ defineCommand("getopts", async (context, argv, fds) => {
  if (argv.length < 2) {
    throw new VfsError("EINVAL", "getopts: expected optstring and variable name");
  }
  const [optstring = "", name = "", ...explicitArgs] = argv;
  validateGetoptsSpec(optstring, name);
  const args = explicitArgs.length === 0 ? context.session.args : explicitArgs;
  const optind = parseInteger(context.session.env.get("OPTIND") ?? "1", "getopts: OPTIND", 1);
  const previous = context.session.getopts;
  let argumentIndex = optind - 1;
  let characterIndex = previous !== undefined
    && previous.optind === optind
    && previous.optindGeneration === optindGeneration(context.session.env)
    ? previous.characterIndex
    : 1;
  const silent = optstring.startsWith(":");
  const specification = silent ? optstring.slice(1) : optstring;

  const save = (nextOptind: number, nextCharacterIndex: number): void => {
    setOptindFromGetopts(context.session.env, String(nextOptind));
    context.session.getopts = {
      optind: nextOptind,
      characterIndex: nextCharacterIndex,
      optindGeneration: optindGeneration(context.session.env),
    };
  };
  const finish = (nextOptind: number): number => {
    save(nextOptind, 1);
    context.session.env.set(name, "?");
    context.session.env.delete("OPTARG");
    return 1;
  };

  while (true) {
    const argument = args[argumentIndex];
    if (argument === undefined || argument === "-" || !argument.startsWith("-")) {
      return finish(argumentIndex + 1);
    }
    if (argument === "--") return finish(argumentIndex + 2);
    if (characterIndex >= argument.length) {
      argumentIndex += 1;
      characterIndex = 1;
      continue;
    }

    const option = argument[characterIndex] ?? "";
    const definition = option === ":" ? -1 : specification.indexOf(option);
    const requiresArgument = definition >= 0 && specification[definition + 1] === ":";
    let nextOptind = argumentIndex + 1;
    let nextCharacterIndex = characterIndex + 1;
    if (nextCharacterIndex >= argument.length) {
      nextOptind += 1;
      nextCharacterIndex = 1;
    }

    if (definition < 0) {
      save(nextOptind, nextCharacterIndex);
      context.session.env.set(name, "?");
      if (silent) context.session.env.set("OPTARG", option);
      else {
        context.session.env.delete("OPTARG");
        await writeText(fds[2], `getopts: illegal option -- ${option}\n`);
      }
      return 0;
    }

    if (!requiresArgument) {
      save(nextOptind, nextCharacterIndex);
      context.session.env.set(name, option);
      context.session.env.delete("OPTARG");
      return 0;
    }

    let optionArgument: string | undefined;
    if (characterIndex + 1 < argument.length) {
      optionArgument = argument.slice(characterIndex + 1);
      nextOptind = argumentIndex + 2;
      nextCharacterIndex = 1;
    } else if (args[argumentIndex + 1] !== undefined) {
      optionArgument = args[argumentIndex + 1];
      nextOptind = argumentIndex + 3;
      nextCharacterIndex = 1;
    }
    if (optionArgument !== undefined) {
      save(nextOptind, nextCharacterIndex);
      context.session.env.set(name, option);
      context.session.env.set("OPTARG", optionArgument);
      return 0;
    }

    save(argumentIndex + 2, 1);
    if (silent) {
      context.session.env.set(name, ":");
      context.session.env.set("OPTARG", option);
    } else {
      context.session.env.set(name, "?");
      context.session.env.delete("OPTARG");
      await writeText(fds[2], `getopts: option requires an argument -- ${option}\n`);
    }
    return 0;
  }
});

function defineSourceCommand(name: "source" | ".") {
  return defineCommand(name, async (context, argv, fds) => {
    const [path, ...args] = argv;
    if (path === undefined) throw new VfsError("EINVAL", `${name}: missing file operand`);
    const normalized = commandPath(context, path);
    let source;
    try {
      source = await readFileText(
        context,
        normalized,
        context.budget.limits.maxScriptBytes,
      );
    } catch (error) {
      if (error instanceof VfsError
        && error.code === "E2BIG"
        && error.message === "buffered command input limit exceeded") {
        throw new VfsError("E2BIG", "sourced file exceeds the script byte limit", normalized);
      }
      throw error;
    }
    try {
      if (source.value.includes("\0")) {
        throw new VfsError("EINVAL", "sourced file contains a NUL byte", normalized);
      }
      return await context.executeSource(source.value, normalized, args, fds);
    } finally {
      source.release();
    }
  });
}

export const sourceCommand = /* @__PURE__ */ defineSourceCommand("source");
export const dotCommand = /* @__PURE__ */ defineSourceCommand(".");

export const localCommand = /* @__PURE__ */ defineCommand("local", (context, argv) => {
  const frame = context.session.localFrames.at(-1);
  const getoptsFrame = context.session.localGetoptsFrames.at(-1);
  if (context.session.functionDepth === 0 || frame === undefined || getoptsFrame === undefined) {
    throw new VfsError("EINVAL", "local: can only be used in a function");
  }
  for (const value of argv) {
    const parsed = assignment(value);
    if (!frame.has(parsed.name)) frame.set(parsed.name, context.session.env.get(parsed.name));
    if (parsed.name === "OPTIND" && !getoptsFrame.captured) {
      getoptsFrame.captured = true;
      getoptsFrame.state = context.session.getopts === undefined
        ? undefined
        : { ...context.session.getopts };
    }
    context.session.env.set(parsed.name, value.includes("=") ? parsed.value : "");
  }
  return 0;
});

export const returnCommand = /* @__PURE__ */ defineCommand("return", (context, argv) => {
  if (context.session.functionDepth === 0 && context.session.sourceDepth === 0) {
    throw new VfsError("EINVAL", "return: can only be used in a function or sourced file");
  }
  if (argv.length > 1) throw new VfsError("EINVAL", "return: too many arguments");
  const status = argv[0] === undefined
    ? context.session.lastExitCode
    : parseInteger(argv[0], "return status") & 0xff;
  context.session.flow = { type: "return", status };
  return status;
});

function loopControl(
  name: "break" | "continue",
  context: ShellCommandContext,
  argv: readonly string[],
): number {
  if (context.session.loopDepth === 0) {
    throw new VfsError("EINVAL", `${name}: only meaningful in a loop`);
  }
  if (argv.length > 1) throw new VfsError("EINVAL", `${name}: too many arguments`);
  const requested = argv[0] === undefined ? 1 : parseInteger(argv[0], `${name} level`);
  if (requested <= 0) throw new VfsError("EINVAL", `${name}: level must be positive`);
  context.session.flow = {
    type: name,
    levels: Math.min(requested, context.session.loopDepth),
  };
  return 0;
}

export const breakCommand = /* @__PURE__ */ defineCommand("break", (context, argv) =>
  loopControl("break", context, argv));

export const continueCommand = /* @__PURE__ */ defineCommand("continue", (context, argv) =>
  loopControl("continue", context, argv));

export const exitCommand = /* @__PURE__ */ defineCommand("exit", (context, argv) => {
  if (argv.length > 1) throw new VfsError("EINVAL", "exit: too many arguments");
  const code = argv[0] === undefined ? context.session.lastExitCode : parseInteger(argv[0], "exit status");
  context.session.exitRequested = true;
  context.session.requestedExitCode = code & 0xff;
  return context.session.requestedExitCode;
});

export const setCommand = /* @__PURE__ */ defineCommand("set", (context, argv) => {
  if (argv.length === 0) return 0;
  if (argv.length === 1
    && (argv[0] === "-e" || argv[0] === "+e" || argv[0] === "-u" || argv[0] === "+u")) {
    if (argv[0] === "-e" || argv[0] === "+e") context.session.errexit = argv[0] === "-e";
    else context.session.nounset = argv[0] === "-u";
    return 0;
  }
  if (argv.length === 2 && (argv[0] === "-o" || argv[0] === "+o")) {
    if (argv[1] === "pipefail") context.session.pipefail = argv[0] === "-o";
    else if (argv[1] === "nounset") context.session.nounset = argv[0] === "-o";
    else if (argv[1] === "errexit") context.session.errexit = argv[0] === "-o";
    else throw new VfsError("EINVAL", `set: unsupported option name: ${argv[1]}`);
    return 0;
  }
  throw new VfsError(
    "EINVAL",
    "set: supported forms are -e, +e, -u, +u, -o/+o errexit, -o/+o nounset, or -o/+o pipefail",
  );
});

async function evaluateTest(context: ShellCommandContext, values: readonly string[]): Promise<boolean> {
  if (values.length === 0) return false;
  if (values[0] === "!") return !await evaluateTest(context, values.slice(1));
  if (values.length === 1) return values[0] !== "";
  const unary = values[0];
  const operand = values[1];
  if (values.length === 2 && operand !== undefined) {
    if (unary === "-n") return operand.length > 0;
    if (unary === "-z") return operand.length === 0;
    if (unary === "-e" || unary === "-f" || unary === "-d" || unary === "-s") {
      try {
        const stat = await context.fileSystem.stat(normalizePath(operand, context.session.cwd));
        if (unary === "-e") return true;
        if (unary === "-f") return stat.kind === "file";
        if (unary === "-d") return stat.kind === "directory";
        return stat.sizeBytes > 0;
      } catch (error) {
        if (error instanceof VfsError && error.code === "ENOENT") return false;
        throw error;
      }
    }
  }
  if (values.length === 3) {
    const [left = "", operator = "", right = ""] = values;
    if (operator === "=" || operator === "==") return left === right;
    if (operator === "!=") return left !== right;
    if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(operator)) {
      if (!/^-?[0-9]+$/u.test(left) || !/^-?[0-9]+$/u.test(right)) {
        throw new VfsError("EINVAL", "test: integer expression expected");
      }
      if (operator === "-eq") return Number(left) === Number(right);
      if (operator === "-ne") return Number(left) !== Number(right);
      if (operator === "-lt") return Number(left) < Number(right);
      if (operator === "-le") return Number(left) <= Number(right);
      if (operator === "-gt") return Number(left) > Number(right);
      return Number(left) >= Number(right);
    }
  }
  throw new VfsError("EINVAL", "test: unsupported expression");
}

export const testCommand = /* @__PURE__ */ defineCommand("test", async (context, argv) =>
  await evaluateTest(context, argv) ? 0 : 1);

export const bracketCommand = /* @__PURE__ */ defineCommand("[", async (context, argv) => {
  if (argv.at(-1) !== "]") throw new VfsError("EINVAL", "[: missing ]");
  return await evaluateTest(context, argv.slice(0, -1)) ? 0 : 1;
});
