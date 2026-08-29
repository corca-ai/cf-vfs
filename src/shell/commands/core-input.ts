import { VfsError } from "../../core/errors.js";
import { utf8ByteLength } from "../../core/unicode.js";
import { optindGeneration, setOptindFromGetopts } from "../environment.js";
import { readInputRecord } from "../input.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { type AppletSpec, appletUsageError, defineApplet } from "./applet.js";
import { parseInteger, writeText } from "./helpers.js";

const READ = {
  name: "read",
  usage: "[-r] [--] [NAME...]",
  summary: "reads one record from standard input",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const SHIFT = {
  name: "shift",
  usage: "[COUNT]",
  summary: "drops leading positional parameters",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const GETOPTS = {
  name: "getopts",
  usage: "OPTSTRING NAME [ARGUMENT...]",
  summary: "parses one option from the positional parameters",
  kind: "session-builtin",
} as const satisfies AppletSpec;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const READ_IFS = /[ \t\n]/u;

interface ReadOptions {
  names: string[];
  reply: boolean;
  raw: boolean;
}

interface EscapedReadValue {
  value: string;
  escapedIfs: ReadonlySet<number>;
  continued: boolean;
}

interface ReadRecord {
  value: string;
  escapedIfs: ReadonlySet<number>;
  terminated: boolean;
}

interface Assignment {
  name: string;
  value: string;
}

function readOptions(argv: readonly string[]): ReadOptions {
  let offset = 0;
  const raw = argv[offset] === "-r";
  if (raw) offset += 1;
  if (argv[offset] === "--") offset += 1;
  const unsupported = argv[offset]?.startsWith("-") === true ? argv[offset] : undefined;
  if (unsupported !== undefined) throw appletUsageError(READ, `unsupported option ${unsupported}`);
  const operands = argv.slice(offset);
  const names = operands.length === 0 ? ["REPLY"] : [...operands];
  for (const name of names) {
    if (!VARIABLE_NAME.test(name)) throw appletUsageError(READ, `invalid variable name: ${name}`);
  }
  return { names, reply: operands.length === 0, raw };
}

function decodeReadRecord(value: string): EscapedReadValue {
  let output = "";
  const escapedIfs = new Set<number>();
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      output += character;
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) return { value: output, escapedIfs, continued: true };
    if (READ_IFS.test(escaped)) escapedIfs.add(output.length);
    output += escaped;
  }
  return { value: output, escapedIfs, continued: false };
}

function appendReadPart(
  target: { value: string; escapedIfs: Set<number> },
  decoded: EscapedReadValue,
): void {
  const base = target.value.length;
  target.value += decoded.value;
  for (const offset of decoded.escapedIfs) target.escapedIfs.add(base + offset);
}

async function readEscapedRecord(
  fds: ShellFileDescriptors,
  context: ShellCommandContext,
): Promise<ReadRecord> {
  const result = { value: "", escapedIfs: new Set<number>() };
  let retainedBytes = 0;
  let release: () => void = () => undefined;
  try {
    while (true) {
      const record = await readInputRecord(fds[0], context.budget, context.signal);
      const decoded = decodeReadRecord(record.value);
      retainedBytes += utf8ByteLength(decoded.value);
      if (retainedBytes > context.budget.limits.maxLineBytes) {
        throw new VfsError("E2BIG", "read: logical line byte limit exceeded");
      }
      release();
      release = context.budget.buffered(retainedBytes);
      appendReadPart(result, decoded);
      if (!decoded.continued || !record.terminated) {
        return { ...result, terminated: record.terminated };
      }
    }
  } finally {
    release();
  }
}

function skipDelimiters(
  value: string,
  offset: number,
  delimiter: (offset: number) => boolean,
): number {
  while (offset < value.length && delimiter(offset)) offset += 1;
  return offset;
}

function readAssignments(
  value: string,
  names: readonly string[],
  reply: boolean,
  delimiter: (offset: number) => boolean,
): Assignment[] {
  if (reply) return [{ name: "REPLY", value }];
  const assignments: Assignment[] = [];
  let offset = skipDelimiters(value, 0, delimiter);
  for (const [index, name] of names.entries()) {
    if (index === names.length - 1) {
      let end = value.length;
      while (end > offset && delimiter(end - 1)) end -= 1;
      assignments.push({ name, value: value.slice(offset, end) });
      break;
    }
    let end = offset;
    while (end < value.length && !delimiter(end)) end += 1;
    assignments.push({ name, value: value.slice(offset, end) });
    offset = skipDelimiters(value, end, delimiter);
  }
  return assignments;
}

async function readValues(
  context: ShellCommandContext,
  fds: ShellFileDescriptors,
  options: ReadOptions,
): Promise<{ assignments: Assignment[]; terminated: boolean }> {
  if (options.raw) {
    const record = await readInputRecord(fds[0], context.budget, context.signal);
    const delimiter = (offset: number): boolean => READ_IFS.test(record.value[offset] ?? "");
    return {
      assignments: readAssignments(record.value, options.names, options.reply, delimiter),
      terminated: record.terminated,
    };
  }
  const record = await readEscapedRecord(fds, context);
  const delimiter = (offset: number): boolean =>
    !record.escapedIfs.has(offset) && READ_IFS.test(record.value[offset] ?? "");
  return {
    assignments: readAssignments(record.value, options.names, options.reply, delimiter),
    terminated: record.terminated,
  };
}

export const readCommand = /* @__PURE__ */ defineApplet(READ, async (context, argv, fds) => {
  const result = await readValues(context, fds, readOptions(argv));
  for (const assignment of result.assignments) {
    context.session.env.set(assignment.name, assignment.value);
  }
  return result.terminated ? 0 : 1;
});

