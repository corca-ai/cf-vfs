import { VfsError } from "../core/errors.js";
import type { ShellBudget } from "./types.js";

type PatternToken =
  | { kind: "literal"; value: string }
  | { kind: "any" }
  | { kind: "star" }
  | { kind: "class"; negated: boolean; ranges: Array<readonly [number, number]> };

interface CompiledPattern {
  tokens: PatternToken[];
  hasStar: boolean;
  minimumCharacters: number;
}

type PatternBudget = Pick<ShellBudget, "expansionWork"> & {
  readonly limits?: Pick<ShellBudget["limits"], "maxExpansionChars">;
};

const unboundedBudget: PatternBudget = { expansionWork() {} };

function codePoint(value: string): number {
  return value.codePointAt(0) ?? 0;
}

function codePointLength(value: string): number {
  let characters = 0;
  for (const _character of value) characters += 1;
  return characters;
}

function boundedCharacters(value: string, budget: PatternBudget): string[] {
  budget.expansionWork(value.length);
  const characters = codePointLength(value);
  if (characters > (budget.limits?.maxExpansionChars ?? Number.POSITIVE_INFINITY)) {
    throw new VfsError("E2BIG", "shell expansion character limit exceeded");
  }
  return [...value];
}

function classToken(body: readonly string[]): PatternToken | undefined {
  let index = 0;
  const negated = body[0] === "!";
  if (negated) index += 1;
  if (index >= body.length) return undefined;
  const values: string[] = [];
  while (index < body.length) {
    const value = body[index++] ?? "";
    if (value === "\\" && index < body.length) values.push(body[index++] ?? "");
    else values.push(value);
  }
  const ranges: Array<readonly [number, number]> = [];
  for (let offset = 0; offset < values.length; offset += 1) {
    const start = values[offset] ?? "";
    if (values[offset + 1] === "-" && values[offset + 2] !== undefined) {
      const end = values[offset + 2] ?? "";
      const left = codePoint(start);
      const right = codePoint(end);
      ranges.push(left <= right ? [left, right] : [right, left]);
      offset += 2;
    } else ranges.push([codePoint(start), codePoint(start)]);
  }
  return { kind: "class", negated, ranges };
}

function compilePattern(pattern: string, budget: PatternBudget): CompiledPattern {
  const characters = [...pattern];
  budget.expansionWork(characters.length);
  const tokens: PatternToken[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "\\" && characters[index + 1] !== undefined) {
      tokens.push({ kind: "literal", value: characters[++index] ?? "" });
      continue;
    }
    if (character === "*") {
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
      continue;
    }
    if (character === "?") {
      tokens.push({ kind: "any" });
      continue;
    }
    if (character === "[") {
      let close = index + 1;
      let escaped = false;
      for (; close < characters.length; close += 1) {
        const candidate = characters[close] ?? "";
        if (escaped) escaped = false;
        else if (candidate === "\\") escaped = true;
        else if (candidate === "]") break;
      }
      if (close < characters.length) {
        const token = classToken(characters.slice(index + 1, close));
        if (token !== undefined) {
          tokens.push(token);
          index = close;
          continue;
        }
      }
    }
    tokens.push({ kind: "literal", value: character });
  }
  return {
    tokens,
    hasStar: tokens.some((token) => token.kind === "star"),
    minimumCharacters: tokens.filter((token) => token.kind !== "star").length,
  };
}

function tokenMatches(
  token: Exclude<PatternToken, { kind: "star" }>,
  value: string,
  budget: PatternBudget,
): boolean {
  if (token.kind === "literal") return token.value === value;
  if (token.kind === "any") return true;
  const point = codePoint(value);
  let included = false;
  for (const [start, end] of token.ranges) {
    budget.expansionWork();
    if (point >= start && point <= end) {
      included = true;
      break;
    }
  }
  return token.negated ? !included : included;
}

function matchesWithoutStar(
  characters: readonly string[],
  start: number,
  pattern: CompiledPattern,
  budget: PatternBudget,
): boolean {
  budget.expansionWork(pattern.tokens.length);
  for (const [offset, token] of pattern.tokens.entries()) {
    if (token.kind === "star"
      || !tokenMatches(token, characters[start + offset] ?? "", budget)) return false;
  }
  return true;
}

