import { VfsError } from "../../core/errors.js";
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
  type SedSubstitute,
  type SedSelector as Selector,
} from "./sed-parser.js";

import { substitute } from "./sed-substitute.js";
import { SedText } from "./sed-text.js";

/** Mutable per-record state for a range selector. */
interface RangeState {
  active: boolean;
  /** Whether the range ended on the record that was just selected, for `c`. */
  ended: boolean;
}

function matchesAddress(address: Address, record: string, line: number, last: boolean): boolean {
  if (address.kind === "line") return line === address.line;
  if (address.kind === "last") return last;
  return address.pattern.test(record);
}

function selectsWithSelector(
  selector: Selector,
  state: RangeState,
  record: string,
  line: number,
  last: boolean,
): boolean {
  state.ended = false;
  if (selector.end === undefined) return matchesAddress(selector.start, record, line, last);
  if (state.active) return continueRange(selector.end, state, record, line, last);
  if (!matchesAddress(selector.start, record, line, last)) return false;
  // The end address is looked for from the next record, so `1,/a/` spans to
  // the second `a` and `2,1` selects one record.
  state.active = selector.end.kind !== "line" || selector.end.line > line;
  state.ended = !state.active;
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
    state.ended = true;
  }
  return true;
}

interface SedRecord {
  readonly value: string;
  readonly terminated: boolean;
}

/** Input records with one record of lookahead, which `$` needs. */
interface RecordSource {
  next(): Promise<SedRecord | undefined>;
  isLast(): Promise<boolean>;
}

class PeekingSource implements RecordSource {
  private peeked: SedRecord | undefined | null = null;

  constructor(private readonly records: AsyncIterator<SedRecord>) {}

  async next(): Promise<SedRecord | undefined> {
    if (this.peeked !== null) {
      const record = this.peeked;
      this.peeked = null;
      return record;
    }
    return (await this.records.next()).value ?? undefined;
  }

  async isLast(): Promise<boolean> {
    if (this.peeked === null) this.peeked = (await this.records.next()).value ?? undefined;
    return this.peeked === undefined;
  }

  /** Stops reading, so `q` cancels its input rather than draining it. */
  async close(): Promise<void> {
    await this.records.return?.(undefined);
  }
}

function toRecord(line: string): SedRecord {
  const terminated = line.endsWith("\n");
  return { value: terminated ? line.slice(0, -1) : line, terminated };
}

async function* streamedRecords(
  context: ShellCommandContext,
  operands: readonly string[],
  stdin: ShellFileDescriptors[0],
): AsyncGenerator<SedRecord> {
  // Numbering and `$` span the operands as one stream, the way `sed` reads
  // them: `$` is the last record of the last file, not of each file.
  for await (const input of inputStreams(context, operands, stdin)) {
    for await (const line of readTextLines(context, input.stream, input.name)) {
      yield toRecord(line);
    }
  }
}

async function* textRecords(text: string): AsyncGenerator<SedRecord> {
  const lines = text.split("\n");
  // A trailing newline produces a final empty element that is not a record.
  const trailing = lines.at(-1) === "";
  if (trailing) lines.pop();
  for (const [index, value] of lines.entries()) {
    yield { value, terminated: index < lines.length - 1 || trailing };
  }
}

/**
 * Output that holds back its final newline, so an unterminated last input
 * record stays unterminated while every earlier line keeps its newline.
 */
class SedOutput {
  private held = false;
  /** Whether the held newline ended a pattern space printed in the current cycle. */
  private heldPatternSpace = false;

  constructor(private readonly write: (text: string) => void | Promise<void>) {}

  beginCycle(): void {
    this.heldPatternSpace = false;
  }

  async emit(text: string, patternSpace: boolean): Promise<void> {
    if (text === "") return;
    const body = this.held ? `\n${text}` : text;
    this.held = body.endsWith("\n");
    this.heldPatternSpace = this.held && patternSpace;
    await this.write(this.held ? body.slice(0, -1) : body);
  }

  /**
   * Only the last record's pattern space loses its newline when that record
   * had none: `$d` keeps the line before, and `a` text is always terminated.
   */
  async finish(lastTerminated: boolean): Promise<void> {
    if (this.held && (lastTerminated || !this.heldPatternSpace)) await this.write("\n");
    this.held = false;
  }
}

/** How an instruction changes control: continue, jump, end the cycle, or quit. */
type SedAction =
  | undefined
  | { readonly jump: number }
  | { readonly end: "print" | "delete" | "restart" }
  | { readonly quit: "print" | "silent" };

interface SedInvocation {
  readonly commands: readonly SedCommand[];
  readonly operands: readonly string[];
  readonly quiet: boolean;
  readonly inPlace: boolean;
  readonly budget: ShellBudget;
}

/**
 * Runs a compiled script over a record source: one cycle per input record,
 * with the pattern space, the hold space, the `t` flag and the queue of
 * appended text that GNU sed keeps.
 */
