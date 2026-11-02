import { VfsError } from "../../core/errors.js";
import type { InlineReadResult } from "../../vfs/types.js";
import { fileBody } from "../content.js";
import type { ShellBudget, ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { appletUsageError, defineApplet, parseAppletOptions } from "./applet.js";
import { BufferedTextWriter, collectText, commandPath, writeText } from "./helpers.js";
import { OperandReader } from "./inputs.js";
import {
  type SedAddress as Address,
  parseSedScript,
  SED,
  type SedCommand,
  type SedSubstitute,
  type SedSelector as Selector,
} from "./sed-parser.js";
import {
  drive,
  inputLines,
  LineSource,
  oneInput,
  type RecordSource,
  type SedRecord,
  type Steps,
  splitLines,
} from "./sed-records.js";
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

/**
 * Output that holds back its final newline, so an unterminated last input
 * record stays unterminated while every earlier line keeps its newline.
 */
class SedOutput {
  private held = false;
  /** Whether the held newline ended a pattern space printed in the current cycle. */
  private heldPatternSpace = false;

  /** `write` returns a promise only when the text had to reach a sink. */
  constructor(private readonly write: (text: string) => Promise<void> | undefined) {}

  beginCycle(): void {
    this.heldPatternSpace = false;
  }

  emit(text: string, patternSpace: boolean): Promise<void> | undefined {
    if (text === "") return undefined;
    const body = this.held ? `\n${text}` : text;
    this.held = body.endsWith("\n");
    this.heldPatternSpace = this.held && patternSpace;
    return this.write(this.held ? body.slice(0, -1) : body);
  }

  /**
   * Only the last record's pattern space loses its newline when that record
   * had none: `$d` keeps the line before, and `a` text is always terminated.
   */
  finish(lastTerminated: boolean): Promise<void> | undefined {
    const writing =
      this.held && (lastTerminated || !this.heldPatternSpace) ? this.write("\n") : undefined;
    this.held = false;
    return writing;
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
 *
 * Its steps are a generator that yields only what it has to wait for — a
 * record that is not at hand, output that must reach its sink — so a record
 * read in bulk and printed into the buffer costs no await.
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
  run(): boolean | Promise<boolean> {
    return drive(this.steps());
  }

  private *steps(): Steps<boolean> {
    let record = yield* this.read();
    while (record !== undefined) {
      this.space = record.value;
      this.substituted = false;
      this.output.beginCycle();
      let outcome = yield* this.cycle();
      while (outcome === "restart") {
        this.budget.step();
        outcome = yield* this.cycle();
      }
      if (this.appended.length > 0) yield* this.flushAppended();
      if (outcome === "quit") {
        const finishing = this.output.finish(true);
        if (finishing !== undefined) yield finishing;
        return true;
      }
      record = yield* this.read();
    }
    // An unterminated final record stays unterminated.
    const finishing = this.output.finish(this.lastTerminated);
    if (finishing !== undefined) yield finishing;
    return false;
  }

  private *read(): Steps<SedRecord | undefined> {
    const next = this.source.next();
    const record = next instanceof Promise ? ((yield next) as SedRecord | undefined) : next;
    if (record === undefined) return undefined;
    this.line += 1;
    this.lastTerminated = record.terminated;
    return record;
  }

  private *cycle(): Steps<"next" | "restart" | "quit"> {
    let pc = 0;
    while (pc < this.commands.length) {
      const command = this.commands[pc];
      if (command === undefined) break;
      const action = yield* this.step(command, pc);
      if (action === undefined) pc += 1;
      else if ("jump" in action) {
        // A forward pass is bounded by the script and the input; only a
        // branch back can repeat, so only that charges a step.
        if (action.jump <= pc) this.budget.step();
        pc = action.jump;
      } else return yield* this.finishCycle(action);
    }
    const printing = this.autoprint();
    if (printing !== undefined) yield printing;
    return "next";
  }

  /** A `{` that is not selected skips its block. */
  private *step(command: SedCommand, pc: number): Steps<SedAction> {
    const selecting = this.selects(command, pc);
    const selected = selecting instanceof Promise ? ((yield selecting) as boolean) : selecting;
    if (selected) return yield* this.execute(command);
    return command.kind === "{" ? { jump: command.end + 1 } : undefined;
  }

  private *finishCycle(
    action: Exclude<SedAction, undefined | { readonly jump: number }>,
  ): Steps<"next" | "restart" | "quit"> {
    const print = "end" in action ? action.end === "print" : action.quit === "print";
    const printing = print ? this.autoprint() : undefined;
    if (printing !== undefined) yield printing;
    if ("end" in action) return action.end === "restart" ? "restart" : "next";
    return "quit";
  }

  private selects(command: SedCommand, pc: number): boolean | Promise<boolean> {
    const selector = command.selector;
    if (selector === undefined) return !command.negated;
    const wantsLast = selector.start.kind === "last" || selector.end?.kind === "last";
    if (!wantsLast) return this.selectsWith(selector, pc, false, command.negated);
    const last = this.source.isLast();
    return last instanceof Promise
      ? last.then((value) => this.selectsWith(selector, pc, value, command.negated))
      : this.selectsWith(selector, pc, last, command.negated);
  }

  private selectsWith(selector: Selector, pc: number, last: boolean, negated: boolean): boolean {
    const state = this.states[pc] ?? { active: false, ended: false };
    const value = selectsWithSelector(selector, state, this.space, this.line, last);
    return negated ? !value : value;
  }

  private autoprint(): Promise<void> | undefined {
    return this.quiet ? undefined : this.emit(`${this.space}\n`, true);
  }

  /** Writes `text`, returning a promise only when it had to reach the sink. */
  private emit(text: string, patternSpace = false): Promise<void> | undefined {
    if (text === "") return undefined;
    this.budget.expansionWork(text.length);
    return this.output.emit(text, patternSpace);
  }

  private *flushAppended(): Steps<void> {
    for (const text of this.appended) {
      const writing = this.emit(text);
      if (writing !== undefined) yield writing;
    }
    this.appended = [];
  }

  private *execute(command: SedCommand): Steps<SedAction> {
    switch (command.kind) {
      case "s":
        return yield* this.substitute(command);
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
        return yield* this.nextLine(command.kind === "N");
      default:
        return yield* this.text(command, () => this.spaces(command));
    }
  }

  private *substitute(command: SedSubstitute): Steps<SedAction> {
    const result = substitute(command, this.space, this.budget);
    this.space = result.value;
    if (result.changed) {
      this.substituted = true;
      const writing = command.print ? this.emit(`${this.space}\n`, true) : undefined;
      if (writing !== undefined) yield writing;
    }
    return undefined;
  }

  /** `n` prints and replaces the pattern space; `N` appends the next record to it. */
  private *nextLine(append: boolean): Steps<SedAction> {
    const printing = append ? undefined : this.autoprint();
    if (printing !== undefined) yield printing;
    if (this.appended.length > 0) yield* this.flushAppended();
    const record = yield* this.read();
    // With no next record GNU sed ends: `N` still prints, `n` already did.
    if (record === undefined) return { quit: append ? "print" : "silent" };
    this.space = append ? `${this.space}\n${record.value}` : record.value;
    this.substituted = false;
    this.checkSpaces();
    return undefined;
  }

  /** Commands that write text or end the cycle; anything else edits the spaces. */
  private *text(command: SedCommand, otherwise: () => SedAction): Steps<SedAction> {
    const writing = this.printed(command);
    if (writing !== null) {
      if (writing !== undefined) yield writing;
      return undefined;
    }
    switch (command.kind) {
      case "a":
        this.appended.push(`${command.text}\n`);
        return undefined;
      case "c":
        return yield* this.change(command);
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

  /** What `p`, `P`, `=` and `i` write; `null` for any other command. */
  private printed(command: SedCommand): Promise<void> | undefined | null {
    switch (command.kind) {
      case "p":
        return this.emit(`${this.space}\n`, true);
      case "P": {
        const newline = this.space.indexOf("\n");
        return this.emit(`${newline < 0 ? this.space : this.space.slice(0, newline)}\n`);
      }
      case "=":
        return this.emit(`${this.line}\n`);
      case "i":
        return this.emit(`${command.text}\n`);
      default:
        return null;
    }
  }

  /** `c` replaces each selected record, and a whole range only at its end. */
  private *change(command: SedCommand & { readonly text: string }): Steps<SedAction> {
    const range = command.selector?.end !== undefined && !command.negated;
    const index = this.commands.indexOf(command);
    const writing =
      !range || this.states[index]?.ended === true ? this.emit(`${command.text}\n`) : undefined;
    if (writing !== undefined) yield writing;
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
  const operands = new OperandReader(context, invocation.operands);
  try {
    for (const [index, path] of invocation.operands.entries()) {
      try {
        if (await editInPlace(context, invocation, path, index, operands)) break;
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
  } finally {
    operands.release();
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
    const source = new LineSource(inputLines(context, invocation.operands, fds[0]));
    const output = new SedOutput((text) => writer.put(text));
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

/**
 * Rewrites one file in place, as a single guarded publication. Operands are
 * read ahead in bulk; each write is published at once, as before, and the
 * read-ahead revalidates the other bodies it holds against it.
 */
async function editInPlace(
  context: ShellCommandContext,
  invocation: SedInvocation,
  path: string,
  index: number,
  operands: OperandReader,
): Promise<boolean> {
  const normalized = commandPath(context, path);
  const read = operands.takeBody(index);
  const current = read === undefined ? context.fileSystem.readFile(normalized) : undefined;
  const stat = read?.stat ?? (current as InlineReadResult).stat;
  const token =
    stat.path === normalized ? stat.mutationToken : context.fileSystem.getMutationToken(normalized);
  const source = await collectText(
    context,
    read?.chunks ?? fileBody((current as InlineReadResult).stream),
    normalized,
  );
  // `-i` numbers each file on its own, as GNU's implied `-s` does. The
  // records were charged as they were emitted, so the copy is not charged again.
  const edited = new SedText(context.budget, context.budget.limits.maxBufferedBytes, false);
  let quit: boolean;
  try {
    const records = new LineSource(oneInput(splitLines(source.value)));
    const output = new SedOutput((text) => {
      edited.append(text);
      return undefined;
    });
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
    mode: stat.mode,
  });
  return quit;
}
