import { VfsError } from "../core/errors.js";
import { compareUtf8, dirname, normalizePath } from "../core/path.js";
import type { ShellWord, WordPart } from "./parser.js";
import type { ShellBudget, ShellFileSystem, ShellSession } from "./types.js";

const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*|[?#@]|[0-9]+)\}|([A-Za-z_][A-Za-z0-9_]*|[?#@0-9]))/gu;
const IFS = /[ \t\n]+/u;

interface Field {
  value: string;
  pattern: string;
}

function variable(name: string, session: ShellSession): string {
  if (name === "?") return String(session.lastExitCode);
  if (name === "#") return String(session.args.length);
  if (name === "@") return session.args.join(" ");
  if (name === "0") return session.env.get("0") ?? "cf-vfs";
  if (/^[1-9][0-9]*$/u.test(name)) return session.args[Number(name) - 1] ?? "";
  return session.env.get(name) ?? "";
}

function escapeGlob(value: string): string {
  return value.replace(/[\\*?[\]]/gu, (character) => `\\${character}`);
}

function unescapeGlob(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] !== undefined) index += 1;
    output += value[index] ?? "";
  }
  return output;
}

function firstGlobMeta(pattern: string): number {
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") escaped = true;
    else if (character === "*" || character === "?") return index;
    else if (character === "[") {
      let classEscaped = false;
      for (let close = index + 1; close < pattern.length; close += 1) {
        const candidate = pattern[close];
        if (classEscaped) {
          classEscaped = false;
          continue;
        }
        if (candidate === "\\") classEscaped = true;
        else if (candidate === "]") return index;
      }
    }
  }
  return -1;
}

function containsDotSegment(pattern: string, path: string): boolean {
  const patternSegments = pattern.split("/").map(unescapeGlob);
  const pathSegments = path.split("/");
  return pathSegments.some((segment, index) =>
    segment.startsWith(".") && !(patternSegments[index]?.startsWith(".") ?? false));
}

function relativePath(from: string, to: string): string {
  const fromSegments = from.split("/").filter(Boolean);
  const toSegments = to.split("/").filter(Boolean);
  let common = 0;
  while (fromSegments[common] === toSegments[common] && common < fromSegments.length) common += 1;
  return [
    ...Array.from({ length: fromSegments.length - common }, () => ".."),
    ...toSegments.slice(common),
  ].join("/") || ".";
}

async function glob(
  value: string,
  pattern: string,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
): Promise<string[]> {
  const absolutePattern = normalizePath(pattern, session.cwd);
  const firstMeta = firstGlobMeta(absolutePattern);
  const escapedPrefix = firstMeta < 0 ? absolutePattern : absolutePattern.slice(0, firstMeta);
  const prefix = unescapeGlob(escapedPrefix);
  const prefixPath = prefix.endsWith("/") && prefix !== "/" ? prefix.slice(0, -1) : prefix;
  let root = dirname(prefixPath);
  try {
    const prefixStat = await fileSystem.stat(prefix);
    if (prefixStat.kind === "directory") root = prefix;
  } catch {
    // The non-wildcard prefix may end in a partial filename.
  }
  const matches: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const remaining = budget.limits.maxGlobMatches - matches.length;
      const page = await fileSystem.findPage({
        path: root,
        includeRoot: false,
        pathGlob: absolutePattern,
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(1000, remaining + 1),
      });
      budget.step(page.scanned);
      for (const entry of page.entries) {
        if (!containsDotSegment(absolutePattern, entry.path)) matches.push(entry.path);
      }
      if (matches.length > budget.limits.maxGlobMatches) break;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  } catch (error) {
    if (error instanceof VfsError && error.code === "ENOENT") return [];
    throw error;
  }
  matches.sort(compareUtf8);
  budget.glob(matches.length);
  return matches.map((path) => {
    if (value.startsWith("/")) return path;
    const relativeMeta = firstGlobMeta(pattern);
    const directoryEnd = pattern.lastIndexOf("/", relativeMeta);
    if (directoryEnd < 0) return relativePath(session.cwd, path);
    const lexicalDirectory = unescapeGlob(pattern.slice(0, directoryEnd + 1));
    const base = normalizePath(lexicalDirectory, session.cwd);
    return `${lexicalDirectory}${relativePath(base, path)}`;
  });
}

