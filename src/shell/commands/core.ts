import { VfsError } from "../../core/errors.js";
import { normalizePath } from "../../core/path.js";
import type { ShellCommandContext } from "../types.js";
import { defineCommand, parseInteger, writeText } from "./helpers.js";

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

export const exitCommand = /* @__PURE__ */ defineCommand("exit", (context, argv) => {
  if (argv.length > 1) throw new VfsError("EINVAL", "exit: too many arguments");
  const code = argv[0] === undefined ? context.session.lastExitCode : parseInteger(argv[0], "exit status");
  context.session.exitRequested = true;
  context.session.requestedExitCode = code & 0xff;
  return context.session.requestedExitCode;
});

export const setCommand = /* @__PURE__ */ defineCommand("set", (context, argv) => {
  if (argv.length === 0) return 0;
  if (argv.length === 2 && argv[1] === "pipefail" && (argv[0] === "-o" || argv[0] === "+o")) {
    context.session.pipefail = argv[0] === "-o";
    return 0;
  }
  throw new VfsError("EINVAL", "set: only -o pipefail and +o pipefail are supported");
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