function matchingEnd(
  characters: readonly string[],
  start: number,
  pattern: CompiledPattern,
  budget: PatternBudget,
  selection: "exact" | "shortest" | "longest" | "longest-nonempty",
): number | undefined {
  const remaining = characters.length - start;
  if (!pattern.hasStar) {
    const end = start + pattern.minimumCharacters;
    if (end > characters.length || !matchesWithoutStar(characters, start, pattern, budget)) {
      return undefined;
    }
    if (selection === "exact" && end !== characters.length) return undefined;
    return selection === "longest-nonempty" && end === start ? undefined : end;
  }
  budget.expansionWork(remaining + 1);
  let previous = new Uint8Array(remaining + 1);
  previous[0] = 1;
  for (const token of pattern.tokens) {
    budget.expansionWork(remaining + 1);
    const current = new Uint8Array(remaining + 1);
    if (token.kind === "star") {
      current[0] = previous[0] ?? 0;
      for (let offset = 1; offset <= remaining; offset += 1) {
        current[offset] = (previous[offset] ?? 0) || (current[offset - 1] ?? 0) ? 1 : 0;
      }
    } else {
      for (let offset = 1; offset <= remaining; offset += 1) {
        if ((previous[offset - 1] ?? 0) !== 0
          && tokenMatches(token, characters[start + offset - 1] ?? "", budget)) {
          current[offset] = 1;
        }
      }
    }
    previous = current;
  }
  if (selection === "exact") {
    return (previous[remaining] ?? 0) === 0 ? undefined : characters.length;
  }
  const minimum = selection === "longest-nonempty" ? 1 : 0;
  if (selection === "shortest") {
    for (let offset = minimum; offset <= remaining; offset += 1) {
      if ((previous[offset] ?? 0) !== 0) return start + offset;
    }
    return undefined;
  }
  for (let offset = remaining; offset >= minimum; offset -= 1) {
    if ((previous[offset] ?? 0) !== 0) return start + offset;
  }
  return undefined;
}

export function matchesShellPattern(
  value: string,
  pattern: string,
  budget: PatternBudget = unboundedBudget,
): boolean {
  const characters = boundedCharacters(value, budget);
  const compiled = compilePattern(pattern, budget);
  return matchingEnd(characters, 0, compiled, budget, "exact") !== undefined;
}

export function removeShellPattern(
  value: string,
  pattern: string,
  side: "prefix" | "suffix",
  longest: boolean,
  budget: PatternBudget,
): string {
  const characters = boundedCharacters(value, budget);
  const compiled = compilePattern(pattern, budget);
  const input = side === "prefix" ? characters : characters.reverse();
  const effective = side === "prefix"
    ? compiled
    : { ...compiled, tokens: [...compiled.tokens].reverse() };
  const length = matchingEnd(input, 0, effective, budget, longest ? "longest" : "shortest");
  if (side === "suffix") characters.reverse();
  if (length === undefined) return value;
  return side === "prefix"
    ? characters.slice(length).join("")
    : characters.slice(0, characters.length - length).join("");
}

function findReplacementMatch(
  characters: readonly string[],
  pattern: CompiledPattern,
  startAt: number,
  budget: PatternBudget,
): { start: number; end: number } | undefined {
  if (pattern.tokens.length === 0) return undefined;
  for (let start = startAt; start < characters.length; start += 1) {
    if (!pattern.hasStar) {
      const end = start + pattern.minimumCharacters;
      if (end <= characters.length && matchesWithoutStar(characters, start, pattern, budget)) {
        return { start, end };
      }
      continue;
    }
    const end = matchingEnd(characters, start, pattern, budget, "longest-nonempty");
    if (end !== undefined) return { start, end };
  }
  return undefined;
}

export function replaceShellPattern(
  value: string,
  pattern: string,
  replacement: string,
  all: boolean,
  budget: PatternBudget,
): string {
  const characters = boundedCharacters(value, budget);
  const compiled = compilePattern(pattern, budget);
  const replacementCharacters = codePointLength(replacement);
  let cursor = 0;
  let outputCharacters = 0;
  let output = "";
  while (cursor < characters.length) {
    const match = findReplacementMatch(characters, compiled, cursor, budget);
    if (match === undefined) break;
    outputCharacters += match.start - cursor + replacementCharacters;
    if (outputCharacters > (budget.limits?.maxExpansionChars ?? Number.POSITIVE_INFINITY)) {
      throw new VfsError("E2BIG", "shell expansion character limit exceeded");
    }
    output += characters.slice(cursor, match.start).join("");
    output += replacement;
    cursor = match.end;
    if (!all) break;
  }
  outputCharacters += characters.length - cursor;
  if (outputCharacters > (budget.limits?.maxExpansionChars ?? Number.POSITIVE_INFINITY)) {
    throw new VfsError("E2BIG", "shell expansion character limit exceeded");
  }
  return `${output}${characters.slice(cursor).join("")}`;
}
