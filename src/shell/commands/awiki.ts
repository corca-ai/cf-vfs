import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { defineApplet } from "./applet.js";
import { formatVault } from "./awiki-format.js";
import {
  averageShortestPath,
  documentLine,
  linksReport,
  lint,
  shortestPath,
  wantedReport,
} from "./awiki-graph.js";
import { renameDocument } from "./awiki-rename.js";
import {
  defaultSuggestOptions,
  SUGGEST_FILTERS,
  type SuggestFilter,
  type SuggestOptions,
  suggestReport,
} from "./awiki-suggest.js";
import { debugQuote } from "./awiki-text.js";
import { AwikiError, Vault } from "./awiki-vault.js";
import { commandPath, writeText } from "./helpers.js";

/**
 * `awiki`, the Markdown wiki maintenance CLI, run inside the shell.
 *
 * It follows awiki 0.5.1: the same commands, flags, output, diagnostics and
 * statuses, so its documentation applies unchanged. Inside, a page is parsed
 * once per identity and mutation token and reused by later runs, and `rename`
 * reads only the pages that name the old document.
 */

const VERSION = "0.5.1";

const AWIKI = {
  name: "awiki",
  usage: "<command> [flags]",
  summary: "explores and maintains a flat-file Markdown wiki",
} as const;

const USAGE = `awiki helps maintain the quality of a flat-file Markdown wiki.
Quality here means keeping notes well connected, reducing orphans and disconnected islands, keeping most pages inside one large component,
avoiding empty stubs, and making long paths and heavily linked missing pages easy to inspect.

Commands:
  awiki lint [flags]
      Validate the wiki graph
  awiki format [flags]
      Rewrite Markdown files with awiki's default style
  awiki avg-shortest-path [flags]
      Estimate average shortest path length and print sampled long paths
  awiki path [flags] <from> <to>
      Print the shortest path between two documents
  awiki rename [flags] <old> <new>
      Rename a document and update links to it
  awiki links [flags] <document>
      Show inbound and outbound links for a document
  awiki suggest [flags]
      Show refactoring candidates and graph-quality hints
  awiki wanted [flags]
      Show the most-linked missing pages

Examples:
  awiki path "The China study (book)" "What to Eat"
  awiki links "Books Ive read"

Use \`awiki <command> -h\` for command-specific help.
`;

const SUGGEST_USAGE = `Usage: awiki suggest [flags]
  -root <dir>                 Wiki root, default .
  -recursive, -r              Load Markdown recursively
  --filter <names>            Comma-separated filters
      sampled-diameter,wanted-pressure,long-pages,short-stubs,near-duplicates
  --samples <n>               Path samples for sampled-diameter, default 2000
  --paths <n>                 Longest sampled paths to print, default 5
  -n, --limit <n>             Rows per section, default 10
  --long-lines <n>            Long page line threshold, default 120
  --long-words <n>            Long page word threshold, default 1200
  --short-words <n>           Short stub word threshold, default 40
  --duplicate-threshold <x>   Near-duplicate score threshold, default 0.82
`;

/** Printed to standard error with status 0, as a command's `-h`. */
class Help extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

/** Ends the command with `status`, after whatever was already written. */
class Exit extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

interface Common {
  readonly root: string;
  readonly recursive: boolean;
  readonly rest: readonly string[];
}

const HELP = new Set(["-h", "-help", "--help"]);

function parseCommon(args: readonly string[]): Common {
  let root = ".";
  let recursive = false;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (HELP.has(arg)) throw new AwikiError("__help__");
    if (arg === "-root") {
      index += 1;
      root = flagValue(args, index, "-root");
    } else if (arg === "-recursive" || arg === "-r") recursive = true;
    else if (arg.startsWith("-")) throw new AwikiError(`flag provided but not defined: ${arg}`);
    else rest.push(arg);
  }
  return { root, recursive, rest };
}

/** `-h` prints a usage line for the commands that handle it themselves. */
function parseCommonWithHelp(args: readonly string[], usage: string): Common {
  try {
    return parseCommon(args);
  } catch (error) {
    if (error instanceof AwikiError && error.message === "__help__") throw new Help(usage);
    throw error;
  }
}

const U64_MAX = (1n << 64n) - 1n;

function parseUnsigned(value: string, message: string): bigint {
  if (!/^\+?[0-9]+$/u.test(value)) throw new AwikiError(message);
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new AwikiError(message);
  return parsed;
}

function parseCount(value: string, message: string): number {
  return Number(parseUnsigned(value, message));
}

/** Rust's `f64::from_str`. */
function parseFloat64(value: string, message: string): number {
  if (/^[+-]?(inf|infinity)$/iu.test(value)) return value.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/iu.test(value)) return Number.NaN;
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/u.test(value)) {
    throw new AwikiError(message);
  }
  return Number(value);
}

function flagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) throw new AwikiError(`flag needs an argument: ${flag}`);
  return value;
}

async function load(context: ShellCommandContext, common: Common): Promise<Vault> {
  return await Vault.load(context, commandPath(context, common.root), common.recursive);
}

