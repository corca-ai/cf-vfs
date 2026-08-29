import { normalizePath } from "../core/path.js";
import { utf8ByteLength } from "../core/unicode.js";
import type { VfsStat } from "../vfs/types.js";

/**
 * What a candidate replaces, so a client can render it without re-parsing.
 *
 * `command` and `variable` are complete on their own; a `directory` is a step
 * on the way somewhere, which is why it is distinguished from a `path` — a
 * client appends a separator to one and a space to the other.
 */
export type CompletionKind = "command" | "path" | "directory" | "variable";

export interface CompletionCandidate {
  /** The text that replaces the word being completed. */
  readonly value: string;
  readonly kind: CompletionKind;
}

export interface CompletionResult {
  /** Offsets of the word being replaced, so the client edits without guessing. */
  readonly start: number;
  readonly end: number;
  readonly candidates: readonly CompletionCandidate[];
  /**
   * The longest text every candidate begins with.
   *
   * Sent because the client cannot compute it without the candidates it did
   * not receive: with `truncated` set, the common prefix is still exact for
   * the ones that were dropped, so typing it never has to be undone.
   */
  readonly commonPrefix: string;
  /** Set when the caps stopped the search before it ran out of answers. */
  readonly truncated: boolean;
  /** Entries examined, so a caller can see what a request cost. */
  readonly scanned: number;
}

export interface CompletionLimits {
  /** How many candidates are returned. */
  readonly maxCandidates: number;
  /** How many namespace entries may be examined, across all pages. */
  readonly maxScanned: number;
  /** How long a word may be before completion declines to work on it. */
  readonly maxWordBytes: number;
}

export const DEFAULT_COMPLETION_LIMITS: CompletionLimits = {
  maxCandidates: 64,
  maxScanned: 2048,
  maxWordBytes: 1024,
};

/** The filesystem slice completion needs: one paged listing, nothing else. */
type CompletionFileSystem = {
  listPage(
    path: string,
    options?: { cursor?: string; limit?: number },
  ): { entries: VfsStat[]; nextCursor: string | null; scanned: number };
};

export interface CompletionContext {
  /**
   * The names a bare word may complete to.
   *
   * Supplied rather than discovered, because completion must not decide which
   * registry a session has — importing the default one to answer would put
   * every applet in the bundle of a shell that registered three.
   */
  readonly commands: readonly string[];
  /** Directories a command name also spells, when PATH lookup is enabled. */
  readonly appletDirectories?: readonly string[];
  readonly fileSystem: CompletionFileSystem;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly limits?: Partial<CompletionLimits>;
}

/** Characters that end a word for completion purposes. */
const WORD_BREAK = new Set([" ", "\t", "\n", "|", "&", ";", "(", ")", "<", ">"]);

/**
 * Breaks after which a word is a command name.
 *
 * `<` and `>` are absent: what follows a redirection is a file, so `echo hi >
 * c` completes `cache.txt` rather than `cat`.
 */
const COMMAND_BREAK = new Set(["|", "&", ";", "(", ")"]);

/** Where the word under the cursor starts, honouring backslash escapes. */
function wordStart(line: string, cursor: number): number {
  let at = cursor;
  while (at > 0) {
    const character = line[at - 1] ?? "";
    if (WORD_BREAK.has(character) && line[at - 2] !== "\\") break;
    at -= 1;
  }
  return at;
}

/**
 * Whether the word being completed is the first of its command.
 *
 * Only a command position completes command names, which is what makes `cat
 * REA<tab>` offer a file and `RE<tab>` offer nothing but a path — the same
 * distinction a shell makes, drawn without parsing the line.
 */
function inCommandPosition(line: string, start: number): boolean {
  const before = line.slice(0, start).trimEnd();
  if (before === "") return true;
  return COMMAND_BREAK.has(before.at(-1) ?? "");
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0] ?? "";
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index] === value[index]) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (prefix === "") break;
  }
  return prefix;
}

/**
 * Offers what could come next at the cursor.
 *
 * Deliberately not a parse. Completion runs on a line that is usually
 * incomplete — that is when it is asked for — so it reads backwards from the
 * cursor for a word and decides from what precedes it. A parser would have to
 * refuse most of the lines a user completes on.
 *
 * Every search is capped: candidates returned, namespace entries examined
 * across all pages, and the length of a word worth working on. The result
 * reports what it scanned so a caller can see the cost of a keystroke, and
 * says when a cap stopped it rather than pretending it found everything.
 */
export function completeShellLine(
  line: string,
  cursor: number,
  context: CompletionContext,
): CompletionResult {
  const limits = { ...DEFAULT_COMPLETION_LIMITS, ...context.limits };
  const at = Math.max(0, Math.min(cursor, line.length));
  const start = wordStart(line, at);
  const word = line.slice(start, at);
  const empty: CompletionResult = {
    start,
    end: at,
    candidates: [],
    commonPrefix: "",
    truncated: false,
    scanned: 0,
  };
  if (utf8ByteLength(word) > limits.maxWordBytes) return empty;

  if (word.startsWith("$"))
    return complete(variableCandidates(word, context), start, at, limits, 0);
  if (inCommandPosition(line, start)) {
    // A command position completes names, and also the applet directory
    // spellings of them — `/bin/ec` is a command, not a path that happens to
    // live under `/bin`. Any other word with a separator is a path.
    const spellsApplet = (context.appletDirectories ?? []).some((directory) =>
      word.startsWith(`${directory}/`),
    );
    if (!word.includes("/") || spellsApplet) {
      return complete(commandCandidates(word, context), start, at, limits, 0);
    }
  }
  return pathCompletion(word, start, at, context, limits);
}

