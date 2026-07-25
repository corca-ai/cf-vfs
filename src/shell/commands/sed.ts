import { compilePosixRegex, type PosixMatch, type PosixRegex } from "../../core/posix-regex.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import {
  BufferedTextWriter,
  commandPath,
  inputStreams,
  readFileText,
  readTextLines,
  writeText,
} from "./helpers.js";

const SED = {
  name: "sed",
  usage: "[-n] [-i] [-e SCRIPT] [SCRIPT] [FILE...]",
  summary: "edits records with a bounded subset of the sed language",
  options: {
    short: {
      n: { name: "quiet" },
      i: { name: "in-place" },
      e: { name: "expression", argument: true },
    },
    long: {
      quiet: { name: "quiet" },
      "in-place": { name: "in-place" },
      expression: { name: "expression", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<"quiet" | "in-place" | "expression">;

/**
 * A record selector.
 *
 * `last` needs one record of lookahead and nothing more, so the profile stays
 * streaming: no command here can require a record other than the current one.
 */
type Address =
  | { readonly kind: "line"; readonly line: number }
  | { readonly kind: "last" }
  | { readonly kind: "regex"; readonly pattern: PosixRegex };

interface Selector {
  readonly start: Address;
  /** Present for a two-address range. */
  readonly end?: Address;
}

interface Substitute {
  readonly kind: "s";
  readonly pattern: PosixRegex;
  readonly replacement: string;
  readonly global: boolean;
  readonly print: boolean;
  /** Replace only the Nth match, when given. */
  readonly occurrence: number;
}

interface Selected {
  readonly selector?: Selector;
  /** Set by a leading `!`, which inverts the selection. */
  readonly negated: boolean;
}

type SedCommand =
  | (Substitute & Selected)
  | ({ readonly kind: "p" } & Selected)
  | ({ readonly kind: "d" } & Selected);

/** Mutable per-record state for a range selector. */
interface RangeState {
  active: boolean;
}

const ADDRESS_START = /^(?:[0-9]+|\$|\/)/u;

function readDelimited(script: string, start: number, delimiter: string): [string, number] {
  let value = "";
  let index = start;
  while (index < script.length) {
    const character = script[index] ?? "";
    if (character === "\\" && script[index + 1] !== undefined) {
      const next = script[index + 1] ?? "";
      // A backslash before the delimiter escapes it; everything else stays as
      // written so the regular-expression translator sees the same text sed did.
      value += next === delimiter ? next : `\\${next}`;
      index += 2;
      continue;
    }
    if (character === delimiter) return [value, index + 1];
    value += character;
    index += 1;
  }
  throw appletUsageError(SED, "unterminated expression");
}

function parseAddress(script: string, start: number): [Address, number] {
  const character = script[start] ?? "";
  if (character === "$") return [{ kind: "last" }, start + 1];
  if (character === "/") {
    const [pattern, next] = readDelimited(script, start + 1, "/");
    return [{ kind: "regex", pattern: compilePosixRegex(pattern, "basic", SED.name) }, next];
  }
  const digits = /^[0-9]+/u.exec(script.slice(start))?.[0] ?? "";
  const line = Number(digits);
  if (digits === "" || !Number.isSafeInteger(line) || line === 0) {
    throw appletUsageError(SED, "invalid address");
  }
  return [{ kind: "line", line }, start + digits.length];
}

/**
 * Parses one bounded sed script.
 *
 * The declared subset is `s`, `p`, and `d`, each optionally selected by a line
 * number, `$`, a regular expression, or a two-address range, and optionally
 * negated with `!`. Everything else — hold space, branching, labels, `a`, `i`,
 * `c`, `y`, `r`, `w` — is refused with a usage error, because a partial
 * implementation of a language is worse than a command that says no.
 */
function parseSedScript(script: string): SedCommand[] {
  const commands: SedCommand[] = [];
  let index = 0;
  while (index < script.length) {
    const character = script[index] ?? "";
    if (character === ";" || character === "\n" || character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (character === "#") {
      const newline = script.indexOf("\n", index);
      index = newline < 0 ? script.length : newline + 1;
      continue;
    }
    let selector: Selector | undefined;
    if (ADDRESS_START.test(script.slice(index))) {
      const [start, afterStart] = parseAddress(script, index);
      index = afterStart;
      if (script[index] === ",") {
        const [end, afterEnd] = parseAddress(script, index + 1);
        index = afterEnd;
        selector = { start, end };
      } else {
        selector = { start };
      }
    }
    let negated = false;
    while (script[index] === "!") {
      negated = !negated;
      index += 1;
    }
    const verb = script[index];
    if (verb === "s") {
      const delimiter = script[index + 1];
      if (delimiter === undefined || /[\\\n]/u.test(delimiter)) {
        throw appletUsageError(SED, "invalid s delimiter");
      }
      const [pattern, afterPattern] = readDelimited(script, index + 2, delimiter);
      const [replacement, afterReplacement] = readDelimited(script, afterPattern, delimiter);
      index = afterReplacement;
      let global = false;
      let print = false;
      let ignoreCase = false;
      let occurrence = 0;
      for (; index < script.length; index += 1) {
        const flag = script[index] ?? "";
        if (flag === "g") global = true;
        else if (flag === "p") print = true;
        else if (flag === "I" || flag === "i") ignoreCase = true;
        else if (/[0-9]/u.test(flag)) {
          const digits = /^[0-9]+/u.exec(script.slice(index))?.[0] ?? "";
          occurrence = Number(digits);
          if (occurrence === 0) throw appletUsageError(SED, "s occurrence must be positive");
          index += digits.length - 1;
        } else break;
      }
      commands.push({
        kind: "s",
        pattern: compilePosixRegex(pattern, "basic", SED.name, {
          ...(ignoreCase ? { ignoreCase: true } : {}),
        }),
        replacement,
        global,
        print,
        occurrence,
        negated,
        ...(selector === undefined ? {} : { selector }),
      });
      continue;
    }
    if (verb === "p" || verb === "d") {
      index += 1;
      const selected = { negated, ...(selector === undefined ? {} : { selector }) };
      commands.push(verb === "p" ? { kind: "p", ...selected } : { kind: "d", ...selected });
      continue;
    }
    throw appletUsageError(SED, `unsupported command ${verb ?? "at end of script"}`);
  }
  if (commands.length === 0) throw appletUsageError(SED, "empty script");
  return commands;
}

function matchesAddress(address: Address, record: string, line: number, last: boolean): boolean {
  if (address.kind === "line") return line === address.line;
  if (address.kind === "last") return last;
  return address.pattern.test(record);
}

function selects(
  command: SedCommand,
  state: RangeState,
  record: string,
  line: number,
  last: boolean,
): boolean {
  const selector = command.selector;
  let value: boolean;
  if (selector === undefined) value = true;
  else if (selector.end === undefined) {
    value = matchesAddress(selector.start, record, line, last);
  } else if (state.active) {
    value = true;
    // A numeric end that is already behind closes the range immediately.
    if (matchesAddress(selector.end, record, line, last)) state.active = false;
    else if (selector.end.kind === "line" && line >= selector.end.line) state.active = false;
  } else if (matchesAddress(selector.start, record, line, last)) {
    value = true;
    // The end address is looked for from the *next* record, so `1,/a/` spans
    // to the second `a` and `2,1` selects one record. Testing the end here
    // would close the range on the record that opened it.
    state.active = selector.end.kind === "line" ? selector.end.line > line : true;
  } else value = false;
  return command.negated ? !value : value;
}

/**
 * Applies the replacement literally.
 *
 * `&` is the whole match and `\1`…`\9` are capture groups, as in sed. Every
 * other character is written as-is, and JavaScript's `$` substitution syntax is
 * escaped away so replacement text taken from data can never splice another
 * part of the record into the output.
 */
function expandReplacement(replacement: string, match: PosixMatch): string {
  let output = "";
  for (let index = 0; index < replacement.length; index += 1) {
    const character = replacement[index] ?? "";
    if (character === "&") {
      output += match.groups[0] ?? "";
      continue;
    }
    if (character === "\\") {
      const next = replacement[++index];
      if (next === undefined) break;
      if (/[1-9]/u.test(next)) output += match.groups[Number(next)] ?? "";
      else if (next === "n") output += "\n";
      else if (next === "t") output += "\t";
      else output += next;
      continue;
    }
    output += character;
  }
  return output;
}

function substitute(command: Substitute, record: string): { value: string; changed: boolean } {
  const pattern = command.pattern;
  if (!command.global && command.occurrence === 0) {
    const match = pattern.exec(record);
    if (match === undefined) return { value: record, changed: false };
    return {
      value:
        record.slice(0, match.index) +
        expandReplacement(command.replacement, match) +
        record.slice(match.end),
      changed: true,
    };
  }
  let output = "";
  let last = 0;
  let seen = 0;
  let changed = false;
  let previousEnd = -1;
  for (let from = 0; from <= record.length; ) {
    const match = pattern.exec(record, from);
    if (match === undefined) break;
    // An empty match touching the end of the previous one is not a separate
    // occurrence: `s/a*/-/g` on `baaac` gives `-b-c-`, not `-b--c-`.
    if (match.index === match.end && match.index === previousEnd) {
      from = match.end + 1;
      continue;
    }
    seen += 1;
    const replace = command.occurrence === 0 || seen >= command.occurrence;
    if (replace) {
      output += record.slice(last, match.index) + expandReplacement(command.replacement, match);
      last = match.end;
      changed = true;
      if (command.occurrence > 0 && !command.global) break;
    }
    previousEnd = match.end;
    // A zero-width match would otherwise never advance.
    from = match.end === match.index ? match.end + 1 : match.end;
  }
  return { value: output + record.slice(last), changed };
}

interface RecordResult {
  readonly output: string;
  readonly deleted: boolean;
}

function applyRecord(
  commands: readonly SedCommand[],
  states: RangeState[],
  record: string,
  line: number,
  last: boolean,
  quiet: boolean,
): RecordResult {
  let space = record;
  let printed = "";
  for (const [index, command] of commands.entries()) {
    const state = states[index] ?? { active: false };
    if (!selects(command, state, space, line, last)) continue;
    if (command.kind === "d") return { output: printed, deleted: true };
    if (command.kind === "p") {
      printed += `${space}\n`;
      continue;
    }
    const result = substitute(command, space);
    space = result.value;
    if (command.print && result.changed) printed += `${space}\n`;
  }
  return { output: quiet ? printed : `${printed}${space}\n`, deleted: false };
}

/**
 * Edits records with a bounded subset of the sed language.
 *
 * Every command in the profile reads only the current record, so ordinary
 * operation streams: nothing is materialized but one record and, for `$`, one
 * record of lookahead. `-i` is the exception by necessity — it publishes one
 * guarded whole-file write rather than a visible temporary file, so a
 * concurrent change loses rather than interleaves.
 */
export const sedCommand = /* @__PURE__ */ defineApplet(SED, async (context, argv, fds) => {
  const parsed = parseAppletOptions(SED, argv);
  const quiet = parsed.options.some((option) => option.name === "quiet");
  const inPlace = parsed.options.some((option) => option.name === "in-place");
  const expressions = parsed.options
    .filter((option) => option.name === "expression" && "argument" in option)
    .map((option) => ("argument" in option ? option.argument : ""));
  const operands = [...parsed.operands];
  if (expressions.length === 0) {
    const script = operands.shift();
    if (script === undefined) throw appletUsageError(SED, "missing expression");
    expressions.push(script);
  }
  const commands = parseSedScript(expressions.join("\n"));
  if (inPlace && operands.length === 0) {
    throw appletUsageError(SED, "-i requires a file operand");
  }

  const output = new BufferedTextWriter(context, fds[1]);
  try {
    if (inPlace) {
      let failed = false;
      for (const path of operands) {
        try {
          await editInPlace(context, commands, path, quiet);
        } catch (error) {
          // One bad operand is that operand's failure. The remaining files are
          // still edited, each under its own mutation token, and the status
          // says something went wrong.
          await writeText(
            fds[2],
            `sed: ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          failed = true;
        }
      }
      return failed ? 2 : 0;
    }
    const states: RangeState[] = commands.map(() => ({ active: false }));
    // Numbering and `$` span the operands as one stream, the way `sed` reads
    // them: `$` is the last record of the last file, not of each file.
    let line = 0;
    let pending: string | undefined;
    let pendingEndedWithNewline = true;
    for await (const input of inputStreams(context, operands, fds[0])) {
      for await (const record of readTextLines(context, input.stream, input.name)) {
        const terminated = record.endsWith("\n");
        const value = terminated ? record.slice(0, -1) : record;
        if (pending !== undefined) {
          line += 1;
          await output.write(applyRecord(commands, states, pending, line, false, quiet).output);
        }
        pending = value;
        pendingEndedWithNewline = terminated;
      }
    }
    if (pending !== undefined) {
      line += 1;
      const result = applyRecord(commands, states, pending, line, true, quiet).output;
      // An unterminated final record stays unterminated: `sed` does not add a
      // newline the input did not have.
      await output.write(pendingEndedWithNewline ? result : result.replace(/\n$/u, ""));
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

/** Rewrites one file in place, as a single guarded publication. */
async function editInPlace(
  context: ShellCommandContext,
  commands: readonly SedCommand[],
  path: string,
  quiet: boolean,
): Promise<void> {
  const normalized = commandPath(context, path);
  const token = context.fileSystem.getMutationToken(normalized);
  // `stat`, not `readFile`: an inline read acquires an in-flight byte lease
  // that is released only when its stream is consumed, and this needs the
  // mode, not the bytes. Taking one here would leak the filesystem-wide
  // budget on every edit.
  const mode = context.fileSystem.stat(normalized).mode;
  const source = await readFileText(context, path);
  let edited: string;
  try {
    edited = applyToText(commands, source.value, quiet);
  } finally {
    source.release();
  }
  // The edit is either the whole new file or nothing, and a concurrent write
  // to the same path loses.
  await context.fileSystem.writeFile(normalized, edited, {
    ifMutationToken: token,
    disposition: "replace",
    mode,
  });
}

/** Applies the script to a whole buffered text, for `-i`. */
function applyToText(commands: readonly SedCommand[], text: string, quiet: boolean): string {
  const states: RangeState[] = commands.map(() => ({ active: false }));
  const records = text.split("\n");
  // A trailing newline produces a final empty element that is not a record.
  const trailing = records.at(-1) === "";
  if (trailing) records.pop();
  let output = "";
  for (const [index, record] of records.entries()) {
    const last = index === records.length - 1;
    const piece = applyRecord(commands, states, record, index + 1, last, quiet).output;
    // An unterminated final record stays unterminated, and only that record's
    // own output loses a newline: a `d` on the last line must not strip the
    // newline that belonged to the line before it.
    output += last && !trailing ? piece.replace(/\n$/u, "") : piece;
  }
  return output;
}