export const shiftCommand = /* @__PURE__ */ defineApplet(SHIFT, (context, argv) => {
  if (argv.length > 1) throw appletUsageError(SHIFT, "too many arguments");
  const count = argv[0] === undefined ? 1 : parseInteger(argv[0], `${SHIFT.name}: count`);
  if (count > context.session.args.length) return 1;
  context.session.args.splice(0, count);
  return 0;
});

function validateGetoptsSpec(optstring: string, name: string): void {
  if (!VARIABLE_NAME.test(name)) throw appletUsageError(GETOPTS, `invalid variable name: ${name}`);
  const specification = optstring.startsWith(":") ? optstring.slice(1) : optstring;
  for (let index = 0; index < specification.length; index += 1) {
    const option = specification[index] ?? "";
    if (option === ":" || option === "?" || option === "-") {
      throw appletUsageError(GETOPTS, `invalid option specification: ${option}`);
    }
    if (specification[index + 1] === ":") index += 1;
  }
}

class GetoptsReader {
  private argumentIndex: number;
  private characterIndex: number;
  private readonly silent: boolean;
  private readonly specification: string;

  constructor(
    private readonly context: ShellCommandContext,
    private readonly args: readonly string[],
    private readonly name: string,
    optstring: string,
    optind: number,
    private readonly fds: ShellFileDescriptors,
  ) {
    this.argumentIndex = optind - 1;
    const previous = context.session.getopts;
    this.characterIndex =
      previous !== undefined &&
      previous.optind === optind &&
      previous.optindGeneration === optindGeneration(context.session.env)
        ? previous.characterIndex
        : 1;
    this.silent = optstring.startsWith(":");
    this.specification = this.silent ? optstring.slice(1) : optstring;
  }

  private save(nextOptind: number, nextCharacterIndex: number): void {
    setOptindFromGetopts(this.context.session.env, String(nextOptind));
    this.context.session.getopts = {
      optind: nextOptind,
      characterIndex: nextCharacterIndex,
      optindGeneration: optindGeneration(this.context.session.env),
    };
  }

  private finish(nextOptind: number): number {
    this.save(nextOptind, 1);
    this.context.session.env.set(this.name, "?");
    this.context.session.env.delete("OPTARG");
    return 1;
  }

  private nextPosition(argument: string): { optind: number; character: number } {
    const character = this.characterIndex + 1;
    return character >= argument.length
      ? { optind: this.argumentIndex + 2, character: 1 }
      : { optind: this.argumentIndex + 1, character };
  }

  private async invalidOption(option: string, next: { optind: number; character: number }) {
    this.save(next.optind, next.character);
    this.context.session.env.set(this.name, "?");
    if (this.silent) this.context.session.env.set("OPTARG", option);
    else {
      this.context.session.env.delete("OPTARG");
      await writeText(this.fds[2], `getopts: illegal option -- ${option}\n`);
    }
    return 0;
  }

  private optionArgument(argument: string): { value?: string; optind: number } {
    if (this.characterIndex + 1 < argument.length) {
      return { value: argument.slice(this.characterIndex + 1), optind: this.argumentIndex + 2 };
    }
    const value = this.args[this.argumentIndex + 1];
    return value === undefined
      ? { optind: this.argumentIndex + 2 }
      : { value, optind: this.argumentIndex + 3 };
  }

  private async missingArgument(option: string): Promise<number> {
    this.save(this.argumentIndex + 2, 1);
    if (this.silent) {
      this.context.session.env.set(this.name, ":");
      this.context.session.env.set("OPTARG", option);
    } else {
      this.context.session.env.set(this.name, "?");
      this.context.session.env.delete("OPTARG");
      await writeText(this.fds[2], `getopts: option requires an argument -- ${option}\n`);
    }
    return 0;
  }

  private async consume(argument: string): Promise<number> {
    const option = argument[this.characterIndex] ?? "";
    const definition = option === ":" ? -1 : this.specification.indexOf(option);
    const next = this.nextPosition(argument);
    if (definition < 0) return this.invalidOption(option, next);
    if (this.specification[definition + 1] !== ":") {
      this.save(next.optind, next.character);
      this.context.session.env.set(this.name, option);
      this.context.session.env.delete("OPTARG");
      return 0;
    }
    const argumentValue = this.optionArgument(argument);
    if (argumentValue.value === undefined) return this.missingArgument(option);
    this.save(argumentValue.optind, 1);
    this.context.session.env.set(this.name, option);
    this.context.session.env.set("OPTARG", argumentValue.value);
    return 0;
  }

  async next(): Promise<number> {
    while (true) {
      const argument = this.args[this.argumentIndex];
      if (argument === undefined || argument === "-" || !argument.startsWith("-")) {
        return this.finish(this.argumentIndex + 1);
      }
      if (argument === "--") return this.finish(this.argumentIndex + 2);
      if (this.characterIndex < argument.length) return this.consume(argument);
      this.argumentIndex += 1;
      this.characterIndex = 1;
    }
  }
}

export const getoptsCommand = /* @__PURE__ */ defineApplet(GETOPTS, async (context, argv, fds) => {
  if (argv.length < 2) throw appletUsageError(GETOPTS, "expected optstring and variable name");
  const [optstring = "", name = "", ...explicitArgs] = argv;
  validateGetoptsSpec(optstring, name);
  const args = explicitArgs.length === 0 ? context.session.args : explicitArgs;
  const optind = parseInteger(context.session.env.get("OPTIND") ?? "1", "getopts: OPTIND", 1);
  return new GetoptsReader(context, args, name, optstring, optind, fds).next();
});