function split(value: string): string[] {
  return value.split(IFS).filter((piece) => piece.length > 0);
}

function append(fields: Field[], value: string, activeGlob: boolean): void {
  const field = fields.at(-1);
  if (field === undefined) return;
  field.value += value;
  field.pattern += activeGlob ? value : escapeGlob(value);
}

function alternatives(fields: Field[], values: readonly string[], activeGlob: boolean): void {
  if (values.length === 0) return;
  append(fields, values[0] ?? "", activeGlob);
  for (const value of values.slice(1)) {
    fields.push({ value, pattern: activeGlob ? value : escapeGlob(value) });
  }
}

function partSegments(part: WordPart): Array<{ literal?: string; parameter?: string }> {
  if (part.kind === "literal") return [{ literal: part.value }];
  const output: Array<{ literal?: string; parameter?: string }> = [];
  let offset = 0;
  for (const match of part.value.matchAll(VARIABLE)) {
    const index = match.index;
    if (index > offset) output.push({ literal: part.value.slice(offset, index) });
    output.push({ parameter: match[1] ?? match[2] ?? "" });
    offset = index + match[0].length;
  }
  if (offset < part.value.length) output.push({ literal: part.value.slice(offset) });
  if (output.length === 0) output.push({ literal: part.value });
  return output;
}

export async function expandWord(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
): Promise<string[]> {
  if (
    word.parts.length === 1
    && word.parts[0]?.kind === "expand"
    && word.parts[0].value === "$@"
  ) {
    return word.parts[0].quoted ? [...session.args] : session.args.flatMap(split);
  }

  const fields: Field[] = [{ value: "", pattern: "" }];
  let quoted = false;
  let removedByExpansion = false;
  for (const part of word.parts) {
    quoted ||= part.quoted;
    for (const segment of partSegments(part)) {
      if (segment.literal !== undefined) {
        if (segment.literal.includes("\0")) {
          throw new VfsError("EINVAL", "shell expansion produced a NUL byte");
        }
        append(fields, segment.literal, !part.quoted);
        continue;
      }
      const name = segment.parameter ?? "";
      let values: string[];
      if (name === "@") {
        values = part.quoted ? [...session.args] : session.args.flatMap(split);
      } else {
        const value = variable(name, session);
        values = part.quoted ? [value] : split(value);
      }
      if (values.some((value) => value.includes("\0"))) {
        throw new VfsError("EINVAL", "shell expansion produced a NUL byte");
      }
      if (values.length === 0) removedByExpansion = true;
      alternatives(fields, values, !part.quoted);
    }
  }
  if (fields.length === 1 && fields[0]?.value === "" && removedByExpansion && !quoted) return [];

  const output: string[] = [];
  for (const field of fields) {
    if (firstGlobMeta(field.pattern) < 0) {
      output.push(field.value);
      continue;
    }
    const matches = await glob(field.value, field.pattern, session, fileSystem, budget);
    output.push(...(matches.length === 0 ? [field.value] : matches));
  }
  return output;
}

export function expandAssignmentValue(
  word: ShellWord,
  name: string,
  session: ShellSession,
): string {
  let output = "";
  for (const [index, part] of word.parts.entries()) {
    const value = index === 0 ? part.value.slice(name.length + 1) : part.value;
    const assignmentPart: WordPart = { ...part, value };
    for (const segment of partSegments(assignmentPart)) {
      output += segment.literal ?? variable(segment.parameter ?? "", session);
    }
  }
  if (output.includes("\0")) throw new VfsError("EINVAL", "shell expansion produced a NUL byte");
  return output;
}

export async function expandWords(
  words: readonly ShellWord[],
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
): Promise<string[]> {
  const output: string[] = [];
  for (const word of words) output.push(...await expandWord(word, session, fileSystem, budget));
  return output;
}
