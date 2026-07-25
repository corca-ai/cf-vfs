import { VfsError } from "./errors.js";

/**
 * The two POSIX regular-expression dialects this project declares.
 *
 * `basic` is what `grep` and `sed` accept by default; `extended` is `grep -E`.
 * They differ only in which characters carry a special meaning bare and which
 * need a backslash.
 */
export type PosixRegexDialect = "basic" | "extended";

/**
 * Upper bounds that keep one pattern from costing an unbounded amount.
 *
 * Matching is linear in the record by construction, so these only bound the
 * constant: a program cap so an interval cannot expand without limit, and a
 * step cap so a large program against a large record still ends in a
 * diagnosable error rather than a runtime kill.
 */
const MAX_PROGRAM = 2048;
const MAX_STEPS = 20_000_000;
const MAX_GROUPS = 20;

function unsupported(command: string, detail: string): never {
  throw new VfsError("EINVAL", `${command}: ${detail}`);
}

/**
 * A set of code points, as a list of inclusive ranges.
 *
 * POSIX classes expand into explicit ASCII ranges rather than JavaScript
 * classes, so `[[:alpha:]]` cannot quietly become Unicode-aware and disagree
 * with the pinned oracle in the `LC_ALL=C` locale this runtime declares.
 */
interface CharSet {
  readonly negated: boolean;
  readonly ranges: readonly (readonly [number, number])[];
}

const POSIX_CLASSES: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  alpha: [
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  digit: [[0x30, 0x39]],
  alnum: [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x61, 0x7a],
  ],
  upper: [[0x41, 0x5a]],
  lower: [[0x61, 0x7a]],
  space: [
    [0x09, 0x0d],
    [0x20, 0x20],
  ],
  blank: [
    [0x09, 0x09],
    [0x20, 0x20],
  ],
  punct: [
    [0x21, 0x2f],
    [0x3a, 0x40],
    [0x5b, 0x60],
    [0x7b, 0x7e],
  ],
  print: [[0x20, 0x7e]],
  graph: [[0x21, 0x7e]],
  cntrl: [
    [0x00, 0x1f],
    [0x7f, 0x7f],
  ],
  xdigit: [
    [0x30, 0x39],
    [0x41, 0x46],
    [0x61, 0x66],
  ],
};

const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const CASE_GAP = 0x20;

/**
 * Adds the opposite-case counterpart of every ASCII letter in a range list.
 *
 * Folding happens while the set is built rather than by rewriting a finished
 * pattern, so every member is folded exactly once and by the same rule: a bare
 * letter, a letter inside a bracket, and either end of a range all take this
 * path. The fold is the twenty-six ASCII pairs and nothing else, because the
 * runtime declares `LC_ALL=C` — Unicode case folding would put the Kelvin sign
 * in `[k]`.
 */
function foldRanges(ranges: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const folded: (readonly [number, number])[] = [...ranges];
  for (const [low, high] of ranges) {
    const upperLow = Math.max(low, UPPER_A);
    const upperHigh = Math.min(high, UPPER_Z);
    if (upperLow <= upperHigh) folded.push([upperLow + CASE_GAP, upperHigh + CASE_GAP]);
    const lowerLow = Math.max(low, LOWER_A);
    const lowerHigh = Math.min(high, LOWER_Z);
    if (lowerLow <= lowerHigh) folded.push([lowerLow - CASE_GAP, lowerHigh - CASE_GAP]);
  }
  return folded;
}

function inSet(set: CharSet, point: number): boolean {
  let present = false;
  for (const [low, high] of set.ranges) {
    if (point >= low && point <= high) {
      present = true;
      break;
    }
  }
  return set.negated ? !present : present;
}

type Node =
  | { readonly kind: "empty" }
  | { readonly kind: "set"; readonly set: CharSet }
  | { readonly kind: "any" }
  | { readonly kind: "bol" }
  | { readonly kind: "eol" }
  | { readonly kind: "cat"; readonly left: Node; readonly right: Node }
  | { readonly kind: "alt"; readonly left: Node; readonly right: Node }
  | { readonly kind: "group"; readonly body: Node; readonly index: number }
  | {
      readonly kind: "repeat";
      readonly body: Node;
      readonly min: number;
      readonly max: number | undefined;
    };

type Split = { op: "split"; x: number; y: number };
type Jump = { op: "jmp"; to: number };

