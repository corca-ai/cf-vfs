import { matchesGlob } from "../../core/glob.js";
import type { EntryKind, VfsStat } from "../../vfs/types.js";
import { matchesShellPattern } from "../pattern.js";
import type { ShellCommandContext } from "../types.js";
import { type AppletSpec, appletUsageError } from "./applet.js";
import { commandPath } from "./helpers.js";

export interface FindExec {
  readonly argv: readonly string[];
  readonly batch: boolean;
}

/** One visited entry: what `find` would print for it and how deep it is. */
export interface FindEntry {
  readonly stat: VfsStat;
  readonly display: string;
  readonly depth: number;
}

type FindTest = (entry: FindEntry, context: ShellCommandContext) => boolean;

export type FindNode =
  | { readonly kind: "and" | "or"; readonly left: FindNode; readonly right: FindNode }
  | { readonly kind: "not"; readonly operand: FindNode }
  | { readonly kind: "test"; readonly test: FindTest }
  | { readonly kind: "print"; readonly separator: string }
  | { readonly kind: "exec"; readonly exec: FindExec }
  | { readonly kind: "prune" };

export interface FindExpression {
  readonly roots: readonly string[];
  readonly node: FindNode | undefined;
  readonly minDepth: number;
  readonly maxDepth: number | undefined;
}

const TYPE_CODES: Readonly<Record<string, EntryKind>> = { f: "file", d: "directory", l: "symlink" };
const ALWAYS: FindNode = { kind: "test", test: () => true };

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

