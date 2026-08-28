import { VfsError } from "../core/errors.js";
import { compareUtf8, normalizePath } from "../core/path.js";
import { codePointLength } from "../core/unicode.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { expandBraces } from "./brace.js";
import { ShellNounsetError } from "./errors.js";
import type { LiteralWordPart, ParameterExpansion, ShellWord, WordPart } from "./parser.js";
import { matchesShellPattern, removeShellPattern, replaceShellPattern } from "./pattern.js";
import type { ShellBudget, ShellFileSystem, ShellSession } from "./types.js";

interface Field {
  value: string;
  pattern: string;
  characters: number;
}

interface ExpandedValues {
  values: string[];
  characters: number;
}

export interface ExpansionRuntime {
  commandSubstitute(
    script: import("./parser.js").ScriptNode,
    session: ShellSession,
  ): Promise<string>;
  lastSubstitutionStatus(): number | undefined;
}

/**
 * The `$-` option string.
 *
 * Only the options this profile spells as short flags appear, in a fixed order,
 * so the value is a declaration of what is on rather than an imitation of
 * Bash's flag set — Bash also reports `h`, `B`, `c`, and interactivity flags
 * that have no meaning here.
 */
function shellOptionFlags(session: ShellSession): string {
  return `${session.errexit === true ? "e" : ""}${session.nounset === true ? "u" : ""}`;
}

function variableState(name: string, session: ShellSession): { set: boolean; value: string } {
  if (name === "?") return { set: true, value: String(session.lastExitCode) };
  if (name === "-") return { set: true, value: shellOptionFlags(session) };
  if (name === "#") return { set: true, value: String(session.args.length) };
  if (name === "@") return { set: session.args.length > 0, value: session.args.join(" ") };
  if (name === "*") return { set: session.args.length > 0, value: session.args.join(" ") };
  if (name === "0") return { set: true, value: session.env.get("0") ?? "cf-vfs" };
  if (/^[1-9][0-9]*$/u.test(name)) {
    const value = session.args[Number(name) - 1];
    return value === undefined ? { set: false, value: "" } : { set: true, value };
  }
  const value = session.env.get(name);
  return value === undefined ? { set: false, value: "" } : { set: true, value };
}

export function isShellParameterSet(name: string, session: ShellSession): boolean {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#@*-])$/u.test(name)) {
    throw new VfsError("EINVAL", `${name}: invalid variable name`);
  }
  return variableState(name, session).set;
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
  return pathSegments.some(
    (segment, index) =>
      segment.startsWith(".") && !(patternSegments[index]?.startsWith(".") ?? false),
  );
}