type Instruction =
  | { readonly op: "set"; readonly set: CharSet }
  | { readonly op: "any" }
  | Split
  | Jump
  | { readonly op: "save"; readonly slot: number }
  | { readonly op: "bol" }
  | { readonly op: "eol" }
  | { readonly op: "match" };

/**
 * Parses one POSIX pattern into a syntax tree.
 *
 * The point is that no JavaScript syntax reaches the matcher unexamined. Every
 * character is either the construct POSIX gives it or a literal, and anything
 * outside the declared subset is refused with a usage error rather than handed
 * to a dialect the caller did not ask for. That is what keeps `\d`, `(?:…)`,
 * and `\b` from meaning something here that they do not mean in `grep`.
 *
 * The declared subset is: literals, `.`, `*`, bracket expressions including
 * negation, ranges, and POSIX classes, the anchors `^` and `$`, grouping,
 * alternation, the repetitions `+` and `?`, and the intervals `{n}`, `{n,}`,
 * and `{n,m}`. In `basic` the last four need a backslash and bare `+?{}()|` are
 * literal; in `extended` it is the other way round. Back-references, the GNU
 * escape classes, equivalence classes, and collating symbols are refused.
 */
class Parser {
  private index = 0;
  private groups = 0;
  private readonly points: readonly string[];

  constructor(
    pattern: string,
    private readonly extended: boolean,
    private readonly command: string,
    private readonly ignoreCase: boolean,
  ) {
    this.points = [...pattern];
  }

  parse(): { node: Node; groups: number } {
    const node = this.alternation();
    // The only way to stop before the end is a group close with nothing open.
    if (this.index < this.points.length) unsupported(this.command, "unmatched )");
    return { node, groups: this.groups };
  }

  private at(offset = 0): string | undefined {
    return this.points[this.index + offset];
  }

  private atAlternation(): boolean {
    return this.extended ? this.at() === "|" : this.at() === "\\" && this.at(1) === "|";
  }

  private atGroupClose(): boolean {
    return this.extended ? this.at() === ")" : this.at() === "\\" && this.at(1) === ")";
  }

  private alternation(): Node {
    let node = this.concatenation();
    while (this.atAlternation()) {
      this.index += this.extended ? 1 : 2;
      node = { kind: "alt", left: node, right: this.concatenation() };
    }
    return node;
  }

  private concatenation(): Node {
    let node: Node = { kind: "empty" };
    let first = true;
    while (this.index < this.points.length && !this.atAlternation() && !this.atGroupClose()) {
      const piece = this.repetition(first);
      node = node.kind === "empty" ? piece : { kind: "cat", left: node, right: piece };
      first = false;
    }
    return node;
  }

  /** Parses one atom and every repetition operator stacked on it. */
  private repetition(first: boolean): Node {
    const atom = this.atom(first);
    let node = atom.node;
    if (!atom.repeatable) return node;
    for (;;) {
      const operator = this.repetitionOperator();
      if (operator === undefined) return node;
      node = { kind: "repeat", body: node, min: operator.min, max: operator.max };
    }
  }

  private repetitionOperator(): { min: number; max: number | undefined } | undefined {
    const character = this.at();
    if (character === "*") {
      this.index += 1;
      return { min: 0, max: undefined };
    }
    if (this.extended && (character === "+" || character === "?")) {
      this.index += 1;
      return character === "+" ? { min: 1, max: undefined } : { min: 0, max: 1 };
    }
    if (!this.extended && character === "\\" && (this.at(1) === "+" || this.at(1) === "?")) {
      const operator = this.at(1);
      this.index += 2;
      return operator === "+" ? { min: 1, max: undefined } : { min: 0, max: 1 };
    }
    if (this.extended && character === "{") return this.interval(1, "}");
    if (!this.extended && character === "\\" && this.at(1) === "{") return this.interval(2, "\\");
    return undefined;
  }

  private interval(offset: number, terminator: string): { min: number; max: number | undefined } {
    let close = this.index + offset;
    while (close < this.points.length && this.points[close] !== terminator) close += 1;
    if (close >= this.points.length) unsupported(this.command, "unmatched {");
    if (terminator === "\\" && this.points[close + 1] !== "}") {
      unsupported(this.command, "unmatched \\{");
    }
    const body = this.points.slice(this.index + offset, close).join("");
    const parsed = /^([0-9]+)(,([0-9]*))?$/u.exec(body);
    if (parsed === null) unsupported(this.command, `invalid interval {${body}}`);
    const min = Number(parsed[1]);
    const max = parsed[2] === undefined ? min : parsed[3] === "" ? undefined : Number(parsed[3]);
    if (max !== undefined && max < min) unsupported(this.command, `invalid interval {${body}}`);
    this.index = close + (terminator === "\\" ? 2 : 1);
    return { min, max };
  }

