import { VfsError } from "../core/errors.js";
import { compareUtf8, dirname, normalizePath } from "../core/path.js";
import { evaluateArithmetic } from "./arithmetic.js";
import type { ParameterExpansion, ShellWord, WordPart } from "./parser.js";
import type { ShellBudget, ShellFileSystem, ShellSession } from "./types.js";

const IFS = /[ \t\n]+/u;

interface Field {
  value: string;
  pattern: string;
}

export interface ExpansionRuntime {
  commandSubstitute(script: import("./parser.js").ScriptNode, session: ShellSession): Promise<string>;
  lastSubstitutionStatus(): number | undefined;
}

function variableState(name: string, session: ShellSession): { set: boolean; value: string } {
  if (name === "?") return { set: true, value: String(session.lastExitCode) };
  if (name === "#") return { set: true, value: String(session.args.length) };
  if (name === "@") return { set: true, value: session.args.join(" ") };
  if (name === "0") return { set: true, value: session.env.get("0") ?? "cf-vfs" };
  if (/^[1-9][0-9]*$/u.test(name)) {
    const value = session.args[Number(name) - 1];
    return value === undefined ? { set: false, value: "" } : { set: true, value };
  }
  const value = session.env.get(name);
  return value === undefined ? { set: false, value: "" } : { set: true, value };
}

function assignParameter(name: string, value: string, session: ShellSession): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new VfsError("EINVAL", `cannot assign to special parameter ${name}`);
  }
  session.env.set(name, value);
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
    // A non-wildcard prefix may end in a partial filename.
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

function assertNoNul(value: string): string {
  if (value.includes("\0")) throw new VfsError("EINVAL", "shell expansion produced a NUL byte");
  return value;
}

async function scalarParts(
  parts: readonly WordPart[],
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  let output = "";
  for (const part of parts) output += await partValue(part, session, fileSystem, budget, runtime);
  return assertNoNul(output);
}

async function parameterValue(
  expansion: ParameterExpansion,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const state = variableState(expansion.name, session);
  if (expansion.length) return String([...state.value].length);
  const operator = expansion.operator;
  if (operator === undefined) return state.value;
  const checkNull = operator.startsWith(":");
  const absent = !state.set || (checkNull && state.value.length === 0);
  const operand = async (): Promise<string> => expansion.word === undefined
    ? ""
    : await scalarParts(expansion.word.parts, session, fileSystem, budget, runtime);
  if (operator.endsWith("-")) return absent ? await operand() : state.value;
  if (operator.endsWith("+")) return absent ? "" : await operand();
  if (operator.endsWith("=")) {
    if (!absent) return state.value;
    const value = await operand();
    assignParameter(expansion.name, value, session);
    return value;
  }
  if (!absent) return state.value;
  const message = await operand();
  throw new VfsError("EINVAL", message || `${expansion.name}: parameter is unset or empty`);
}

async function partValue(
  part: WordPart,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  if (part.kind === "literal") return assertNoNul(part.value);
  if (part.kind === "parameter") {
    return assertNoNul(await parameterValue(part.expansion, session, fileSystem, budget, runtime));
  }
  if (part.kind === "arithmetic") {
    return String(evaluateArithmetic(part.expression, session.env));
  }
  return assertNoNul(await runtime.commandSubstitute(part.script, session));
}

async function partValues(
  part: WordPart,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string[]> {
  if (part.kind === "parameter" && part.expansion.name === "@" && part.expansion.operator === undefined) {
    return part.quoted ? [...session.args] : session.args.flatMap(split);
  }
  const value = await partValue(part, session, fileSystem, budget, runtime);
  return part.quoted ? [value] : split(value);
}

export async function expandWord(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string[]> {
  const fields: Field[] = [{ value: "", pattern: "" }];
  let quoted = false;
  let removedByExpansion = false;
  for (const part of word.parts) {
    quoted ||= part.quoted;
    if (part.kind === "literal") {
      append(fields, assertNoNul(part.value), !part.quoted);
      continue;
    }
    const values = await partValues(part, session, fileSystem, budget, runtime);
    if (values.length === 0) removedByExpansion = true;
    alternatives(fields, values, !part.quoted);
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

export async function expandScalarWord(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  return await scalarParts(word.parts, session, fileSystem, budget, runtime);
}

export async function expandAssignmentValue(
  word: ShellWord,
  name: string,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const [first, ...rest] = word.parts;
  if (first?.kind !== "literal") throw new VfsError("EINVAL", "invalid assignment word");
  const parts: WordPart[] = [
    { ...first, value: first.value.slice(name.length + 1) },
    ...rest,
  ];
  return await scalarParts(parts, session, fileSystem, budget, runtime);
}

export async function expandWords(
  words: readonly ShellWord[],
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string[]> {
  const output: string[] = [];
  for (const word of words) output.push(...await expandWord(word, session, fileSystem, budget, runtime));
  return output;
}

export async function expandCasePattern(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  let pattern = "";
  for (const part of word.parts) {
    const value = await partValue(part, session, fileSystem, budget, runtime);
    pattern += part.quoted ? escapeGlob(value) : value;
  }
  return pattern;
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

export function matchesCasePattern(value: string, pattern: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "\\" && pattern[index + 1] !== undefined) {
      source += escapeRegex(pattern[++index] ?? "");
    } else if (character === "*") source += "[\\s\\S]*";
    else if (character === "?") source += "[\\s\\S]";
    else if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close < 0) source += "\\[";
      else {
        let body = pattern.slice(index + 1, close);
        const negated = body.startsWith("!");
        if (negated) body = body.slice(1);
        const escaped = [...body].map((item, bodyIndex) =>
          item === "\\" || item === "]" || (item === "^" && bodyIndex === 0) ? `\\${item}` : item).join("");
        source += `[${negated ? "^" : ""}${escaped}]`;
        index = close;
      }
    } else source += escapeRegex(character);
  }
  return new RegExp(`${source}$`, "u").test(value);
}