function variableCandidates(word: string, context: CompletionContext): CompletionCandidate[] {
  const braced = word.startsWith("${");
  const prefix = word.slice(braced ? 2 : 1);
  return Object.keys(context.env)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .map((name) => ({ value: braced ? `\${${name}}` : `$${name}`, kind: "variable" as const }));
}

function commandCandidates(word: string, context: CompletionContext): CompletionCandidate[] {
  const names = new Set<string>();
  for (const name of context.commands) if (name.startsWith(word)) names.add(name);
  // A command is also spelled as a path under each applet directory, so a word
  // that begins one of those offers the same names there.
  for (const directory of context.appletDirectories ?? []) {
    const prefix = `${directory}/`;
    // Only once the word reaches the directory: a bare `/` is a path, and
    // answering it with every applet would hide the real root.
    if (!word.startsWith(prefix)) continue;
    for (const name of context.commands) {
      const spelled = `${prefix}${name}`;
      if (spelled.startsWith(word)) names.add(spelled);
    }
  }
  return [...names].sort().map((value) => ({ value, kind: "command" as const }));
}

class PathCandidateScan {
  readonly candidates: CompletionCandidate[] = [];
  matched = 0;
  commonPrefix: string | undefined;
  scanned = 0;
  truncated = false;
  cursor: string | undefined;

  constructor(
    readonly typedDirectory: string,
    readonly prefix: string,
    readonly limits: CompletionLimits,
  ) {}

  add(entries: readonly VfsStat[]): void {
    for (const entry of entries) {
      if (!entry.name.startsWith(this.prefix)) continue;
      const directory = entry.kind === "directory";
      const value = `${this.typedDirectory}${entry.name}${directory ? "/" : ""}`;
      this.matched += 1;
      this.commonPrefix =
        this.commonPrefix === undefined ? value : longestCommonPrefix([this.commonPrefix, value]);
      if (this.candidates.length >= this.limits.maxCandidates) this.truncated = true;
      else this.candidates.push({ value, kind: directory ? "directory" : "path" });
    }
  }

  get done(): boolean {
    return this.cursor === undefined || this.truncated || this.scanned >= this.limits.maxScanned;
  }
}

function scanPathCandidates(
  listed: string,
  scan: PathCandidateScan,
  context: CompletionContext,
): void {
  do {
    const page = context.fileSystem.listPage(listed, {
      limit: Math.min(256, scan.limits.maxScanned - scan.scanned),
      ...(scan.cursor === undefined ? {} : { cursor: scan.cursor }),
    });
    scan.scanned += page.scanned;
    scan.add(page.entries);
    scan.cursor = page.nextCursor ?? undefined;
    if (scan.scanned >= scan.limits.maxScanned && scan.cursor !== undefined) scan.truncated = true;
  } while (!scan.done);
}

function pathCompletion(
  word: string,
  start: number,
  end: number,
  context: CompletionContext,
  limits: CompletionLimits,
): CompletionResult {
  // The directory to list is the literal text before the last separator; the
  // rest is the prefix being matched. Neither is resolved beyond that, so a
  // half-typed name never becomes a lookup of something else.
  const separator = word.lastIndexOf("/");
  const typedDirectory = separator < 0 ? "" : word.slice(0, separator + 1);
  const prefix = separator < 0 ? word : word.slice(separator + 1);
  const scan = new PathCandidateScan(typedDirectory, prefix, limits);
  try {
    const listed = typedDirectory === "" ? context.cwd : normalizePath(typedDirectory, context.cwd);
    scanPathCandidates(listed, scan, context);
  } catch {
    // A half-typed path is the ordinary case here: it may not exist yet, or
    // may not even be a legal path. Neither is an error to report — there is
    // simply nothing to offer.
    return {
      start,
      end,
      candidates: [],
      commonPrefix: "",
      truncated: false,
      scanned: scan.scanned,
    };
  }
  return {
    start,
    end,
    candidates: scan.candidates,
    commonPrefix: scan.commonPrefix ?? "",
    truncated: scan.truncated || scan.candidates.length < scan.matched,
    scanned: scan.scanned,
  };
}

function complete(
  candidates: CompletionCandidate[],
  start: number,
  end: number,
  limits: CompletionLimits,
  scanned: number,
  truncated = false,
): CompletionResult {
  const capped = candidates.slice(0, limits.maxCandidates);
  return {
    start,
    end,
    candidates: capped,
    // Computed over everything found, not only what is returned, so a client
    // typing the prefix never has to undo it when the list was cut short.
    commonPrefix: longestCommonPrefix(candidates.map((candidate) => candidate.value)),
    truncated: truncated || capped.length < candidates.length,
    scanned,
  };
}