  private literal(character: string): Node {
    const point = character.codePointAt(0) ?? 0;
    const ranges: (readonly [number, number])[] = [[point, point]];
    return {
      kind: "set",
      set: { negated: false, ranges: this.ignoreCase ? foldRanges(ranges) : ranges },
    };
  }

  private atom(first: boolean): { node: Node; repeatable: boolean } {
    const character = this.at() ?? "";

    if (character === "\\") {
      const next = this.at(1);
      if (next === undefined) unsupported(this.command, "trailing backslash");
      if (!this.extended && next === "(") {
        this.index += 2;
        return { node: this.group(2), repeatable: true };
      }
      // Alphanumerics are where JavaScript keeps its classes, and `<`, `>`, and
      // `` ` `` are GNU word-boundary extensions. Refusing all of them keeps
      // the declared subset honest rather than silently borrowing a dialect.
      if (/[A-Za-z0-9<>`']/u.test(next)) {
        unsupported(this.command, `unsupported escape \\${next}`);
      }
      this.index += 2;
      return { node: this.literal(next), repeatable: true };
    }

    if (this.extended && character === "(") {
      this.index += 1;
      return { node: this.group(1), repeatable: true };
    }

    if (character === "[") return { node: this.bracket(), repeatable: true };

    if (character === ".") {
      this.index += 1;
      return { node: { kind: "any" }, repeatable: true };
    }

    if (character === "^") {
      // Anchored at the start of a branch; elsewhere `basic` makes it a literal
      // caret, as GNU does. An anchor has nothing to repeat, so a `*` after one
      // is a literal asterisk.
      const anchor = this.extended ? first : this.index === 0;
      this.index += 1;
      return anchor
        ? { node: { kind: "bol" }, repeatable: false }
        : { node: this.literal("^"), repeatable: true };
    }

    if (character === "$") {
      const anchor = this.extended || this.index === this.points.length - 1;
      this.index += 1;
      return anchor
        ? { node: { kind: "eol" }, repeatable: false }
        : { node: this.literal("$"), repeatable: true };
    }

    // A repetition operator with nothing before it is a literal in both
    // dialects, which is how `grep '^*'` finds an asterisk.
    this.index += 1;
    return { node: this.literal(character), repeatable: true };
  }

  private group(width: number): Node {
    this.groups += 1;
    if (this.groups > MAX_GROUPS) unsupported(this.command, "too many groups");
    const index = this.groups;
    const body = this.alternation();
    if (!this.atGroupClose()) {
      unsupported(this.command, width === 1 ? "unmatched (" : "unmatched \\(");
    }
    this.index += width;
    return { kind: "group", body, index };
  }

  private bracket(): Node {
    let index = this.index + 1;
    let negated = false;
    if (this.points[index] === "^") {
      negated = true;
      index += 1;
    }
    const ranges: (readonly [number, number])[] = [];
    const point = (value: string): number => value.codePointAt(0) ?? 0;
    let first = true;
    for (; index < this.points.length; index += 1, first = false) {
      const character = this.points[index] ?? "";
      // A `]` first is a literal `]`, as POSIX has it.
      if (character === "]" && !first) {
        if (ranges.length === 0) unsupported(this.command, "empty bracket expression");
        this.index = index + 1;
        return {
          kind: "set",
          set: { negated, ranges: this.ignoreCase ? foldRanges(ranges) : ranges },
        };
      }
      const following = this.points[index + 1];
      if (character === "[" && following === ":") {
        const close = this.points.indexOf(":", index + 2);
        if (close < 0 || this.points[close + 1] !== "]") unsupported(this.command, "unmatched [:");
        const name = this.points.slice(index + 2, close).join("");
        const known = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined;
        if (known === undefined) {
          unsupported(this.command, `unsupported character class [:${name}:]`);
        }
        ranges.push(...known);
        index = close + 1;
        continue;
      }
      // Equivalence classes and collating symbols have no meaning without a
      // locale table, and treating their punctuation as ordinary members would
      // silently match the wrong thing rather than say so.
      if (character === "[" && (following === "=" || following === ".")) {
        unsupported(this.command, `unsupported bracket construct [${following}`);
      }
      const after = this.points[index + 2];
      if (following === "-" && after !== undefined && after !== "]") {
        const low = point(character);
        const high = point(after);
        if (low > high) unsupported(this.command, "invalid range in bracket expression");
        ranges.push([low, high]);
        index += 2;
        continue;
      }
      ranges.push([point(character), point(character)]);
    }
    unsupported(this.command, "unmatched [");
  }
}

/** Emits a program, refusing a pattern whose expansion would be unbounded. */
function compile(node: Node, command: string): readonly Instruction[] {
  const program: Instruction[] = [];
  const push = (instruction: Instruction): number => {
    if (program.length >= MAX_PROGRAM) unsupported(command, "pattern is too complex");
    program.push(instruction);
    return program.length - 1;
  };

  const emit = (current: Node): void => {
    switch (current.kind) {
      case "empty":
        return;
      case "set":
        push({ op: "set", set: current.set });
        return;
      case "any":
        push({ op: "any" });
        return;
      case "bol":
        push({ op: "bol" });
        return;
      case "eol":
        push({ op: "eol" });
        return;
      case "cat":
        emit(current.left);
        emit(current.right);
        return;
      case "alt": {
        const frame = program[push({ op: "split", x: 0, y: 0 })] as Split;
        frame.x = program.length;
        emit(current.left);
        const jump = program[push({ op: "jmp", to: 0 })] as Jump;
        frame.y = program.length;
        emit(current.right);
        jump.to = program.length;
        return;
      }
      case "group":
        push({ op: "save", slot: current.index * 2 });
        emit(current.body);
        push({ op: "save", slot: current.index * 2 + 1 });
        return;
      case "repeat":
        repeat(current.body, current.min, current.max);
        return;
    }
  };

  const star = (body: Node): void => {
    const at = push({ op: "split", x: 0, y: 0 });
    const frame = program[at] as Split;
    frame.x = program.length;
    emit(body);
    push({ op: "jmp", to: at });
    frame.y = program.length;
  };

  const repeat = (body: Node, min: number, max: number | undefined): void => {
    for (let count = 0; count < min; count += 1) emit(body);
    if (max === undefined) {
      // `x{2,}` is `x x x*`: the required copies, then an unbounded tail.
      star(body);
      return;
    }
    // The optional copies nest, so the whole tail can be skipped at any point.
    const frames: Split[] = [];
    for (let count = min; count < max; count += 1) {
      const frame = program[push({ op: "split", x: 0, y: 0 })] as Split;
      frame.x = program.length;
      frames.push(frame);
      emit(body);
    }
    for (const frame of frames) frame.y = program.length;
  };

  push({ op: "save", slot: 0 });
  emit(node);
  push({ op: "save", slot: 1 });
  push({ op: "match" });
  return program;
}

/** One match: string offsets, plus the text of each group that took part. */
export interface PosixMatch {
  readonly index: number;
  readonly end: number;
  readonly groups: readonly (string | undefined)[];
}

interface Thread {
  readonly pc: number;
  readonly caps: readonly number[];
}

/**
 * A compiled POSIX pattern.
 *
 * Matching runs a Thompson simulation: every thread advances one position at a
 * time and threads that reach the same instruction at the same position are
 * merged, so the work is bounded by the record length times the program size
 * however the pattern is written. A backtracking engine has no such bound —
 * `a*a*a*a*a*a*a*a*b` against thirty-two characters is exponential there — and
 * a synchronous match cannot be interrupted by an abort signal or a deadline,
 * so the bound has to come from the algorithm rather than from a watchdog.
 *
 * The cost is POSIX's leftmost-longest rule: alternation here is leftmost-first
 * like Perl, so `a\|ab` matches `a` where GNU matches `ab`. That divergence is
 * declared; unbounded blocking CPU in a shared runtime would not be.
 */
export class PosixRegex {
  private readonly slots: number;

  constructor(
    private readonly program: readonly Instruction[],
    groups: number,
    private readonly command: string,
  ) {
    this.slots = (groups + 1) * 2;
  }

  test(text: string): boolean {
    return this.exec(text) !== undefined;
  }

  /** Finds the leftmost match at or after the string offset `from`. */
  exec(text: string, from = 0): PosixMatch | undefined {
    const points = [...text];
    // String offset of each code point, so a match can be reported in the units
    // every caller slices with.
    const offsets: number[] = [];
    let offset = 0;
    for (const character of points) {
      offsets.push(offset);
      offset += character.length;
    }
    offsets.push(text.length);
    let start = 0;
    while (start < offsets.length && (offsets[start] ?? 0) < from) start += 1;

    const codes = points.map((character) => character.codePointAt(0) ?? 0);
    const found = this.run(codes, start);
    if (found === undefined) return undefined;
    const groups: (string | undefined)[] = [];
    for (let group = 0; group * 2 < this.slots; group += 1) {
      const open = found[group * 2] ?? -1;
      const close = found[group * 2 + 1] ?? -1;
      groups.push(
        open < 0 || close < 0 ? undefined : text.slice(offsets[open] ?? 0, offsets[close] ?? 0),
      );
    }
    return { index: offsets[found[0] ?? 0] ?? 0, end: offsets[found[1] ?? 0] ?? 0, groups };
  }

  private run(codes: readonly number[], from: number): readonly number[] | undefined {
    const seen = new Int32Array(this.program.length).fill(-1);
    let clist: Thread[] = [];
    let nlist: Thread[] = [];
    let generation = 0;
    let matched: readonly number[] | undefined;
    let steps = 0;

    const charge = (): void => {
      steps += 1;
      if (steps > MAX_STEPS) unsupported(this.command, "pattern is too expensive for this input");
    };

    const add = (
      list: Thread[],
      mark: number,
      pc: number,
      caps: readonly number[],
      at: number,
    ): void => {
      charge();
      if (seen[pc] === mark) return;
      seen[pc] = mark;
      const instruction = this.program[pc];
      if (instruction === undefined) return;
      switch (instruction.op) {
        case "jmp":
          add(list, mark, instruction.to, caps, at);
          return;
        case "split":
          add(list, mark, instruction.x, caps, at);
          add(list, mark, instruction.y, caps, at);
          return;
        case "save": {
          const next = [...caps];
          next[instruction.slot] = at;
          add(list, mark, pc + 1, next, at);
          return;
        }
        case "bol":
          if (at === 0) add(list, mark, pc + 1, caps, at);
          return;
        case "eol":
          if (at === codes.length) add(list, mark, pc + 1, caps, at);
          return;
        default:
          list.push({ pc, caps });
      }
    };

    const empty = new Array<number>(this.slots).fill(-1);
    let currentMark = 0;
    for (let position = from; ; position += 1) {
      // A new start position is only worth trying while nothing has matched:
      // once one has, any later start is not the leftmost.
      if (matched === undefined) {
        if (clist.length === 0) {
          generation += 1;
          currentMark = generation;
        }
        add(clist, currentMark, 0, empty, position);
      }
      if (clist.length === 0 && matched !== undefined) break;
      generation += 1;
      const nextMark = generation;
      const code = position < codes.length ? (codes[position] ?? -1) : -1;
      for (const thread of clist) {
        charge();
        const instruction = this.program[thread.pc];
        if (instruction === undefined) continue;
        if (instruction.op === "match") {
          matched = thread.caps;
          // Every thread after this one is lower priority, so the
          // leftmost-first match is already decided and they can be dropped.
          break;
        }
        if (code < 0) continue;
        if (
          instruction.op === "any" ||
          (instruction.op === "set" && inSet(instruction.set, code))
        ) {
          add(nlist, nextMark, thread.pc + 1, thread.caps, position + 1);
        }
      }
      const swap = clist;
      clist = nlist;
      nlist = swap;
      nlist.length = 0;
      currentMark = nextMark;
      if (position >= codes.length) break;
    }
    return matched;
  }
}

/**
 * Compiles a POSIX pattern, refusing anything outside the declared subset.
 *
 * `ignoreCase` folds the twenty-six ASCII pairs while the character sets are
 * built rather than through a Unicode-aware flag, because the runtime declares
 * the C locale.
 */
export function compilePosixRegex(
  pattern: string,
  dialect: PosixRegexDialect,
  command: string,
  options: { readonly ignoreCase?: boolean } = {},
): PosixRegex {
  const parser = new Parser(pattern, dialect === "extended", command, options.ignoreCase === true);
  const parsed = parser.parse();
  return new PosixRegex(compile(parsed.node, command), parsed.groups, command);
}
