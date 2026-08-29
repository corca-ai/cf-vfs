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

interface Thread {
  readonly pc: number;
  readonly caps: readonly number[];
}

/** Mutable state for one bounded Thompson simulation. */
class Matcher {
  private readonly seen: Int32Array;
  private current: Thread[] = [];
  private next: Thread[] = [];
  private generation = 0;
  private steps = 0;

  constructor(
    private readonly program: readonly PosixRegexInstruction[],
    private readonly codes: readonly number[],
    private readonly command: string,
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

  private add(list: Thread[], mark: number, pc: number, caps: readonly number[], at: number): void {
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
        const next = [...caps];
        next[instruction.slot] = at;
        this.add(list, mark, pc + 1, next, at);
        return;
      }
      case "bol":
        if (at === 0) this.add(list, mark, pc + 1, caps, at);
        return;
      case "eol":
        if (at === this.codes.length) this.add(list, mark, pc + 1, caps, at);
        return;
      default:
        list.push({ pc, caps });
    }
  }

  private advance(position: number, mark: number): readonly number[] | undefined {
    const code = position < this.codes.length ? (this.codes[position] ?? -1) : -1;
    for (const thread of this.current) {
      this.charge();
      const instruction = this.program[thread.pc];
      if (instruction?.op === "match") return thread.caps;
      if (code < 0 || instruction === undefined) continue;
      if (
        instruction.op === "any" ||
        (instruction.op === "set" && inPosixSet(instruction.set, code))
      ) {
        this.add(this.next, mark, thread.pc + 1, thread.caps, position + 1);
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

  run(from: number, slots: number): readonly number[] | undefined {
    const empty = new Array<number>(slots).fill(-1);
    let currentMark = 0;
    let matched: readonly number[] | undefined;
    for (let position = from; ; position += 1) {
      if (matched === undefined) {
        if (this.current.length === 0) currentMark = this.mark();
        this.add(this.current, currentMark, 0, empty, position);
      }
      if (this.current.length === 0 && matched !== undefined) break;
      const nextMark = this.mark();
      const candidate = this.advance(position, nextMark);
      if (candidate !== undefined) matched = candidate;
      this.swapLists();
      currentMark = nextMark;
      if (position >= this.codes.length) break;
    }
    return matched;
  }
}

export function runPosixRegex(
  program: readonly PosixRegexInstruction[],
  codes: readonly number[],
  from: number,
  slots: number,
  command: string,
): readonly number[] | undefined {
  return new Matcher(program, codes, command).run(from, slots);
}
