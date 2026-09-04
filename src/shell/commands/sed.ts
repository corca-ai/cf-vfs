import type { ShellBudget, ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { appletUsageError, defineApplet, parseAppletOptions } from "./applet.js";
import {
  BufferedTextWriter,
  collectText,
  commandPath,
  inputStreams,
  readTextLines,
  writeText,
} from "./helpers.js";
import {
  type SedAddress as Address,
  parseSedScript,
  SED,
  type SedCommand,
  type SedSelector as Selector,
} from "./sed-parser.js";

import { substitute } from "./sed-substitute.js";
import { SedText } from "./sed-text.js";

/** Mutable per-record state for a range selector. */
interface RangeState {
  active: boolean;
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
  const value =
    selector === undefined ? true : selectsWithSelector(selector, state, record, line, last);
  return command.negated ? !value : value;
}

function selectsWithSelector(
  selector: Selector,
  state: RangeState,
  record: string,
  line: number,
  last: boolean,
): boolean {
  if (selector.end === undefined) return matchesAddress(selector.start, record, line, last);
  if (state.active) return continueRange(selector.end, state, record, line, last);
  if (!matchesAddress(selector.start, record, line, last)) return false;
  // The end address is looked for from the next record, so `1,/a/` spans to
  // the second `a` and `2,1` selects one record.
  state.active = selector.end.kind !== "line" || selector.end.line > line;
  return true;
}

function continueRange(
  end: Address,
  state: RangeState,
  record: string,
  line: number,
  last: boolean,
): boolean {
  // A numeric end that is already behind closes the range immediately.
  if (matchesAddress(end, record, line, last) || (end.kind === "line" && line >= end.line)) {
    state.active = false;
  }
  return true;
}

interface RecordResult {
  readonly output: string;
  readonly quit: boolean;
}

interface PatternSpace {
  value: string;
  printed: SedText;
}

function applySelectedCommand(
  command: SedCommand,
  space: PatternSpace,
  quiet: boolean,
  budget: ShellBudget,
): RecordResult | undefined {
  if (command.kind === "d") return { output: space.printed.result(), quit: false };
  if (command.kind === "p") {
    space.printed.append(`${space.value}\n`);
    return undefined;
  }
  if (command.kind === "q") {
    if (!quiet) space.printed.append(`${space.value}\n`);
    return { output: space.printed.result(), quit: true };
  }
  const result = substitute(command, space.value, budget);
  space.value = result.value;
  if (command.print && result.changed) space.printed.append(`${space.value}\n`);
  return undefined;
}

function applyRecord(
  commands: readonly SedCommand[],
  states: RangeState[],
  record: string,
  line: number,
  last: boolean,
  quiet: boolean,
  budget: ShellBudget,
): RecordResult {
  const space: PatternSpace = { value: record, printed: new SedText(budget) };
  for (const [index, command] of commands.entries()) {
    budget.step();
    const state = states[index] ?? { active: false };
    if (!selects(command, state, space.value, line, last)) continue;
    const completed = applySelectedCommand(command, space, quiet, budget);
    if (completed !== undefined) return completed;
  }
  if (!quiet) space.printed.append(`${space.value}\n`);
  return { output: space.printed.result(), quit: false };
}

function needsLastRecord(commands: readonly SedCommand[]): boolean {
  return commands.some(
    (command) => command.selector?.start.kind === "last" || command.selector?.end?.kind === "last",
  );
}

interface SedInvocation {
  readonly commands: readonly SedCommand[];
  readonly operands: readonly string[];
  readonly quiet: boolean;
  readonly inPlace: boolean;
  readonly budget: ShellBudget;
}

function parseInvocation(argv: readonly string[], budget: ShellBudget): SedInvocation {
  const parsed = parseAppletOptions(SED, argv);
  const quiet = parsed.options.some((option) => option.name === "quiet");
  const dialect = parsed.options.some((option) => option.name === "extended")
    ? "extended"
    : "basic";
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
  if (inPlace && operands.length === 0) throw appletUsageError(SED, "-i requires a file operand");
  return {
    commands: parseSedScript(expressions.join("\n"), dialect),
    operands,
    quiet,
    inPlace,
    budget,
  };
}

async function editOperands(
  context: ShellCommandContext,
  invocation: SedInvocation,
  fds: ShellFileDescriptors,
): Promise<number> {
  let failed = false;
  for (const path of invocation.operands) {
    try {
      if (await editInPlace(context, invocation.commands, path, invocation.quiet)) break;
    } catch (error) {
      // One bad operand is that operand's failure. Remaining files are still
      // edited, each under its own mutation token.
      await writeText(
        fds[2],
        `sed: ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      failed = true;
    }
  }
  return failed ? 2 : 0;
}

async function streamRecords(
  context: ShellCommandContext,
  invocation: SedInvocation,
  fds: ShellFileDescriptors,
  output: BufferedTextWriter,
): Promise<void> {
  const states: RangeState[] = invocation.commands.map(() => ({ active: false }));
  const inputCount = Math.max(1, invocation.operands.length);
  let inputIndex = 0;
  let line = 0;
  inputLoop: for await (const input of inputStreams(context, invocation.operands, fds[0])) {
    inputIndex += 1;
    const lastInput = inputIndex === inputCount;
    for await (const record of readTextLines(context, input.stream, input.name)) {
      const terminated = record.endsWith("\n");
      const value = terminated ? record.slice(0, -1) : record;
      line += 1;
      const result = applyRecord(
        invocation.commands,
        states,
        value,
        line,
        false,
        invocation.quiet,
        invocation.budget,
      );
      // `q` terminates the pattern space even when the input did not. Ordinary
      // end-of-input retains the source's missing newline.
      const preserveEnding = terminated || result.quit || !lastInput;
      await output.write(preserveEnding ? result.output : result.output.replace(/\n$/u, ""));
      if (result.quit) break inputLoop;
    }
  }
}

async function streamRecordsWithLast(
  context: ShellCommandContext,
  invocation: SedInvocation,
  fds: ShellFileDescriptors,
  output: BufferedTextWriter,
): Promise<void> {
  const states: RangeState[] = invocation.commands.map(() => ({ active: false }));
  let pending: string | undefined;
  let pendingEndedWithNewline = true;
  let line = 0;
  inputLoop: for await (const input of inputStreams(context, invocation.operands, fds[0])) {
    for await (const record of readTextLines(context, input.stream, input.name)) {
      const terminated = record.endsWith("\n");
      const value = terminated ? record.slice(0, -1) : record;
      if (pending !== undefined) {
        line += 1;
        if (await writePendingRecord(invocation, states, pending, line, output)) {
          pending = undefined;
          break inputLoop;
        }
      }
      pending = value;
      pendingEndedWithNewline = terminated;
    }
  }
  await writeFinalRecord(invocation, states, pending, line + 1, pendingEndedWithNewline, output);
}

async function writePendingRecord(
  invocation: SedInvocation,
  states: RangeState[],
  pending: string,
  line: number,
  output: BufferedTextWriter,
): Promise<boolean> {
  const result = applyRecord(
    invocation.commands,
    states,
    pending,
    line,
    false,
    invocation.quiet,
    invocation.budget,
  );
  await output.write(result.output);
  return result.quit;
}

async function writeFinalRecord(
  invocation: SedInvocation,
  states: RangeState[],
  pending: string | undefined,
  line: number,
  terminated: boolean,
  output: BufferedTextWriter,
): Promise<void> {
  if (pending === undefined) return;
  const result = applyRecord(
    invocation.commands,
    states,
    pending,
    line,
    true,
    invocation.quiet,
    invocation.budget,
  );
  // An unterminated final record stays unterminated.
  await output.write(terminated ? result.output : result.output.replace(/\n$/u, ""));
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
  const invocation = parseInvocation(argv, context.budget);
  if (invocation.inPlace) return editOperands(context, invocation, fds);
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    // Numbering and `$` span the operands as one stream, the way `sed` reads
    // them: `$` is the last record of the last file, not of each file.
    if (needsLastRecord(invocation.commands)) {
      await streamRecordsWithLast(context, invocation, fds, output);
    } else await streamRecords(context, invocation, fds, output);
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
): Promise<boolean> {
  const normalized = commandPath(context, path);
  const current = context.fileSystem.readFile(normalized);
  const token =
    current.stat.path === normalized
      ? current.stat.mutationToken
      : context.fileSystem.getMutationToken(normalized);
  const source = await collectText(context, current.stream, normalized);
  let edited: { output: string; quit: boolean };
  try {
    edited = applyToText(commands, source.value, quiet, context.budget);
  } finally {
    source.release();
  }
  // The edit is either the whole new file or nothing, and a concurrent write
  // to the same path loses.
  await context.fileSystem.writeFile(normalized, edited.output, {
    ifMutationToken: token,
    disposition: "replace",
    mode: current.stat.mode,
  });
  return edited.quit;
}

/** Applies the script to a whole buffered text, for `-i`. */
function applyToText(
  commands: readonly SedCommand[],
  text: string,
  quiet: boolean,
  budget: ShellBudget,
): { output: string; quit: boolean } {
  const states: RangeState[] = commands.map(() => ({ active: false }));
  const records = text.split("\n");
  // A trailing newline produces a final empty element that is not a record.
  const trailing = records.at(-1) === "";
  if (trailing) records.pop();
  const output = new SedText(budget, budget.limits.maxBufferedBytes);
  let quit = false;
  for (const [index, record] of records.entries()) {
    const last = index === records.length - 1;
    const result = applyRecord(commands, states, record, index + 1, last, quiet, budget);
    // An unterminated final record stays unterminated, and only that record's
    // own output loses a newline: a `d` on the last line must not strip the
    // newline that belonged to the line before it.
    output.append(
      last && !trailing && !result.quit ? result.output.replace(/\n$/u, "") : result.output,
    );
    if (result.quit) {
      quit = true;
      break;
    }
  }
  return { output: output.result(), quit };
}