class SedRunner {
  private readonly states: RangeState[];
  private space = "";
  private hold = "";
  private line = 0;
  private substituted = false;
  private appended: string[] = [];
  private lastTerminated = true;

  constructor(
    private readonly commands: readonly SedCommand[],
    private readonly quiet: boolean,
    private readonly budget: ShellBudget,
    private readonly source: RecordSource,
    private readonly output: SedOutput,
  ) {
    this.states = commands.map(() => ({ active: false, ended: false }));
  }

  /** Returns whether `q` or `Q` ended the run. */
  async run(): Promise<boolean> {
    let record = await this.read();
    while (record !== undefined) {
      this.space = record.value;
      this.substituted = false;
      this.output.beginCycle();
      let outcome = await this.cycle();
      while (outcome === "restart") {
        this.budget.step();
        outcome = await this.cycle();
      }
      await this.flushAppended();
      if (outcome === "quit") {
        await this.output.finish(true);
        return true;
      }
      record = await this.read();
    }
    // An unterminated final record stays unterminated.
    await this.output.finish(this.lastTerminated);
    return false;
  }

  private async read(): Promise<SedRecord | undefined> {
    const record = await this.source.next();
    if (record === undefined) return undefined;
    this.line += 1;
    this.lastTerminated = record.terminated;
    return record;
  }

  private async cycle(): Promise<"next" | "restart" | "quit"> {
    let pc = 0;
    while (pc < this.commands.length) {
      const command = this.commands[pc];
      if (command === undefined) break;
      const action = await this.step(command, pc);
      if (action === undefined) pc += 1;
      else if ("jump" in action) {
        // A forward pass is bounded by the script and the input; only a
        // branch back can repeat, so only that charges a step.
        if (action.jump <= pc) this.budget.step();
        pc = action.jump;
      } else return this.finishCycle(action);
    }
    await this.autoprint();
    return "next";
  }

  /** A `{` that is not selected skips its block. */
  private async step(command: SedCommand, pc: number): Promise<SedAction> {
    if (await this.selects(command, pc)) return this.execute(command);
    return command.kind === "{" ? { jump: command.end + 1 } : undefined;
  }

  private async finishCycle(
    action: Exclude<SedAction, undefined | { readonly jump: number }>,
  ): Promise<"next" | "restart" | "quit"> {
    if ("end" in action) {
      if (action.end === "print") await this.autoprint();
      return action.end === "restart" ? "restart" : "next";
    }
    if (action.quit === "print") await this.autoprint();
    return "quit";
  }

  private async selects(command: SedCommand, pc: number): Promise<boolean> {
    const selector = command.selector;
    if (selector === undefined) return !command.negated;
    const wantsLast = selector.start.kind === "last" || selector.end?.kind === "last";
    const last = wantsLast ? await this.source.isLast() : false;
    const state = this.states[pc] ?? { active: false, ended: false };
    const value = selectsWithSelector(selector, state, this.space, this.line, last);
    return command.negated ? !value : value;
  }

  private async autoprint(): Promise<void> {
    if (!this.quiet) await this.emit(`${this.space}\n`, true);
  }

  private async emit(text: string, patternSpace = false): Promise<void> {
    if (text === "") return;
    this.budget.expansionWork(text.length);
    await this.output.emit(text, patternSpace);
  }

  private async flushAppended(): Promise<void> {
    for (const text of this.appended) await this.emit(text);
    this.appended = [];
  }

  private async execute(command: SedCommand): Promise<SedAction> {
    switch (command.kind) {
      case "s":
        return this.substitute(command);
      case "b":
        return { jump: command.target };
      case "t":
      case "T": {
        const taken = command.kind === "t" ? this.substituted : !this.substituted;
        this.substituted = false;
        return taken ? { jump: command.target } : undefined;
      }
      case "{":
      case "}":
        return undefined;
      case "n":
      case "N":
        return this.nextLine(command.kind === "N");
      default:
        return this.text(command, () => this.spaces(command));
    }
  }

  private async substitute(command: SedSubstitute): Promise<SedAction> {
    const result = substitute(command, this.space, this.budget);
    this.space = result.value;
    if (result.changed) {
      this.substituted = true;
      if (command.print) await this.emit(`${this.space}\n`, true);
    }
    return undefined;
  }

  /** `n` prints and replaces the pattern space; `N` appends the next record to it. */
  private async nextLine(append: boolean): Promise<SedAction> {
    if (!append) await this.autoprint();
    await this.flushAppended();
    const record = await this.read();
    // With no next record GNU sed ends: `N` still prints, `n` already did.
    if (record === undefined) return { quit: append ? "print" : "silent" };
    this.space = append ? `${this.space}\n${record.value}` : record.value;
    this.substituted = false;
    this.checkSpaces();
    return undefined;
  }

