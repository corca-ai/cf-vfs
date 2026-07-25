import type { ShellWord, WordPart } from "./parser.js";
import type { ShellBudget } from "./types.js";

/**
 * Brace expansion, the first step of expansion and the only one that reads
 * nothing but the word itself.
 *
 * It runs before parameter expansion and never re-runs on the result, so
 * `v={a,b}; echo $v` prints the braces rather than expanding them. Working on
 * parsed parts rather than raw text is what buys that for free: a parameter,
 * command, or arithmetic part is opaque here and can only be carried into each
 * alternative, never inspected for brace syntax.
 *
 * Quoted text is opaque for the same reason, which covers both `"{a,b}"` and
 * `\{a,b\}` — the lexer marks an escaped character quoted, so neither reaches
 * the scanner below as brace syntax.
 */

/**
 * One unquoted literal code point, or anything else.
 *
 * Only a `char` can spell `{`, `}`, `,`, or `.`, so the scanner never has to
 * ask what a part means.
 */
type Atom =
  | { readonly kind: "char"; readonly value: string }
  | { readonly kind: "opaque"; readonly part: WordPart };

interface BraceGroup {
  /** Each alternative, already stripped of its braces and separators. */
  readonly alternatives: readonly (readonly Atom[])[];
  /** Index of the closing brace. */
  readonly end: number;
}

/** `{1..9}`, `{-2..2}`, `{01..3}`, `{1..9..2}`. */
const INTEGER_RANGE = /^(-?[0-9]+)\.\.(-?[0-9]+)(?:\.\.(-?[0-9]+))?$/u;
/** `{a..z}`, `{a..z..2}`. Endpoints are single code points, not letters only. */
const CHARACTER_RANGE = /^(.)\.\.(.)(?:\.\.(-?[0-9]+))?$/su;
/** Bash pads when either endpoint is written with a leading zero. */
const ZERO_PADDED = /^-?0[0-9]/u;

function flatten(word: ShellWord): Atom[] {
  const atoms: Atom[] = [];
  for (const part of word.parts) {
    if (part.kind !== "literal" || part.quoted) {
      atoms.push({ kind: "opaque", part });
      continue;
    }
    for (const value of part.value) atoms.push({ kind: "char", value });
  }
  return atoms;
}

function rebuild(atoms: readonly Atom[], word: ShellWord): ShellWord {
  const parts: WordPart[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal === "") return;
    parts.push({ kind: "literal", value: literal, quoted: false });
    literal = "";
  };
  for (const atom of atoms) {
    if (atom.kind === "char") {
      literal += atom.value;
      continue;
    }
    flush();
    parts.push(atom.part);
  }
  flush();
  const rebuilt: ShellWord = { parts, sourceOffset: word.sourceOffset };
  return word.assignmentName === undefined
    ? rebuilt
    : { ...rebuilt, assignmentName: word.assignmentName };
}

/**
 * How many values a range holds, charged before any are built.
 *
 * `{1..2000000000}` must cost a rejection rather than two billion iterations,
 * so the count is arithmetic and the budget sees it whole.
 */
function chargeRange(start: number, end: number, stride: number, budget: ShellBudget): number {
  const count = Math.floor(Math.abs(end - start) / stride) + 1;
  budget.expansionWork(count);
  return count;
}

function characterRange(
  startText: string,
  endText: string,
  step: number,
  budget: ShellBudget,
): Atom[][] | undefined {
  const start = startText.codePointAt(0);
  const end = endText.codePointAt(0);
  if (start === undefined || end === undefined) return undefined;
  const stride = step === 0 ? 1 : Math.abs(step);
  const direction = start <= end ? 1 : -1;
  const count = chargeRange(start, end, stride, budget);
  const values: Atom[][] = [];
  for (let index = 0; index < count; index += 1) {
    const code = start + direction * stride * index;
    values.push([{ kind: "char", value: String.fromCodePoint(code) }]);
  }
  return values;
}

