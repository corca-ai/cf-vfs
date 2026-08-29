import { VfsError } from "../../core/errors.js";
import { compilePosixRegex, type PosixRegex } from "../../core/posix-regex.js";
import { utf8ByteLength } from "../../core/unicode.js";
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
  readTextLines,
  recursiveInputs,
  writeText,
} from "./helpers.js";

const GREP = {
  name: "grep",
  usage: "[-cinvoFElqrRh] PATTERN [PATH...]",
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
      q: { name: "quiet" },
      r: { name: "recursive" },
      R: { name: "recursive" },
      h: { name: "no-filename" },
      o: { name: "only-matching" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  | "ignore-case"
  | "invert"
  | "line-numbers"
  | "fixed"
  | "extended"
  | "count"
  | "files-with-matches"
  | "quiet"
  | "recursive"
  | "no-filename"
  | "only-matching"
>;

function* matchedParts(
  line: string,
  regular: PosixRegex | undefined,
  needle: string,
  ignoreCase: boolean,
): Generator<string> {
  if (regular === undefined) {
    // Fixed search compares folded text but reports the line's own, so `-i`
    // shows what was there rather than what was compared.
    const haystack = ignoreCase ? asciiLower(line) : line;
    if (needle === "") return;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      yield line.slice(at, at + needle.length);
      at += needle.length - 1;
    }
    return;
  }
  for (let from = 0; from <= line.length; ) {
    const match = regular.exec(line, from);
    if (match === undefined) return;
    if (match.end > match.index) yield line.slice(match.index, match.end);
    from = match.end > match.index ? match.end : match.index + 1;
  }
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

/**
 * Prints records matching a pattern.
 *
 * The pattern is a POSIX basic regular expression, or an extended one under
 * `-E`. It is translated rather than handed to the JavaScript engine, so no
 * JavaScript-only construct can mean something here that it does not mean in
 * `grep`. `-r` walks a directory operand through the paged traversal, so a
 * large subtree costs a bounded number of indexed queries and charges the
 * shared glob budget. `-q` stops at the first match without producing output,
 * which is what a guard wants.
 */
interface GrepInvocation {
  readonly paths: readonly string[];
  readonly regular: PosixRegex | undefined;
  readonly needle: string;
  readonly ignoreCase: boolean;
  readonly invert: boolean;
  readonly lineNumbers: boolean;
  readonly count: boolean;
  readonly filesWithMatches: boolean;
  readonly quiet: boolean;
  readonly recursive: boolean;
  readonly showName: boolean;
  readonly onlyMatching: boolean;
}

function grepExpandsPath(context: ShellCommandContext, path: string): boolean {
  try {
    return context.fileSystem.stat(commandPath(context, path)).kind === "directory";
  } catch {
    return false;
  }
}

function parseGrepInvocation(
  context: ShellCommandContext,
  argv: readonly string[],
): GrepInvocation {
  const parsed = parseAppletOptions(GREP, argv);
  const options = new Set(parsed.options.map((option) => option.name));
  const fixed = options.has("fixed");
  const extended = options.has("extended");
  if (fixed && extended) throw appletUsageError(GREP, "specify at most one of -F and -E");
  const paths = [...parsed.operands];
  const pattern = paths.shift();
  if (pattern === undefined) throw appletUsageError(GREP, "missing pattern");
  if (utf8ByteLength(pattern) > 4096) throw new VfsError("E2BIG", "grep pattern is too large");
  const ignoreCase = options.has("ignore-case");
  const recursive = options.has("recursive");
  const noFilename = options.has("no-filename");
  const regular = fixed
    ? undefined
    : compilePosixRegex(pattern, extended ? "extended" : "basic", GREP.name, {
        ...(ignoreCase ? { ignoreCase: true } : {}),
      });
  const showName =
    !noFilename &&
    (paths.length > 1 ||
      (recursive && (paths.length === 0 || paths.some((path) => grepExpandsPath(context, path)))));
  return {
    paths,
    regular,
    needle: ignoreCase ? asciiLower(pattern) : pattern,
    ignoreCase,
    invert: options.has("invert"),
    lineNumbers: options.has("line-numbers"),
    count: options.has("count"),
    filesWithMatches: options.has("files-with-matches"),
    quiet: options.has("quiet"),
    recursive,
    showName,
    onlyMatching: options.has("only-matching"),
  };
}

class GrepRunner {
  private matches = 0;
  private failed = false;

  constructor(
    private readonly context: ShellCommandContext,
    private readonly invocation: GrepInvocation,
    private readonly fds: ShellFileDescriptors,
    private readonly output: BufferedTextWriter,
  ) {}

  async run(sources: AsyncIterable<CommandInput>): Promise<number> {
    for await (const input of sources) {
      if (await this.runInput(input)) break;
    }
    if (!this.invocation.quiet) await this.output.flush();
    if (this.failed && !this.invocation.quiet) return 2;
    return this.matches > 0 ? 0 : 1;
  }

  private async runInput(input: CommandInput): Promise<boolean> {
    if (input.stream === undefined) {
      await writeText(this.fds[2], `grep: ${input.name}: ${input.error.message}\n`);
      this.failed = true;
      return false;
    }
    let inputMatches = 0;
    let lineNumber = 0;
    for await (const line of readTextLines(this.context, input.stream, input.name)) {
      lineNumber += 1;
      const candidate = line.endsWith("\n") ? line.slice(0, -1) : line;
      if (!this.selected(candidate)) continue;
      this.matches += 1;
      inputMatches += 1;
      if (this.invocation.quiet || this.invocation.filesWithMatches) break;
      if (!this.invocation.count) await this.writeSelected(input.name, lineNumber, line, candidate);
    }
    await this.finishInput(input.name, inputMatches);
    return this.invocation.quiet && this.matches > 0;
  }

  private selected(candidate: string): boolean {
    const found =
      this.invocation.regular === undefined
        ? (this.invocation.ignoreCase ? asciiLower(candidate) : candidate).includes(
            this.invocation.needle,
          )
        : this.invocation.regular.test(candidate);
    return found !== this.invocation.invert;
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
    for (const part of matchedParts(
      candidate,
      this.invocation.regular,
      this.invocation.needle,
      this.invocation.ignoreCase,
    )) {
      await this.output.write(`${prefix}${part}\n`);
    }
  }

  private async finishInput(name: string, matches: number): Promise<void> {
    if (this.invocation.filesWithMatches && matches > 0) {
      await this.output.write(`${name}\n`);
    } else if (this.invocation.count) {
      const prefix = this.invocation.showName ? `${name}:` : "";
      await this.output.write(`${prefix}${matches}\n`);
    }
  }
}

/** Prints records matching a fixed string or a bounded POSIX expression. */
export const grepCommand = /* @__PURE__ */ defineApplet(GREP, async (context, argv, fds) => {
  const invocation = parseGrepInvocation(context, argv);
  const sources = invocation.recursive
    ? recursiveInputs(context, invocation.paths)
    : inputStreams(context, invocation.paths, fds[0]);
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    return await new GrepRunner(context, invocation, fds, output).run(sources);
  } finally {
    output.abort();
  }
});
