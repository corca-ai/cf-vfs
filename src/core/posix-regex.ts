import { VfsError } from "./errors.js";
import {
  type PosixCharSet as CharSet,
  foldPosixRanges as foldRanges,
  POSIX_CLASSES,
} from "./posix-regex-charset.js";
import {
  type PosixRegexInstruction as Instruction,
  posixLiteral,
  runPosixRegex,
} from "./posix-regex-matcher.js";

/**
 * The two POSIX regular-expression dialects this project declares.
 *
 * `basic` is what `grep` and `sed` accept by default; `extended` is what their
 * `-E` forms accept. They differ only in which characters carry a special
 * meaning bare and which need a backslash.
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

type Split = Extract<Instruction, { readonly op: "split" }>;
type Jump = Extract<Instruction, { readonly op: "jmp" }>;

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

  private escapedAtom(): { node: Node; repeatable: boolean } {
    const next = this.at(1);
    if (next === undefined) unsupported(this.command, "trailing backslash");
    if (!this.extended && next === "(") {
      this.index += 2;
      return { node: this.group(2), repeatable: true };
    }
    if (/[A-Za-z0-9<>`']/u.test(next)) unsupported(this.command, `unsupported escape \\${next}`);
    this.index += 2;
    return { node: this.literal(next), repeatable: true };
  }

  private anchorAtom(character: "^" | "$", first: boolean): { node: Node; repeatable: boolean } {
    const anchor =
      character === "^"
        ? this.extended || (first && this.index === 0)
        : this.extended || this.index === this.points.length - 1;
    this.index += 1;
    return anchor
      ? { node: { kind: character === "^" ? "bol" : "eol" }, repeatable: false }
      : { node: this.literal(character), repeatable: true };
  }

  private atom(first: boolean): { node: Node; repeatable: boolean } {
    const character = this.at() ?? "";

    if (character === "\\") return this.escapedAtom();

    if (this.extended && character === "(") {
      this.index += 1;
      return { node: this.group(1), repeatable: true };
    }

    if (character === "[") return { node: this.bracket(), repeatable: true };

    if (character === ".") {
      this.index += 1;
      return { node: { kind: "any" }, repeatable: true };
    }

    if (character === "^" || character === "$") return this.anchorAtom(character, first);

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

  private bracketClass(index: number, ranges: (readonly [number, number])[]): number {
    const close = this.points.indexOf(":", index + 2);
    if (close < 0 || this.points[close + 1] !== "]") unsupported(this.command, "unmatched [:");
    const name = this.points.slice(index + 2, close).join("");
    const known = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined;
    if (known === undefined) unsupported(this.command, `unsupported character class [:${name}:]`);
    ranges.push(...known);
    return close + 1;
  }

  private bracketMember(index: number, ranges: (readonly [number, number])[]): number {
    const character = this.points[index] ?? "";
    const following = this.points[index + 1];
    if (character === "[" && following === ":") return this.bracketClass(index, ranges);
    if (character === "[" && (following === "=" || following === ".")) {
      unsupported(this.command, `unsupported bracket construct [${following}`);
    }
    const point = (value: string): number => value.codePointAt(0) ?? 0;
    const after = this.points[index + 2];
    if (following === "-" && after !== undefined && after !== "]") {
      const low = point(character);
      const high = point(after);
      if (low > high) unsupported(this.command, "invalid range in bracket expression");
      ranges.push([low, high]);
      return index + 2;
    }
    ranges.push([point(character), point(character)]);
    return index;
  }

  private bracket(): Node {
    let index = this.index + 1;
    let negated = false;
    if (this.points[index] === "^") {
      negated = true;
      index += 1;
    }
    const ranges: (readonly [number, number])[] = [];
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
      index = this.bracketMember(index, ranges);
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
        const frame: Split = { op: "split", x: 0, y: 0 };
        push(frame);
        frame.x = program.length;
        emit(current.left);
        const jump: Jump = { op: "jmp", to: 0 };
        push(jump);
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
    const frame: Split = { op: "split", x: 0, y: 0 };
    const at = push(frame);
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
      const frame: Split = { op: "split", x: 0, y: 0 };
      push(frame);
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

function startingOffset(text: string, from: number): number {
  let offset = Number.isNaN(from) ? 0 : Math.max(0, Math.ceil(from));
  const unit = text.charCodeAt(offset);
  const previous = text.charCodeAt(offset - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) offset += 1;
  return offset;
}

function capturedGroups(
  text: string,
  captures: readonly number[],
  slots: number,
): readonly (string | undefined)[] {
  const groups: (string | undefined)[] = [];
  for (let group = 0; group * 2 < slots; group += 1) {
    const open = captures[group * 2] ?? -1;
    const close = captures[group * 2 + 1] ?? -1;
    groups.push(open < 0 || close < 0 ? undefined : text.slice(open, close));
  }
  return groups;
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
  private readonly literal: string | undefined;

  constructor(
    private readonly program: readonly Instruction[],
    groups: number,
    private readonly command: string,
  ) {
    this.slots = (groups + 1) * 2;
    this.literal = groups === 0 ? posixLiteral(program) : undefined;
  }

  test(text: string): boolean {
    if (this.literal !== undefined) return text.includes(this.literal);
    return runPosixRegex(this.program, text, 0, 0, this.command) !== undefined;
  }

  /** Finds the leftmost match at or after the string offset `from`. */
  exec(text: string, from = 0): PosixMatch | undefined {
    // The matcher advances by code point but stores UTF-16 offsets directly.
    // Repeated searches no longer rebuild arrays for the whole input or scan
    // its prefix merely to translate the caller's next offset.
    const start = startingOffset(text, from);
    if (start > text.length) return undefined;
    if (this.literal !== undefined) {
      const index = text.indexOf(this.literal, start);
      return index < 0
        ? undefined
        : { index, end: index + this.literal.length, groups: [this.literal] };
    }
    const found = runPosixRegex(this.program, text, start, this.slots, this.command);
    if (found === undefined) return undefined;
    const groups = capturedGroups(text, found, this.slots);
    return { index: found[0] ?? 0, end: found[1] ?? 0, groups };
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
