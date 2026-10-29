import { VfsError } from "./errors.js";
import { inPosixSet, type PosixCharSet } from "./posix-regex-charset.js";

const MAX_STEPS = 20_000_000;

export type PosixRegexInstruction =
  | { readonly op: "set"; readonly set: PosixCharSet }
  | { readonly op: "any" }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; to: number }
  | { readonly op: "save"; readonly slot: number }
  | { readonly op: "bol" }
  | { readonly op: "eol" }
  | { readonly op: "match" };

/** Recognize an exact string only after dialect parsing and program limits. */
export function posixLiteral(program: readonly PosixRegexInstruction[]): string | undefined {
  const open = program[0];
  const close = program[program.length - 2];
  if (open?.op !== "save" || open.slot !== 0) return undefined;
  if (close?.op !== "save" || close.slot !== 1) return undefined;
  if (program[program.length - 1]?.op !== "match") return undefined;
  let literal = "";
  for (let index = 1; index < program.length - 2; index += 1) {
    const instruction = program[index];
    if (instruction?.op !== "set" || instruction.set.negated) return undefined;
    const ranges = instruction.set.ranges;
    const range = ranges[0];
    if (ranges.length !== 1 || range === undefined || range[0] !== range[1]) return undefined;
    // indexOf can match half a surrogate pair; the code-point matcher cannot.
    if (range[0] >= 0xd800 && range[0] <= 0xdfff) return undefined;
    literal += String.fromCodePoint(range[0]);
  }
  return literal;
}

/** A single literal code point an instruction accepts, or `undefined`. */
function literalPoint(instruction: PosixRegexInstruction | undefined): number | undefined {
  if (instruction?.op !== "set" || instruction.set.negated) return undefined;
  const range = instruction.set.ranges[0];
  if (instruction.set.ranges.length !== 1 || range === undefined || range[0] !== range[1]) {
    return undefined;
  }
  // indexOf can match half a surrogate pair; the code-point matcher cannot.
  return range[0] >= 0xd800 && range[0] <= 0xdfff ? undefined : range[0];
}

/**
 * The literal text every match must begin with, read from the start of the
 * program up to its first branch, class, anchor or repetition. Threads only
 * start at instruction zero, so nothing can bypass these instructions; a
 * search may therefore skip straight to the next occurrence whenever no
 * thread is alive, which leaves every match and capture unchanged.
 */
export function posixLiteralPrefix(program: readonly PosixRegexInstruction[]): string {
  let prefix = "";
  for (const instruction of program) {
    if (instruction.op === "save") continue;
    const point = literalPoint(instruction);
    if (point === undefined) break;
    prefix += String.fromCodePoint(point);
  }
  return prefix;
}

interface Thread {
  pc: number;
  caps: readonly number[];
}

/** Reuse states within one search; retained state stays bounded by the program. */
class ThreadList {
  readonly threads: Thread[] = [];
  length = 0;

  add(pc: number, caps: readonly number[]): void {
    const thread = this.threads[this.length];
    if (thread === undefined) this.threads.push({ pc, caps });
    else {
      thread.pc = pc;
      thread.caps = caps;
    }
    this.length += 1;
  }
}

function codePointWidth(code: number): number {
  return code > 0xffff ? 2 : 1;
}

/** Mutable state for one bounded Thompson simulation. */
class Matcher {
  private readonly seen: Int32Array;
  private current = new ThreadList();
  private next = new ThreadList();
  private generation = 0;
  private steps = 0;

  constructor(
    private readonly program: readonly PosixRegexInstruction[],
    private readonly text: string,
    private readonly command: string,
    private readonly capture: boolean,
    private readonly prefix: string,
  ) {
    this.seen = new Int32Array(program.length).fill(-1);
  }

  private charge(): void {
    this.steps += 1;
    if (this.steps > MAX_STEPS) {
      throw new VfsError("EINVAL", `${this.command}: pattern is too expensive for this input`);
    }
  }

  private mark(): number {
    this.generation += 1;
    return this.generation;
  }

  private add(
    list: ThreadList,
    mark: number,
    pc: number,
    caps: readonly number[],
    at: number,
  ): void {
    this.charge();
    if (this.seen[pc] === mark) return;
    this.seen[pc] = mark;
    const instruction = this.program[pc];
    if (instruction === undefined) return;
    switch (instruction.op) {
      case "jmp":
        this.add(list, mark, instruction.to, caps, at);
        return;
      case "split":
        this.add(list, mark, instruction.x, caps, at);
        this.add(list, mark, instruction.y, caps, at);
        return;
      case "save": {
        if (!this.capture) {
          this.add(list, mark, pc + 1, caps, at);
          return;
        }
        const next = [...caps];
        next[instruction.slot] = at;
        this.add(list, mark, pc + 1, next, at);
        return;
      }
      case "bol":
        if (at === 0) this.add(list, mark, pc + 1, caps, at);
        return;
      case "eol":
        if (at === this.text.length) this.add(list, mark, pc + 1, caps, at);
        return;
      default:
        list.add(pc, caps);
    }
  }

  private advance(code: number, nextPosition: number, mark: number): readonly number[] | undefined {
    for (let index = 0; index < this.current.length; index += 1) {
      const thread = this.current.threads[index];
      if (thread === undefined) continue;
      this.charge();
      const instruction = this.program[thread.pc];
      if (instruction?.op === "match") return thread.caps;
      if (code < 0 || instruction === undefined) continue;
      if (
        instruction.op === "any" ||
        (instruction.op === "set" && inPosixSet(instruction.set, code))
      ) {
        this.add(this.next, mark, thread.pc + 1, thread.caps, nextPosition);
      }
    }
    return undefined;
  }

  private swapLists(): void {
    const previous = this.current;
    this.current = this.next;
    this.next = previous;
    this.next.length = 0;
  }

  /** Starts a thread at `position`, opening a new generation when none is alive. */
  private seed(mark: number, empty: readonly number[], position: number): number {
    const generation = this.current.length === 0 ? this.mark() : mark;
    this.add(this.current, generation, 0, empty, position);
    return generation;
  }

  /** With no thread alive, the next match can only start where the prefix does. */
  private startAt(position: number): number {
    if (this.current.length > 0 || this.prefix === "") return position;
    return this.text.indexOf(this.prefix, position);
  }

  run(from: number, slots: number): readonly number[] | undefined {
    const empty = new Array<number>(slots).fill(-1);
    let currentMark = 0;
    let matched: readonly number[] | undefined;
    for (let position = from; ; ) {
      if (matched === undefined) {
        position = this.startAt(position);
        if (position < 0) return undefined;
        currentMark = this.seed(currentMark, empty, position);
      }
      const nextMark = this.mark();
      const code = this.text.codePointAt(position) ?? -1;
      const nextPosition = position + codePointWidth(code);
      const candidate = this.advance(code, nextPosition, nextMark);
      matched = candidate ?? matched;
      if (matched !== undefined && (!this.capture || this.next.length === 0)) return matched;
      this.swapLists();
      currentMark = nextMark;
      if (position >= this.text.length) break;
      position = nextPosition;
    }
    return matched;
  }
}

export function runPosixRegex(
  program: readonly PosixRegexInstruction[],
  text: string,
  from: number,
  slots: number,
  command: string,
  prefix = "",
): readonly number[] | undefined {
  return new Matcher(program, text, command, slots > 0, prefix).run(from, slots);
}
