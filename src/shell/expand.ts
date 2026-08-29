import { VfsError } from "../core/errors.js";
import { codePointLength } from "../core/unicode.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { expandBraces } from "./brace.js";
import { ShellNounsetError } from "./errors.js";
import { escapeGlob, expandGlob, hasGlob } from "./expand-glob.js";
import {
  assignParameter,
  expansionInteger,
  indirectParameterValue,
  missingParameter,
  substringByCodePoint,
  variableState,
} from "./expand-parameter.js";
import { withTildePrefix } from "./expand-tilde.js";
import type { BasicParameterExpansion, ParameterExpansion, ShellWord, WordPart } from "./parser.js";
import { matchesShellPattern, removeShellPattern, replaceShellPattern } from "./pattern.js";
import type { ShellBudget, ShellFileSystem, ShellSession } from "./types.js";

export { isShellParameterSet } from "./expand-parameter.js";

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

async function parameterOperand(
  expansion: BasicParameterExpansion,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  return expansion.word === undefined
    ? ""
    : await scalarParts(expansion.word.parts, session, fileSystem, budget, runtime);
}

function parameterLengthValue(
  expansion: BasicParameterExpansion,
  session: ShellSession,
  budget: ShellBudget,
): string {
  if (expansion.name === "@" || expansion.name === "*") return String(session.args.length);
  const state = variableState(expansion.name, session);
  if (!state.set && session.nounset) throw new ShellNounsetError(expansion.name);
  budget.expansionWork(state.value.length);
  return String(codePointLength(state.value));
}

async function operatedParameterValue(
  expansion: BasicParameterExpansion & {
    readonly operator: NonNullable<BasicParameterExpansion["operator"]>;
  },
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const state = variableState(expansion.name, session);
  const absent = !state.set || (expansion.operator.startsWith(":") && state.value.length === 0);
  if (expansion.operator.endsWith("-")) {
    return absent
      ? await parameterOperand(expansion, session, fileSystem, budget, runtime)
      : state.value;
  }
  if (expansion.operator.endsWith("+")) {
    return absent ? "" : await parameterOperand(expansion, session, fileSystem, budget, runtime);
  }
  if (expansion.operator.endsWith("=")) {
    if (!absent) return state.value;
    const value = await parameterOperand(expansion, session, fileSystem, budget, runtime);
    assignParameter(expansion.name, value, session);
    return value;
  }
  if (!absent) return state.value;
  return missingParameter(
    expansion.name,
    session,
    await parameterOperand(expansion, session, fileSystem, budget, runtime),
  );
}

async function basicParameterValue(
  expansion: BasicParameterExpansion,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  if (expansion.length) return parameterLengthValue(expansion, session, budget);
  const state = variableState(expansion.name, session);
  const operator = expansion.operator;
  if (operator === undefined) {
    if (!state.set && session.nounset && expansion.name !== "@" && expansion.name !== "*") {
      throw new ShellNounsetError(expansion.name);
    }
    return state.value;
  }
  return await operatedParameterValue(
    { ...expansion, operator },
    session,
    fileSystem,
    budget,
    runtime,
  );
}

async function substringParameterValue(
  expansion: Extract<ParameterExpansion, { kind: "substring" }>,
  value: string,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  const offset = expansionInteger(
    await scalarParts(expansion.offset.parts, session, fileSystem, budget, runtime),
    "substring offset",
  );
  const length =
    expansion.substringLength === undefined
      ? undefined
      : expansionInteger(
          await scalarParts(expansion.substringLength.parts, session, fileSystem, budget, runtime),
          "substring length",
        );
  if (length !== undefined && length < 0) {
    throw new VfsError("EINVAL", "substring length must not be negative");
  }
  return substringByCodePoint(value, offset, length, budget);
}

async function parameterValue(
  expansion: ParameterExpansion,
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
  runtime: ExpansionRuntime,
): Promise<string> {
  if (!("kind" in expansion)) {
    return await basicParameterValue(expansion, session, fileSystem, budget, runtime);
  }
  const state = variableState(expansion.name, session);
  if (!state.set && session.nounset) throw new ShellNounsetError(expansion.name);
  if (expansion.kind === "indirect") return indirectParameterValue(session, state.value);
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
  if (expansion.kind === "substring")
    return await substringParameterValue(
      expansion,
      state.value,
      session,
      fileSystem,
      budget,
      runtime,
    );
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

async function expandFieldGlobs(
  fields: readonly Field[],
  session: ShellSession,
  fileSystem: ShellFileSystem,
  budget: ShellBudget,
): Promise<string[]> {
  const output: string[] = [];
  let outputCharacters = 0;
  for (const field of fields) {
    if (!hasGlob(field.pattern)) {
      budget.checkExpansionOutput(outputCharacters + field.characters, output.length + 1);
      output.push(field.value);
      outputCharacters += field.characters;
      continue;
    }
    const matches = await expandGlob(field.value, field.pattern, session, fileSystem, budget);
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

  return await expandFieldGlobs(fields, session, fileSystem, budget);
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