/** The name `-name` sees: the last component of the path as `find` prints it. */
function displayName(display: string): string {
  const trimmed = display.length > 1 ? display.replace(/\/+$/u, "") : display;
  return trimmed === "/" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function hasAction(node: FindNode | undefined): boolean {
  if (node === undefined) return false;
  if (node.kind === "print" || node.kind === "exec") return true;
  if (node.kind === "not") return hasAction(node.operand);
  if (node.kind === "and" || node.kind === "or")
    return hasAction(node.left) || hasAction(node.right);
  return false;
}

/**
 * Parses GNU `find` operands: roots, then an expression of tests, actions and
 * operators. `!`/`-not` binds tightest, then `-a` (or juxtaposition), then
 * `-o`; parentheses group. `-mindepth` and `-maxdepth` are global options
 * wherever they appear. An expression without an action prints what it
 * selects, as GNU does.
 */
export class FindExpressionParser {
  private index = 0;
  private minDepth = 0;
  private maxDepth: number | undefined;

  constructor(
    private readonly spec: AppletSpec,
    private readonly argv: readonly string[],
  ) {}

  parse(): FindExpression {
    const roots: string[] = [];
    while (this.index < this.argv.length && !this.startsExpression(this.argv[this.index] ?? "")) {
      roots.push(this.argv[this.index++] ?? ".");
    }
    let node = this.index < this.argv.length ? this.parseOr() : undefined;
    if (this.index < this.argv.length) {
      throw appletUsageError(this.spec, `unexpected ${this.argv[this.index] ?? ""}`);
    }
    if (!hasAction(node)) {
      const print: FindNode = { kind: "print", separator: "\n" };
      node = node === undefined ? print : { kind: "and", left: node, right: print };
    }
    return {
      roots: roots.length === 0 ? ["."] : roots,
      node,
      minDepth: this.minDepth,
      maxDepth: this.maxDepth,
    };
  }

  private startsExpression(word: string): boolean {
    return word.startsWith("-") || word === "!" || word === "(";
  }

  private peek(): string | undefined {
    return this.argv[this.index];
  }

  private parseOr(): FindNode {
    let left = this.parseAnd();
    while (this.peek() === "-o" || this.peek() === "-or") {
      this.index += 1;
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): FindNode {
    let left = this.parseUnary();
    for (;;) {
      const next = this.peek();
      if (next === undefined || next === ")" || next === "-o" || next === "-or") return left;
      if (next === "-a" || next === "-and") this.index += 1;
      left = { kind: "and", left, right: this.parseUnary() };
    }
  }

  private parseUnary(): FindNode {
    const word = this.argv[this.index++];
    if (word === undefined) throw appletUsageError(this.spec, "expected an expression");
    if (word === "!" || word === "-not") return { kind: "not", operand: this.parseUnary() };
    if (word === "(") {
      const inner = this.parseOr();
      if (this.argv[this.index++] !== ")") throw appletUsageError(this.spec, "missing )");
      return inner;
    }
    return this.parsePrimary(word);
  }

  private parsePrimary(word: string): FindNode {
    switch (word) {
      case "-name":
      case "-iname":
        return this.nameTest(word === "-iname");
      case "-path":
      case "-wholename":
      case "-ipath":
        return this.pathTest(word === "-ipath");
      case "-type":
        return this.typeTest();
      case "-empty":
        return { kind: "test", test: emptyEntry };
      case "-newer":
        return this.newerTest();
      case "-mtime":
      case "-mmin":
        return this.ageTest(word === "-mtime" ? 86_400_000 : 60_000);
      case "-size":
        return this.sizeTest();
      case "-true":
        return ALWAYS;
      case "-false":
        return { kind: "not", operand: ALWAYS };
      case "-mindepth":
        this.minDepth = this.depthValue(word);
        return ALWAYS;
      case "-maxdepth":
        this.maxDepth = this.depthValue(word);
        return ALWAYS;
      case "-print":
        return { kind: "print", separator: "\n" };
      case "-print0":
        return { kind: "print", separator: "\0" };
      case "-prune":
        return { kind: "prune" };
      case "-exec":
        return { kind: "exec", exec: this.parseExec() };
      default:
        throw appletUsageError(this.spec, `unsupported expression ${word}`);
    }
  }

  private value(option: string, what: string): string {
    const value = this.argv[this.index++];
    if (value === undefined) throw appletUsageError(this.spec, `${option} requires ${what}`);
    return value;
  }

  private nameTest(fold: boolean): FindNode {
    const pattern = this.value(fold ? "-iname" : "-name", "a pattern");
    const wanted = fold ? asciiLower(pattern) : pattern;
    return {
      kind: "test",
      test: (entry) => {
        const name = displayName(entry.display);
        return matchesGlob(fold ? asciiLower(name) : name, wanted);
      },
    };
  }

  /** `-path` matches the printed path, where `*` also matches `/`. */
  private pathTest(fold: boolean): FindNode {
    const pattern = this.value(fold ? "-ipath" : "-path", "a pattern");
    const wanted = fold ? asciiLower(pattern) : pattern;
    return {
      kind: "test",
      test: (entry, context) =>
        matchesShellPattern(
          fold ? asciiLower(entry.display) : entry.display,
          wanted,
          context.budget,
        ),
    };
  }

  private typeTest(): FindNode {
    const value = this.value("-type", "f, d, or l");
    const kinds = value.split(",").map((code) => {
      const kind = Object.hasOwn(TYPE_CODES, code) ? TYPE_CODES[code] : undefined;
      if (kind === undefined) throw appletUsageError(this.spec, "-type must be f, d, or l");
      return kind;
    });
    return { kind: "test", test: (entry) => kinds.includes(entry.stat.kind) };
  }

  /** `-newer FILE`: modified more recently than FILE, which is read once. */
  private newerTest(): FindNode {
    const reference = this.value("-newer", "a file");
    let threshold: number | undefined;
    return {
      kind: "test",
      test: (entry, context) => {
        threshold ??= context.fileSystem.stat(commandPath(context, reference)).modifiedAtMs;
        return entry.stat.modifiedAtMs > threshold;
      },
    };
  }

  /** `-mtime`/`-mmin [+-]N`: whole days or minutes since modification, fractions dropped. */
  private ageTest(unit: number): FindNode {
    const comparison = this.numericComparison(unit === 60_000 ? "-mmin" : "-mtime");
    return {
      kind: "test",
      test: (entry, context) =>
        comparison(Math.floor((context.now() - entry.stat.modifiedAtMs) / unit)),
    };
  }

  /** `-size [+-]N[bcwkMG]`: size in units rounded up, 512-byte blocks by default. */
  private sizeTest(): FindNode {
    const value = this.value("-size", "a size");
    const match = /^([+-]?\d+)([bcwkMG]?)$/u.exec(value);
    if (match === null) throw appletUsageError(this.spec, `invalid -size ${value}`);
    const units: Readonly<Record<string, number>> = {
      "": 512,
      b: 512,
      c: 1,
      w: 2,
      k: 1024,
      M: 1048576,
      G: 1073741824,
    };
    const unit = units[match[2] ?? ""] ?? 512;
    const comparison = comparisonFor(match[1] ?? "0");
    return {
      kind: "test",
      test: (entry) => comparison(Math.ceil(entry.stat.sizeBytes / unit)),
    };
  }

  private numericComparison(option: string): (value: number) => boolean {
    const value = this.value(option, "a number");
    if (!/^[+-]?\d+$/u.test(value))
      throw appletUsageError(this.spec, `${option} requires a number`);
    return comparisonFor(value);
  }

  private depthValue(option: string): number {
    const value = this.value(option, "a non-negative integer");
    if (!/^[0-9]+$/u.test(value)) {
      throw appletUsageError(this.spec, `${option} requires a non-negative integer`);
    }
    return Number(value);
  }

  private parseExec(): FindExec {
    const command: string[] = [];
    let terminator: string | undefined;
    while (this.index < this.argv.length) {
      const word = this.argv[this.index++] ?? "";
      if (word === ";" || word === "+") {
        terminator = word;
        break;
      }
      command.push(word);
    }
    if (terminator === undefined) throw appletUsageError(this.spec, "-exec requires ; or +");
    if (command.length === 0) throw appletUsageError(this.spec, "-exec requires a command");
    const batch = terminator === "+";
    if (batch && command.at(-1) !== "{}") {
      throw appletUsageError(this.spec, "-exec ... + requires {} as the last argument");
    }
    return { argv: command, batch };
  }
}

/** GNU's numeric arguments: `+N` more than N, `-N` less than N, `N` exactly N. */
function comparisonFor(value: string): (actual: number) => boolean {
  const number = Math.abs(Number(value));
  if (value.startsWith("+")) return (actual) => actual > number;
  if (value.startsWith("-")) return (actual) => actual < number;
  return (actual) => actual === number;
}

function emptyEntry(entry: FindEntry, context: ShellCommandContext): boolean {
  if (entry.stat.kind === "directory") return context.fileSystem.list(entry.stat.path).length === 0;
  return entry.stat.kind === "file" && entry.stat.sizeBytes === 0;
}