  /** Commands that write text or end the cycle; anything else edits the spaces. */
  private text(command: SedCommand, otherwise: () => SedAction): Promise<SedAction> | SedAction {
    switch (command.kind) {
      case "p":
        return this.emit(`${this.space}\n`, true).then(() => undefined);
      case "P": {
        const newline = this.space.indexOf("\n");
        return this.emit(`${newline < 0 ? this.space : this.space.slice(0, newline)}\n`).then(
          () => undefined,
        );
      }
      case "=":
        return this.emit(`${this.line}\n`).then(() => undefined);
      case "i":
        return this.emit(`${command.text}\n`).then(() => undefined);
      case "a":
        this.appended.push(`${command.text}\n`);
        return undefined;
      case "c":
        return this.change(command);
      case "d":
        return { end: "delete" };
      case "D":
        return this.deleteFirstLine();
      case "q":
        return { quit: "print" };
      case "Q":
        return { quit: "silent" };
      default:
        return otherwise();
    }
  }

  /** `c` replaces each selected record, and a whole range only at its end. */
  private async change(command: SedCommand & { readonly text: string }): Promise<SedAction> {
    const range = command.selector?.end !== undefined && !command.negated;
    const index = this.commands.indexOf(command);
    if (!range || this.states[index]?.ended === true) await this.emit(`${command.text}\n`);
    return { end: "delete" };
  }

  private deleteFirstLine(): SedAction {
    const newline = this.space.indexOf("\n");
    if (newline < 0) return { end: "delete" };
    this.space = this.space.slice(newline + 1);
    return { end: "restart" };
  }

  private spaces(command: SedCommand): SedAction {
    if (command.kind === "g") this.space = this.hold;
    else if (command.kind === "G") this.space = `${this.space}\n${this.hold}`;
    else if (command.kind === "h") this.hold = this.space;
    else if (command.kind === "H") this.hold = `${this.hold}\n${this.space}`;
    else if (command.kind === "x") [this.space, this.hold] = [this.hold, this.space];
    else if (command.kind === "z") this.space = "";
    else if (command.kind === "y") {
      this.space = [...this.space]
        .map((character) => command.map.get(character) ?? character)
        .join("");
    }
    this.checkSpaces();
    return undefined;
  }

  /** Both spaces can grow across records (`N`, `H`, `G`), so both are bounded. */
  private checkSpaces(): void {
    this.budget.expansionWork(this.space.length);
    const limit = this.budget.limits.maxExpansionChars;
    if (this.space.length > limit || this.hold.length > limit) {
      throw new VfsError("E2BIG", "sed: text expansion limit exceeded");
    }
  }
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
      if (await editInPlace(context, invocation, path)) break;
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

/**
 * Edits records with a bounded subset of the sed language.
 *
 * Ordinary operation streams: nothing is materialized but the pattern and hold
 * spaces and, for `$`, one record of lookahead. `-i` is the exception by
 * necessity — it publishes one guarded whole-file write rather than a visible
 * temporary file, so a concurrent change loses rather than interleaves.
 */
export const sedCommand = /* @__PURE__ */ defineApplet(SED, async (context, argv, fds) => {
  const invocation = parseInvocation(argv, context.budget);
  if (invocation.inPlace) return editOperands(context, invocation, fds);
  const writer = new BufferedTextWriter(context, fds[1]);
  try {
    const source = new PeekingSource(streamedRecords(context, invocation.operands, fds[0]));
    const output = new SedOutput((text) => writer.write(text));
    try {
      await new SedRunner(
        invocation.commands,
        invocation.quiet,
        context.budget,
        source,
        output,
      ).run();
    } finally {
      await source.close();
    }
    await writer.flush();
  } finally {
    writer.abort();
  }
  return 0;
});

/** Rewrites one file in place, as a single guarded publication. */
async function editInPlace(
  context: ShellCommandContext,
  invocation: SedInvocation,
  path: string,
): Promise<boolean> {
  const normalized = commandPath(context, path);
  const current = context.fileSystem.readFile(normalized);
  const token =
    current.stat.path === normalized
      ? current.stat.mutationToken
      : context.fileSystem.getMutationToken(normalized);
  const source = await collectText(context, current.stream, normalized);
  // `-i` numbers each file on its own, as GNU's implied `-s` does.
  const edited = new SedText(context.budget, context.budget.limits.maxBufferedBytes);
  let quit: boolean;
  try {
    const records = new PeekingSource(textRecords(source.value));
    const output = new SedOutput((text) => edited.append(text));
    quit = await new SedRunner(
      invocation.commands,
      invocation.quiet,
      context.budget,
      records,
      output,
    ).run();
  } finally {
    source.release();
  }
  // The edit is either the whole new file or nothing, and a concurrent write
  // to the same path loses.
  await context.fileSystem.writeFile(normalized, edited.result(), {
    ifMutationToken: token,
    disposition: "replace",
    mode: current.stat.mode,
  });
  return quit;
}
