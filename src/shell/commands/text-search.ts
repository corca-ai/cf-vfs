import { VfsError } from "../../core/errors.js";
import { matchesGlob } from "../../core/glob.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import {
  BufferedTextWriter,
  type CommandInput,
  commandPath,
  inputStreams,
  parseInteger,
  readFileText,
  readTextLines,
  recursiveInputs,
  writeText,
} from "./helpers.js";
import { GrepMatcher } from "./text-search-match.js";

type GrepOption =
  | "ignore-case"
  | "invert"
  | "line-numbers"
  | "fixed"
  | "extended"
  | "count"
  | "files-with-matches"
  | "files-without-match"
  | "line-regexp"
  | "word-regexp"
  | "quiet"
  | "recursive"
  | "with-filename"
  | "no-filename"
  | "no-messages"
  | "only-matching"
  | "regexp"
  | "file"
  | "after"
  | "before"
  | "context"
  | "max-count"
  | "include"
  | "exclude"
  | "exclude-dir";

const GREP = {
  name: "grep",
  usage: "[-cinvowxFEHlLqrRhs] [-e PATTERN]... [-f FILE] [-A|-B|-C N] [-m N] PATTERN [PATH...]",
  summary: "prints records matching a pattern",
  options: {
    short: {
      i: { name: "ignore-case" },
      v: { name: "invert" },
      n: { name: "line-numbers" },
      F: { name: "fixed" },
      E: { name: "extended" },
      c: { name: "count" },
      l: { name: "files-with-matches" },
      L: { name: "files-without-match" },
      x: { name: "line-regexp" },
      w: { name: "word-regexp" },
      q: { name: "quiet" },
      r: { name: "recursive" },
      R: { name: "recursive" },
      H: { name: "with-filename" },
      h: { name: "no-filename" },
      s: { name: "no-messages" },
      o: { name: "only-matching" },
      e: { name: "regexp", argument: true },
      f: { name: "file", argument: true },
      A: { name: "after", argument: true },
      B: { name: "before", argument: true },
      C: { name: "context", argument: true },
      m: { name: "max-count", argument: true },
    },
    long: {
      "ignore-case": { name: "ignore-case" },
      "invert-match": { name: "invert" },
      "line-number": { name: "line-numbers" },
      "fixed-strings": { name: "fixed" },
      "extended-regexp": { name: "extended" },
      count: { name: "count" },
      "files-with-matches": { name: "files-with-matches" },
      "files-without-match": { name: "files-without-match" },
      "line-regexp": { name: "line-regexp" },
      "word-regexp": { name: "word-regexp" },
      quiet: { name: "quiet" },
      silent: { name: "quiet" },
      recursive: { name: "recursive" },
      "with-filename": { name: "with-filename" },
      "no-filename": { name: "no-filename" },
      "no-messages": { name: "no-messages" },
      "only-matching": { name: "only-matching" },
      regexp: { name: "regexp", argument: true },
      file: { name: "file", argument: true },
      "after-context": { name: "after", argument: true },
      "before-context": { name: "before", argument: true },
      context: { name: "context", argument: true },
      "max-count": { name: "max-count", argument: true },
      include: { name: "include", argument: true },
      exclude: { name: "exclude", argument: true },
      "exclude-dir": { name: "exclude-dir", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<GrepOption>;

interface GrepOutputMode {
  readonly invert: boolean;
  readonly lineNumbers: boolean;
  readonly count: boolean;
  readonly filesWithMatches: boolean;
  readonly filesWithoutMatch: boolean;
  readonly quiet: boolean;
  readonly onlyMatching: boolean;
  readonly noMessages: boolean;
  readonly before: number;
  readonly after: number;
  readonly maxCount: number | undefined;
}

/**
 * Prints records matching a pattern.
 *
 * Patterns are POSIX basic regular expressions, extended ones under `-E`, or
 * fixed strings under `-F`; `-e` and `-f` supply several, and a line is
 * selected when any matches. They are translated rather than handed to the
 * JavaScript engine, so no JavaScript-only construct can mean something here
 * that it does not mean in `grep`. `-r` walks a directory operand through the
 * paged traversal, filtered by `--include`, `--exclude` and `--exclude-dir`.
 * `-q` stops at the first match without producing output.
 */
interface GrepInvocation extends GrepOutputMode {
  readonly paths: readonly string[];
  readonly matcher: GrepMatcher;
  readonly recursive: boolean;
  readonly showName: boolean;
  readonly accept: (name: string) => boolean;
}

function grepExpandsPath(context: ShellCommandContext, path: string): boolean {
  try {
    return context.fileSystem.stat(commandPath(context, path)).kind === "directory";
  } catch {
    return false;
  }
}

type ParsedGrep = ReturnType<typeof parseAppletOptions<GrepOption>>;

function values(parsed: ParsedGrep, name: GrepOption): string[] {
  return parsed.options.flatMap((option) =>
    option.name === name && "argument" in option ? [option.argument] : [],
  );
}

function lastCount(parsed: ParsedGrep, names: readonly GrepOption[]): number | undefined {
  const option = parsed.options.filter((candidate) => names.includes(candidate.name)).at(-1);
  return option !== undefined && "argument" in option
    ? parseInteger(option.argument, `${GREP.name}: ${option.name}`)
    : undefined;
}

/** `-e` and `-f` patterns, or else the first operand; a pattern file has one per line. */
async function patternsFor(
  context: ShellCommandContext,
  parsed: ParsedGrep,
  operands: string[],
): Promise<string[]> {
  const patterns = values(parsed, "regexp");
  const files = values(parsed, "file");
  for (const path of files) {
    const text = await readFileText(context, path);
    try {
      const lines = text.value.split("\n");
      if (lines.at(-1) === "") lines.pop();
      patterns.push(...lines);
    } finally {
      text.release();
    }
  }
  if (patterns.length > 0 || files.length > 0) return patterns;
  const pattern = operands.shift();
  if (pattern === undefined) throw appletUsageError(GREP, "missing pattern");
  return [pattern];
}

/** `--include` and `--exclude` test a walked file's name, `--exclude-dir` each directory on its path. */
function walkFilter(parsed: ParsedGrep): (name: string) => boolean {
  const include = values(parsed, "include");
  const exclude = values(parsed, "exclude");
  const excludeDirectories = values(parsed, "exclude-dir");
  return (name) => {
    const components = name.split("/").filter((component) => component !== "");
    const base = components.at(-1) ?? name;
    if (include.length > 0 && !include.some((glob) => matchesGlob(base, glob))) return false;
    if (exclude.some((glob) => matchesGlob(base, glob))) return false;
    return !components
      .slice(0, -1)
      .some((directory) => excludeDirectories.some((glob) => matchesGlob(directory, glob)));
  };
}

function outputMode(parsed: ParsedGrep, has: (name: GrepOption) => boolean): GrepOutputMode {
  const context = lastCount(parsed, ["context"]);
  return {
    invert: has("invert"),
    lineNumbers: has("line-numbers"),
    count: has("count"),
    filesWithMatches: has("files-with-matches"),
    filesWithoutMatch: has("files-without-match"),
    quiet: has("quiet"),
    onlyMatching: has("only-matching"),
    noMessages: has("no-messages"),
    before: lastCount(parsed, ["before"]) ?? context ?? 0,
    after: lastCount(parsed, ["after"]) ?? context ?? 0,
    maxCount: lastCount(parsed, ["max-count"]),
  };
}

async function parseGrepInvocation(
  context: ShellCommandContext,
  argv: readonly string[],
): Promise<GrepInvocation> {
  const parsed = parseAppletOptions(GREP, argv);
  const names = new Set(parsed.options.map((option) => option.name));
  const has = (name: GrepOption): boolean => names.has(name);
  if (has("fixed") && has("extended")) {
    throw appletUsageError(GREP, "specify at most one of -F and -E");
  }
  const paths = [...parsed.operands];
  const patterns = await patternsFor(context, parsed, paths);
  const recursive = has("recursive");
  const matcher = new GrepMatcher(patterns, {
    fixed: has("fixed"),
    extended: has("extended"),
    ignoreCase: has("ignore-case"),
    line: has("line-regexp"),
    word: has("word-regexp"),
  });
  const several =
    paths.length > 1 ||
    (recursive && (paths.length === 0 || paths.some((path) => grepExpandsPath(context, path))));
  return {
    ...outputMode(parsed, has),
    paths,
    matcher,
    recursive,
    showName: has("with-filename") || (!has("no-filename") && several),
    accept: walkFilter(parsed),
  };
}

/** Selected lines with their context, `--` between groups that do not touch. */
class GrepContext {
  private readonly before: Array<{ line: string; number: number }> = [];
  private afterRemaining = 0;
  private lastPrinted = 0;
  private printedAny = false;

  constructor(
    private readonly invocation: GrepInvocation,
    private readonly output: BufferedTextWriter,
  ) {}

  private get active(): boolean {
    return this.invocation.before > 0 || this.invocation.after > 0;
  }

  get trailing(): boolean {
    return this.afterRemaining > 0;
  }

  startInput(): void {
    this.before.length = 0;
    this.afterRemaining = 0;
    this.lastPrinted = 0;
  }

  async unselected(name: string, number: number, line: string): Promise<void> {
    if (this.afterRemaining > 0) {
      this.afterRemaining -= 1;
      await this.write(name, number, line, "-");
      return;
    }
    if (this.invocation.before === 0) return;
    this.before.push({ line, number });
    if (this.before.length > this.invocation.before) this.before.shift();
  }

  async selected(number: number, name: string, body: () => Promise<void>): Promise<void> {
    for (const held of this.before.splice(0)) await this.write(name, held.number, held.line, "-");
    await this.separate(number);
    await body();
    this.lastPrinted = number;
    this.printedAny = true;
    this.afterRemaining = this.invocation.after;
  }

  private async separate(number: number): Promise<void> {
    if (
      this.active &&
      this.printedAny &&
      (this.lastPrinted === 0 || number > this.lastPrinted + 1)
    ) {
      await this.output.write("--\n");
    }
  }

  private async write(
    name: string,
    number: number,
    line: string,
    separator: string,
  ): Promise<void> {
    await this.separate(number);
    const prefix = `${this.invocation.showName ? `${name}${separator}` : ""}${
      this.invocation.lineNumbers ? `${number}${separator}` : ""
    }`;
    await this.output.write(`${prefix}${line}${line.endsWith("\n") ? "" : "\n"}`);
    this.lastPrinted = number;
    this.printedAny = true;
  }
}

class GrepRunner {
  private matches = 0;
  private failed = false;
  private readonly lines: GrepContext;

  constructor(
    private readonly context: ShellCommandContext,
    private readonly invocation: GrepInvocation,
    private readonly fds: ShellFileDescriptors,
    private readonly output: BufferedTextWriter,
  ) {
    this.lines = new GrepContext(invocation, output);
  }

  async run(sources: AsyncIterable<CommandInput>): Promise<number> {
    for await (const input of sources) {
      if (await this.runInput(input)) break;
    }
    if (!this.invocation.quiet) await this.output.flush();
    if (this.failed && !this.invocation.quiet) return 2;
    return this.matches > 0 ? 0 : 1;
  }

  /** Modes that only need to know whether a file has a match. */
  private get listsFiles(): boolean {
    return (
      this.invocation.quiet || this.invocation.filesWithMatches || this.invocation.filesWithoutMatch
    );
  }

  private get printsLines(): boolean {
    return !this.invocation.count && !this.listsFiles;
  }

  private async runInput(input: CommandInput): Promise<boolean> {
    if (input.stream === undefined) {
      if (!this.invocation.noMessages) {
        await writeText(this.fds[2], `grep: ${input.name}: ${input.error.message}\n`);
      }
      this.failed = true;
      return false;
    }
    this.lines.startInput();
    const matches = await this.scan(input.name, input.stream);
    await this.finishInput(input.name, matches);
    return this.invocation.quiet && this.matches > 0;
  }

  /** Reads one input, returning how many of its lines were selected. */
  private async scan(name: string, stream: ReadableStream<Uint8Array>): Promise<number> {
    let inputMatches = 0;
    let lineNumber = 0;
    const limit = this.invocation.maxCount ?? Number.POSITIVE_INFINITY;
    for await (const line of readTextLines(this.context, stream, name)) {
      lineNumber += 1;
      // After `-m` matches only trailing context is still printed.
      const exhausted = inputMatches >= limit;
      if (exhausted && !this.lines.trailing) break;
      if (!(await this.consider(name, lineNumber, line, exhausted))) continue;
      this.matches += 1;
      inputMatches += 1;
      if (this.listsFiles) break;
    }
    return inputMatches;
  }

  /** Prints one line as a match or as context, returning whether it was selected. */
  private async consider(
    name: string,
    lineNumber: number,
    line: string,
    exhausted: boolean,
  ): Promise<boolean> {
    const candidate = line.endsWith("\n") ? line.slice(0, -1) : line;
    const selected = !exhausted && this.selected(candidate);
    if (!this.printsLines) return selected;
    if (!selected) await this.lines.unselected(name, lineNumber, line);
    else {
      await this.lines.selected(lineNumber, name, () =>
        this.writeSelected(name, lineNumber, line, candidate),
      );
    }
    return selected;
  }

  private selected(candidate: string): boolean {
    return this.invocation.matcher.selects(candidate) !== this.invocation.invert;
  }

  private async writeSelected(
    name: string,
    lineNumber: number,
    line: string,
    candidate: string,
  ): Promise<void> {
    const prefix = `${this.invocation.showName ? `${name}:` : ""}${
      this.invocation.lineNumbers ? `${lineNumber}:` : ""
    }`;
    if (!this.invocation.onlyMatching) {
      await this.output.write(`${prefix}${line}${line.endsWith("\n") ? "" : "\n"}`);
      return;
    }
    if (this.invocation.invert) return;
    for (const part of this.invocation.matcher.parts(candidate)) {
      await this.output.write(`${prefix}${part}\n`);
    }
  }

  private async finishInput(name: string, matches: number): Promise<void> {
    if (this.invocation.filesWithMatches && matches > 0) {
      await this.output.write(`${name}\n`);
    } else if (this.invocation.filesWithoutMatch) {
      // Status still follows selected lines, as GNU grep 3.5 and later restored.
      if (matches === 0) await this.output.write(`${name}\n`);
    } else if (this.invocation.count) {
      const prefix = this.invocation.showName ? `${name}:` : "";
      await this.output.write(`${prefix}${matches}\n`);
    }
  }
}

/** Operand inputs where one unreadable file is that file's error, as `grep` reports it. */
async function* operandInputs(
  context: ShellCommandContext,
  paths: readonly string[],
  stdin: ShellFileDescriptors[0],
): AsyncGenerator<CommandInput> {
  if (paths.length === 0) {
    yield* inputStreams(context, paths, stdin);
    return;
  }
  for (const path of paths) {
    try {
      yield* inputStreams(context, [path], stdin);
    } catch (error) {
      if (!(error instanceof VfsError)) throw error;
      yield { name: path, error };
    }
  }
}

/** Prints records matching fixed strings or bounded POSIX expressions. */
export const grepCommand = /* @__PURE__ */ defineApplet(GREP, async (context, argv, fds) => {
  const invocation = await parseGrepInvocation(context, argv);
  const sources = invocation.recursive
    ? recursiveInputs(context, invocation.paths, invocation.accept)
    : operandInputs(context, invocation.paths, fds[0]);
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    return await new GrepRunner(context, invocation, fds, output).run(sources);
  } finally {
    output.abort();
  }
});