type Output = (text: string) => void;

async function lintCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const common = parseCommonWithHelp(args, "Usage: awiki lint [flags]");
  const report = lint(await load(context, common));
  out(report.text);
  if (report.failed) throw new Exit(1);
}

async function formatCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const common = parseCommonWithHelp(args, "Usage: awiki format [flags]");
  if (common.rest.length > 0) throw new AwikiError("format does not accept positional arguments");
  const vault = await load(context, common);
  const changed = await formatVault(context, vault);
  out(`// format documents=${vault.documents.length} changed=${changed.length}`);
  for (const relPath of changed) out(relPath);
}

async function linksCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const common = parseCommonWithHelp(args, "Usage: awiki links [flags] <document>");
  if (common.rest.length !== 1)
    throw new AwikiError("links requires exactly one document argument");
  const vault = await load(context, common);
  out(linksReport(vault, vault.resolveDocument(common.rest[0] ?? "")));
}

async function pathCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const common = parseCommonWithHelp(args, "Usage: awiki path [flags] <from> <to>");
  if (common.rest.length !== 2)
    throw new AwikiError("path requires exactly two document arguments");
  const vault = await load(context, common);
  const from = vault.resolveDocument(common.rest[0] ?? "");
  const to = vault.resolveDocument(common.rest[1] ?? "");
  const path = shortestPath(vault, from, to);
  if (path === undefined) {
    throw new AwikiError(
      `no path between ${debugQuote(vault.doc(from).name)} and ${debugQuote(vault.doc(to).name)}`,
    );
  }
  for (const index of path) out(documentLine(vault, index));
}

async function wantedCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const rest: string[] = [];
  let limit = 10;
  let sources = 10;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-n") {
      index += 1;
      limit = parseCount(flagValue(args, index, "-n"), "wanted limit must not be negative");
    } else if (arg === "-sources") {
      index += 1;
      sources = parseCount(
        flagValue(args, index, "-sources"),
        "wanted sources must not be negative",
      );
    } else rest.push(arg);
  }
  const common = parseCommonWithHelp(rest, "Usage: awiki wanted [flags]");
  if (common.rest.length > 0) throw new AwikiError("wanted does not accept positional arguments");
  out(wantedReport(await load(context, common), limit, sources));
}

async function averageCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const rest: string[] = [];
  let samples = 500;
  let examples = 1;
  let seed = 1n;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-samples") {
      index += 1;
      samples = parseCount(flagValue(args, index, "-samples"), "sample count must be positive");
    } else if (arg === "-examples") {
      index += 1;
      examples = parseCount(flagValue(args, index, "-examples"), "invalid examples");
    } else if (arg === "-seed") {
      index += 1;
      seed = parseUnsigned(flagValue(args, index, "-seed"), "invalid seed");
    } else rest.push(arg);
  }
  const vault = await load(
    context,
    parseCommonWithHelp(rest, "Usage: awiki avg-shortest-path [flags]"),
  );
  out(averageShortestPath(vault, samples, examples, seed));
}

async function renameCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const common = parseCommonWithHelp(args, "Usage: awiki rename [flags] <old> <new>");
  if (common.rest.length !== 2)
    throw new AwikiError("rename requires exactly two document arguments");
  const vault = await load(context, common);
  const result = await renameDocument(context, vault, common.rest[0] ?? "", common.rest[1] ?? "");
  out(`// rename old=${result.oldName}.md new=${result.newName}.md`);
  out(
    `// links_updated=${result.linksUpdated} files_touched=${result.filesTouched} title_updated=${result.titleUpdated}`,
  );
}

function parseFilters(value: string): SuggestFilter[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      if (!(SUGGEST_FILTERS as readonly string[]).includes(part)) {
        throw new AwikiError(`unknown suggest filter: ${part}`);
      }
      return part as SuggestFilter;
    });
}

type SuggestFlag = (options: SuggestOptions, value: string) => void;

const SUGGEST_FLAGS: Readonly<Record<string, readonly [string, SuggestFlag]>> = {
  filter: [
    "--filter",
    (o, v) => {
      o.filters = parseFilters(v);
    },
  ],
  samples: [
    "--samples",
    (o, v) => {
      o.samples = parseCount(v, "sample count must not be negative");
    },
  ],
  paths: [
    "--paths",
    (o, v) => {
      o.paths = parseCount(v, "path count must not be negative");
    },
  ],
  limit: [
    "--limit",
    (o, v) => {
      o.limit = parseCount(v, "limit must not be negative");
    },
  ],
  seed: [
    "--seed",
    (o, v) => {
      o.seed = parseUnsigned(v, "invalid seed");
    },
  ],
  "long-lines": [
    "--long-lines",
    (o, v) => {
      o.longLines = parseCount(v, "long line threshold must not be negative");
    },
  ],
  "long-words": [
    "--long-words",
    (o, v) => {
      o.longWords = parseCount(v, "long word threshold must not be negative");
    },
  ],
  "short-words": [
    "--short-words",
    (o, v) => {
      o.shortWords = parseCount(v, "short stub threshold must not be negative");
    },
  ],
  "duplicate-threshold": [
    "--duplicate-threshold",
    (o, v) => {
      o.duplicateThreshold = parseFloat64(v, "invalid duplicate threshold");
    },
  ],
};