function integerRange(
  startText: string,
  endText: string,
  step: number,
  budget: ShellBudget,
): Atom[][] | undefined {
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  // Bash pads to the wider of the two spellings, so `{1..03}` and `{01..3}`
  // both count 01 02 03.
  const width =
    ZERO_PADDED.test(startText) || ZERO_PADDED.test(endText)
      ? Math.max(startText.length, endText.length)
      : 0;
  const stride = step === 0 ? 1 : Math.abs(step);
  const direction = start <= end ? 1 : -1;
  const count = chargeRange(start, end, stride, budget);
  const values: Atom[][] = [];
  for (let index = 0; index < count; index += 1) {
    const value = start + direction * stride * index;
    const digits = Math.abs(value).toString();
    const sign = value < 0 ? "-" : "";
    const padded =
      width === 0 ? `${sign}${digits}` : `${sign}${digits.padStart(width - sign.length, "0")}`;
    values.push([...padded].map((character) => ({ kind: "char", value: character }) as const));
  }
  return values;
}

/** Parses a range body, which — unlike a list — must be entirely literal. */
function rangeAlternatives(content: readonly Atom[], budget: ShellBudget): Atom[][] | undefined {
  if (content.some((atom) => atom.kind !== "char")) return undefined;
  const text = content.map((atom) => (atom.kind === "char" ? atom.value : "")).join("");
  const integers = INTEGER_RANGE.exec(text);
  if (integers?.[1] !== undefined && integers[2] !== undefined) {
    return integerRange(integers[1], integers[2], Number(integers[3] ?? "1"), budget);
  }
  const characters = CHARACTER_RANGE.exec(text);
  if (characters?.[1] !== undefined && characters[2] !== undefined) {
    return characterRange(characters[1], characters[2], Number(characters[3] ?? "1"), budget);
  }
  return undefined;
}

/**
 * Reads the group opening at `start`, or `undefined` when those braces are not
 * one.
 *
 * `{a}` and `{}` have no separator and no range, so they stay literal; that is
 * also why `{a{b,c}}` prints `{ab} {ac}` — the outer braces hold no top-level
 * comma, and the scanner moves on to the inner ones.
 */
function readGroup(
  atoms: readonly Atom[],
  start: number,
  budget: ShellBudget,
): BraceGroup | undefined {
  const separators: number[] = [];
  let depth = 0;
  let end = -1;
  for (let index = start; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (atom?.kind !== "char") continue;
    budget.expansionWork();
    if (atom.value === "{") depth += 1;
    else if (atom.value === ",") {
      if (depth === 1) separators.push(index);
    } else if (atom.value === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return undefined;
  const content = atoms.slice(start + 1, end);
  if (separators.length === 0) {
    const alternatives = rangeAlternatives(content, budget);
    return alternatives === undefined ? undefined : { alternatives, end };
  }
  const alternatives: Atom[][] = [];
  let from = start + 1;
  for (const separator of [...separators, end]) {
    alternatives.push(atoms.slice(from, separator));
    from = separator + 1;
  }
  return { alternatives, end };
}

function expandAtoms(atoms: readonly Atom[], budget: ShellBudget): Atom[][] {
  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (atom?.kind !== "char" || atom.value !== "{") continue;
    const group = readGroup(atoms, index, budget);
    if (group === undefined) continue;
    const output: Atom[][] = [];
    const prefix = atoms.slice(0, index);
    const suffix = atoms.slice(group.end + 1);
    for (const alternative of group.alternatives) {
      // Rescanning the whole word is what makes `{a,{b,c}}` and `{a,b}{1,2}`
      // fall out: each pass removes exactly one pair of braces, so this
      // terminates, and the budget bounds how wide it gets on the way.
      output.push(...expandAtoms([...prefix, ...alternative, ...suffix], budget));
    }
    return output;
  }
  return [[...atoms]];
}

/**
 * Expands `word` into the words it stands for, or into itself when it holds no
 * brace group.
 *
 * The caller charges nothing for a word without braces: the scan below stops at
 * the first pass over the parts, which is the common case.
 */
export function expandBraces(word: ShellWord, budget: ShellBudget): ShellWord[] {
  const atoms = flatten(word);
  if (!atoms.some((atom) => atom.kind === "char" && atom.value === "{")) return [word];
  // An alternative that contributes nothing to the word contributes no word:
  // `{a,}` is one field and `{,}` is none, while `f{,.bak}` still counts two
  // because the prefix survives into both.
  const expanded = expandAtoms(atoms, budget).filter((candidate) => candidate.length > 0);
  if (expanded.length > 1) budget.expansionWork(expanded.length);
  return expanded.map((candidate) => rebuild(candidate, word));
}