function relativePath(from: string, to: string): string {
  const fromSegments = from.split("/").filter(Boolean);
  const toSegments = to.split("/").filter(Boolean);
  let common = 0;
  while (fromSegments[common] === toSegments[common] && common < fromSegments.length) common += 1;
  return (
    [
      ...Array.from({ length: fromSegments.length - common }, () => ".."),
      ...toSegments.slice(common),
    ].join("/") || "."
  );
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
  // The last separator before the first wildcard, measured in the escaped
  // pattern so the two stay in step when the prefix contains an escape. It has
  // to be a separator rather than wherever the literal prefix happens to end:
  // `/g/.*` has the literal prefix `/g/.`, which normalizes to a directory but
  // is not a component boundary, and splitting there would drop the dot.
  const rootEnd = Math.max(escapedPrefix.lastIndexOf("/"), 0);
  const writtenRoot = rootEnd === 0 ? "/" : unescapeGlob(absolutePattern.slice(0, rootEnd));
  // The rows are stored under canonical paths, so the pattern has to be asked
  // in canonical terms — otherwise a pattern under a link, or any pattern at
  // all from a working directory reached through one, matches nothing.
  const root = fileSystem.realpath(writtenRoot);
  const suffix = absolutePattern.slice(rootEnd);
  const canonicalPattern = root === "/" ? suffix || "/" : `${root}${suffix}`;
  // Results come back canonical and are reported the way they were asked for,
  // so a link stays visible in the expansion instead of being replaced by what
  // it points at.
  const written = (path: string): string => {
    if (root === writtenRoot) return path;
    const tail = root === "/" ? path : path.slice(root.length);
    return writtenRoot === "/" ? tail : `${writtenRoot}${tail}`;
  };
  const matches: string[] = [];
  let cursor: string | undefined;
  try {
    do {
      const remaining = budget.limits.maxGlobMatches - matches.length;
      const page = fileSystem.findPage({
        path: root,
        includeRoot: false,
        pathGlob: canonicalPattern,
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(1000, remaining + 1),
      });
      budget.step(page.scanned);
      for (const entry of page.entries) {
        if (!containsDotSegment(canonicalPattern, entry.path)) matches.push(written(entry.path));
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

function append(fields: Field[], value: string, activeGlob: boolean): void {
  const field = fields.at(-1);
  if (field === undefined) return;
  field.value += value;
  field.pattern += activeGlob ? value : escapeGlob(value);
  field.characters += codePointLength(value);
}

function alternatives(fields: Field[], expanded: ExpandedValues, activeGlob: boolean): void {
  const { values } = expanded;
  if (values.length === 0) return;
  append(fields, values[0] ?? "", activeGlob);
  for (const value of values.slice(1)) {
    fields.push({
      value,
      pattern: activeGlob ? value : escapeGlob(value),
      characters: codePointLength(value),
    });
  }
}

function splitValues(
  inputs: readonly string[],
  quoted: boolean,
  budget: ShellBudget,
  existingCharacters: number,
  existingFields: number,
): ExpandedValues {
  const values: string[] = [];
  let characters = 0;
  const add = (value: string): void => {
    const added = codePointLength(value);
    const nextCount = values.length + 1;
    budget.checkExpansionOutput(
      existingCharacters + characters + added,
      existingFields + Math.max(0, nextCount - 1),
    );
    values.push(value);
    characters += added;
  };
  for (const input of inputs) {
    budget.expansionWork(input.length);
    if (quoted) {
      add(input);
      continue;
    }
    for (const match of input.matchAll(/[^ \t\n]+/gu)) add(match[0]);
  }
  return { values, characters };
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
  let characters = 0;
  for (const part of parts) {
    const value = await partValue(part, session, fileSystem, budget, runtime);
    budget.expansionWork(value.length);
    characters += codePointLength(value);
    budget.checkExpansionOutput(characters, 0);
    output += value;
  }
  return assertNoNul(output);
}

async function patternParts(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  let pattern = "";
  let characters = 0;
  for (const part of word.parts) {
    const value = await partValue(part, session, fileSystem, budget, runtime);
    const fragment = part.quoted ? escapeGlob(value) : value;
    budget.expansionWork(fragment.length);
    characters += codePointLength(fragment);
    budget.checkExpansionOutput(characters, 0);
    pattern += fragment;
  }
  return assertNoNul(pattern);
}

function substringByCodePoint(
  value: string,
  offset: number,
  length: number | undefined,
  budget: ShellBudget,
): string {
  let start = offset;
  if (start < 0) {
    budget.expansionWork(value.length);
    start = Math.max(codePointLength(value) + start, 0);
  }
  budget.expansionWork(value.length);
  const end = length === undefined ? Number.POSITIVE_INFINITY : start + length;
  let codePoints = 0;
  let codeUnits = 0;
  let startCodeUnit = value.length;
  let endCodeUnit = value.length;
  for (const character of value) {
    if (codePoints === start) startCodeUnit = codeUnits;
    if (codePoints === end) {
      endCodeUnit = codeUnits;
      break;
    }
    codePoints += 1;
    codeUnits += character.length;
  }
  if (codePoints === start) startCodeUnit = codeUnits;
  if (codePoints === end) endCodeUnit = codeUnits;
  return value.slice(startCodeUnit, endCodeUnit);
}

function expansionInteger(value: string, label: string): number {
  const normalized = value.trim();
  if (!/^-?[0-9]+$/u.test(normalized)) {
    throw new VfsError("EINVAL", `${label} must expand to an integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new VfsError("EINVAL", `${label} must expand to a safe integer`);
  }
  return parsed;
}

async function parameterValue(
  expansion: ParameterExpansion,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const state = variableState(expansion.name, session);
  if (!("kind" in expansion)) {
    if (expansion.length) {
      if (expansion.name === "@" || expansion.name === "*") return String(session.args.length);
      if (!state.set && session.nounset) throw new ShellNounsetError(expansion.name);
      budget.expansionWork(state.value.length);
      return String(codePointLength(state.value));
    }
    const operator = expansion.operator;
    if (operator === undefined) {
      if (!state.set && session.nounset && expansion.name !== "@" && expansion.name !== "*") {
        throw new ShellNounsetError(expansion.name);
      }
      return state.value;
    }
    const checkNull = operator.startsWith(":");
    const absent = !state.set || (checkNull && state.value.length === 0);
    const operand = async (): Promise<string> =>
      expansion.word === undefined
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
    if (session.nounset) {
      throw new ShellNounsetError(
        expansion.name,
        message || `${expansion.name}: parameter is unset or empty`,
      );
    }
    throw new VfsError("EINVAL", message || `${expansion.name}: parameter is unset or empty`);
  }
  if (!state.set && session.nounset) throw new ShellNounsetError(expansion.name);
  if (expansion.kind === "indirect") {
    const target = state.value;
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#-])$/u.test(target)) {
      throw new VfsError("EINVAL", `${target}: invalid variable name for indirect expansion`);
    }
    const referenced = variableState(target, session);
    if (!referenced.set && session.nounset) throw new ShellNounsetError(target);
    return referenced.value;
  }
  if (expansion.kind === "remove") {
    const pattern = await patternParts(expansion.pattern, session, fileSystem, budget, runtime);
    return removeShellPattern(
      state.value,
      pattern,
      expansion.removalOperator.startsWith("#") ? "prefix" : "suffix",
      expansion.removalOperator.length === 2,
      budget,
    );
  }
  if (expansion.kind === "replace") {
    const pattern = await patternParts(expansion.pattern, session, fileSystem, budget, runtime);
    const replacement = await scalarParts(
      expansion.replacement.parts,
      session,
      fileSystem,
      budget,
      runtime,
    );
    return replaceShellPattern(state.value, pattern, replacement, expansion.all, budget);
  }
  if (expansion.kind === "substring") {
    const offset = expansionInteger(
      await scalarParts(expansion.offset.parts, session, fileSystem, budget, runtime),
      "substring offset",
    );
    const length =
      expansion.substringLength === undefined
        ? undefined
        : expansionInteger(
            await scalarParts(
              expansion.substringLength.parts,
              session,
              fileSystem,
              budget,
              runtime,
            ),
            "substring length",
          );
    if (length !== undefined && length < 0) {
      throw new VfsError("EINVAL", "substring length must not be negative");
    }
    return substringByCodePoint(state.value, offset, length, budget);
  }
  throw new VfsError("EINVAL", "unsupported parameter expansion");
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
    return String(evaluateArithmetic(part.expression, session.env, session.nounset === true));
  }
  return assertNoNul(await runtime.commandSubstitute(part.script, session));
}

async function partValues(
  part: WordPart,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
  existingCharacters: number,
  existingFields: number,
): Promise<ExpandedValues> {
  if (part.kind === "parameter" && part.expansion.name === "@" && !("kind" in part.expansion)) {
    const expansion = part.expansion;
    if (!expansion.length) {
      const operator = expansion.operator;
      const checkNull = operator?.startsWith(":") ?? false;
      const absent =
        session.args.length === 0 || (checkNull && session.args.join(" ").length === 0);
      const preservesArguments = operator === undefined || (!absent && !operator.endsWith("+"));
      if (preservesArguments) {
        return splitValues(session.args, part.quoted, budget, existingCharacters, existingFields);
      }
    }
  }
  const value = await partValue(part, session, fileSystem, budget, runtime);
  return splitValues([value], part.quoted, budget, existingCharacters, existingFields);
}

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * The `HOME` a tilde expands to, or `undefined` when none applies.
 *
 * An unset or empty `HOME` leaves the tilde literal, which is what Bash does
 * when it cannot resolve one.
 */
function tildeHome(session: ShellSession): string | undefined {
  const home = session.env.get("HOME");
  return home === undefined || home === "" ? undefined : home;
}

/**
 * Splits a tilde prefix off a literal segment.
 *
 * The declared profile is `~` and `~/path`. Every other form — `~user`, `~+`,
 * `~-`, `~N` — is not a prefix: there is no user database and no directory
 * stack, so a name after the tilde identifies nothing.
 */
function tildeSuffix(segment: string): string | undefined {
  if (!segment.startsWith("~")) return undefined;
  const rest = segment.slice(1);
  return rest === "" || rest.startsWith("/") ? rest : undefined;
}

/**
 * Emits the substituted home as a quoted part.
 *
 * Bash treats the result of tilde expansion as quoted: it is a value, not
 * syntax. Marking it quoted here makes the shared word machinery escape it for
 * pathname expansion and keep it out of field splitting, so a `HOME` holding
 * `*`, `?`, or `[` cannot turn `~/secret` into a wildcard that reaches paths
 * the caller never named.
 */
function tildeParts(template: LiteralWordPart, home: string, suffix: string): WordPart[] {
  const parts: WordPart[] = [{ ...template, value: home, quoted: true }];
  if (suffix !== "") parts.push({ ...template, value: suffix, quoted: false });
  return parts;
}

/**
 * Charges one substitution before it is materialized.
 *
 * An assignment can name many boundaries, and every one of them copies `HOME`.
 * Charging first keeps a bounded script from building an unbounded string, and
 * keeps the failure a budget diagnostic rather than a `RangeError` escaping the
 * runtime.
 */
function chargeTilde(home: string, budget: ShellBudget): void {
  budget.expansionWork(home.length);
  budget.checkExpansionOutput(codePointLength(home));
}

/**
 * Applies tilde expansion to the literal parts of a word.
 *
 * A word shaped like an assignment expands after `=` and after each unquoted
 * literal `:`, which is what makes `PATH=~/bin:~/tools` and
 * `PATH=$PATH:~/bin` work. The name before `=` must be an identifier, so
 * `--opt=~/y` and `9X=~/y` stay literal, exactly as in Bash. Otherwise only a
 * leading tilde counts, and its prefix must end inside the written literal: a
 * quoted part or an expansion continues it, and then `~"x"` and `~$X` are not
 * prefixes at all.
 */
function withTildePrefix(
  parts: readonly WordPart[],
  session: ShellSession,
  budget: ShellBudget,
): readonly WordPart[] {
  const first = parts[0];
  if (first?.kind !== "literal" || first.quoted) return parts;
  const home = tildeHome(session);
  if (home === undefined) return parts;
  const assignment = ASSIGNMENT_WORD.test(first.value);
  if (!assignment) {
    const suffix = tildeSuffix(first.value);
    // Without a `/` the prefix has to be the whole word: anything following it
    // continues the prefix rather than terminating it.
    if (suffix === undefined || (suffix === "" && parts.length > 1)) return parts;
    chargeTilde(home, budget);
    return [...tildeParts(first, home, suffix), ...parts.slice(1)];
  }

  const output: WordPart[] = [];
  let expandedAny = false;
  // `=` opens the first boundary; every unquoted literal `:` opens another. A
  // boundary closes at any expansion, because a `:` it produces is data.
  let atBoundary = false;
  let seenName = false;
  for (const [index, part] of parts.entries()) {
    if (part.kind !== "literal" || part.quoted) {
      output.push(part);
      atBoundary = false;
      continue;
    }
    let value = part.value;
    if (!seenName) {
      const separator = value.indexOf("=");
      output.push({ ...part, value: value.slice(0, separator + 1) });
      value = value.slice(separator + 1);
      seenName = true;
      atBoundary = true;
    }
    const segments = value.split(":");
    for (const [segmentIndex, segment] of segments.entries()) {
      if (segmentIndex > 0) {
        output.push({ ...part, value: ":" });
        atBoundary = true;
      }
      // A bare `~` is a prefix when a `:` or the end of the word terminates it.
      // Only a following part continues it, as in `PATH=~$SUFFIX`.
      const continues = segmentIndex === segments.length - 1 && index < parts.length - 1;
      const suffix = atBoundary ? tildeSuffix(segment) : undefined;
      if (suffix === undefined || (suffix === "" && continues)) {
        if (segment !== "") output.push({ ...part, value: segment });
      } else {
        chargeTilde(home, budget);
        output.push(...tildeParts(part, home, suffix));
        expandedAny = true;
      }
      atBoundary = false;
    }
  }
  return expandedAny ? output : parts;
}

/**
 * Expands one word into the fields it stands for.
 *
 * Brace expansion runs first and separately, exactly as it does in Bash: it
 * reads only the word, so its result is what the remaining steps expand, and
 * nothing a later step produces is scanned for braces again.
 */
export async function expandWord(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string[]> {
  const braced = expandBraces(word, budget);
  const single = braced.length === 1 ? braced[0] : undefined;
  if (single !== undefined) return expandOneWord(single, session, fileSystem, budget, runtime);
  const output: string[] = [];
  for (const candidate of braced) {
    output.push(...(await expandOneWord(candidate, session, fileSystem, budget, runtime)));
  }
  return output;
}

async function expandOneWord(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string[]> {
  const fields: Field[] = [{ value: "", pattern: "", characters: 0 }];
  let materializedCharacters = 0;
  let preservesEmptyField = false;
  let removedByExpansion = false;
  for (const part of withTildePrefix(word.parts, session, budget)) {
    if (part.kind === "literal") {
      const value = assertNoNul(part.value);
      preservesEmptyField ||= part.quoted;
      budget.expansionWork(value.length);
      const characters = codePointLength(value);
      budget.checkExpansionOutput(materializedCharacters + characters, fields.length);
      append(fields, value, !part.quoted);
      materializedCharacters += characters;
      continue;
    }
    const expanded = await partValues(
      part,
      session,
      fileSystem,
      budget,
      runtime,
      materializedCharacters,
      fields.length,
    );
    if (expanded.values.length === 0) removedByExpansion = true;
    else preservesEmptyField ||= part.quoted;
    alternatives(fields, expanded, !part.quoted);
    materializedCharacters += expanded.characters;
  }
  if (
    fields.length === 1 &&
    fields[0]?.value === "" &&
    removedByExpansion &&
    !preservesEmptyField
  ) {
    budget.expansionOutput(0, 0);
    return [];
  }

  const output: string[] = [];
  let outputCharacters = 0;
  for (const field of fields) {
    if (firstGlobMeta(field.pattern) < 0) {
      budget.checkExpansionOutput(outputCharacters + field.characters, output.length + 1);
      output.push(field.value);
      outputCharacters += field.characters;
      continue;
    }
    const matches = await glob(field.value, field.pattern, session, fileSystem, budget);
    for (const value of matches.length === 0 ? [field.value] : matches) {
      budget.expansionWork(value.length);
      const characters = codePointLength(value);
      budget.checkExpansionOutput(outputCharacters + characters, output.length + 1);
      output.push(value);
      outputCharacters += characters;
    }
  }
  budget.expansionOutput(outputCharacters, output.length);
  return output;
}

export async function expandScalarWord(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const value = await scalarParts(
    withTildePrefix(word.parts, session, budget),
    session,
    fileSystem,
    budget,
    runtime,
  );
  budget.expansionOutput(codePointLength(value));
  return value;
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
  // An assignment expands a tilde after `=` and after each `:`, which is what
  // makes `PATH=~/bin:~/tools` work.
  // The whole word carries the assignment shape, so the shared rule applies to
  // every boundary it names, including one a later literal part opens.
  const parts = withTildePrefix([first, ...rest], session, budget);
  const expandedFirst = parts[0];
  if (expandedFirst?.kind !== "literal") {
    throw new VfsError("EIO", "assignment expansion lost its literal prefix");
  }
  const value = await scalarParts(
    [
      {
        ...expandedFirst,
        value: expandedFirst.value.slice(name.length + 1),
      },
      ...parts.slice(1),
    ],
    session,
    fileSystem,
    budget,
    runtime,
  );
  budget.expansionOutput(codePointLength(value));
  return value;
}

export async function expandWords(
  words: readonly ShellWord[],
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string[]> {
  const output: string[] = [];
  for (const word of words)
    output.push(...(await expandWord(word, session, fileSystem, budget, runtime)));
  return output;
}

export async function expandCasePattern(
  word: ShellWord,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const pattern = await patternParts(word, session, fileSystem, budget, runtime);
  budget.expansionOutput(codePointLength(pattern));
  return pattern;
}

export function matchesCasePattern(value: string, pattern: string, budget?: ShellBudget): boolean {
  return matchesShellPattern(value, pattern, budget);
}