/** Spellings that take a value: `-x v`, `--x v` and `--x=v`, with the single-dash forms the native parser accepts. */
const SINGLE_DASH = new Set(["filter", "samples", "paths", "limit", "seed"]);

interface SpelledFlag {
  readonly key: string;
  readonly flag: readonly [string, SuggestFlag];
  /** The value written as `--flag=value`, when it was. */
  readonly inline: string | undefined;
}

/** A suggest flag as the native parser spells it, or `undefined` for anything else. */
function suggestFlag(arg: string): SpelledFlag | undefined {
  const double = arg.startsWith("--");
  const name = arg === "-n" ? "limit" : arg.slice(double ? 2 : 1);
  const equals = double ? name.indexOf("=") : -1;
  const key = equals < 0 ? name : name.slice(0, equals);
  const flag = SUGGEST_FLAGS[key];
  if (flag === undefined || !arg.startsWith("-")) return undefined;
  if (!double && arg !== "-n" && !SINGLE_DASH.has(key)) return undefined;
  return { key, flag, inline: equals < 0 ? undefined : name.slice(equals + 1) };
}

function validateSuggest(options: SuggestOptions, customFilter: boolean): void {
  if (customFilter && options.filters.length === 0) {
    throw new AwikiError("suggest filter must not be empty");
  }
  // NaN passes, as in the native comparison.
  const threshold = options.duplicateThreshold;
  if (threshold <= 0 || threshold > 1)
    throw new AwikiError("duplicate threshold must be in (0, 1]");
}

async function suggestCommand(context: ShellCommandContext, args: readonly string[], out: Output) {
  const options = defaultSuggestOptions();
  const rest: string[] = [];
  let customFilter = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (HELP.has(arg)) throw new Help(SUGGEST_USAGE);
    const spelled = suggestFlag(arg);
    if (spelled === undefined) {
      rest.push(arg);
      continue;
    }
    if (spelled.inline === undefined) index += 1;
    spelled.flag[1](options, spelled.inline ?? flagValue(args, index, spelled.flag[0]));
    customFilter ||= spelled.key === "filter";
  }
  validateSuggest(options, customFilter);
  const common = parseCommon(rest);
  if (common.rest.length > 0) throw new AwikiError("suggest does not accept positional arguments");
  out(await suggestReport(context, await load(context, common), options));
}

const COMMANDS: Readonly<
  Record<
    string,
    (context: ShellCommandContext, args: readonly string[], out: Output) => Promise<void>
  >
> = {
  lint: lintCommand,
  format: formatCommand,
  links: linksCommand,
  path: pathCommand,
  suggest: suggestCommand,
  wanted: wantedCommand,
  "avg-shortest-path": averageCommand,
  rename: renameCommand,
};

/** Help, version and unknown commands, which load no wiki; `undefined` for a real command. */
async function meta(
  command: string | undefined,
  args: readonly string[],
  fds: ShellFileDescriptors,
): Promise<number | undefined> {
  if (command === undefined) {
    await writeText(fds[2], USAGE);
    return 2;
  }
  if (command === "help" || HELP.has(command)) {
    await writeText(fds[2], USAGE);
    return 0;
  }
  const version = ["version", "--version", "-version"];
  const known = COMMANDS[command] !== undefined;
  if (version.includes(command) || (!known && args.some((arg) => version.includes(arg)))) {
    await writeText(fds[1], `${VERSION}\n`);
    return 0;
  }
  if (known) return undefined;
  await writeText(fds[2], `awiki: unknown command ${debugQuote(command)}\n\n${USAGE}`);
  return 2;
}

/** The status and diagnostic a failed command ends with. */
async function failure(error: unknown, fds: ShellFileDescriptors): Promise<number> {
  if (error instanceof Help) {
    await writeText(fds[2], error.text.endsWith("\n") ? error.text : `${error.text}\n`);
    return 0;
  }
  if (error instanceof Exit) return error.status;
  if (error instanceof AwikiError) {
    await writeText(fds[2], `awiki: ${error.message}\n`);
    return 1;
  }
  throw error;
}

async function run(
  context: ShellCommandContext,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const [command, ...args] = argv;
  const status = await meta(command, args, fds);
  const handler = command === undefined ? undefined : COMMANDS[command];
  if (status !== undefined || handler === undefined) return status ?? 2;
  let stdout = "";
  const out: Output = (text) => {
    stdout += `${text}\n`;
  };
  try {
    await handler(context, args, out);
    return 0;
  } catch (error) {
    if (stdout !== "") await writeText(fds[1], stdout);
    stdout = "";
    return await failure(error, fds);
  } finally {
    if (stdout !== "") await writeText(fds[1], stdout);
  }
}

export const awikiCommand = /* @__PURE__ */ defineApplet(AWIKI, run);
