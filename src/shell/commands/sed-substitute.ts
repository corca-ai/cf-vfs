import type { PosixMatch } from "../../core/posix-regex.js";
import type { ShellBudget } from "../types.js";
import type { SedSubstitute as Substitute } from "./sed-parser.js";
import { SedText } from "./sed-text.js";

/**
 * Applies the replacement literally.
 *
 * `&` is the whole match and `\1`…`\9` are capture groups, as in sed. Every
 * other character is written as-is, and JavaScript's `$` substitution syntax is
 * escaped away so replacement text taken from data can never splice another
 * part of the record into the output.
 */
function expandReplacement(replacement: string, match: PosixMatch, budget: ShellBudget): string {
  const output = new SedText(budget);
  if (!/[&\\]/u.test(replacement)) {
    output.append(replacement);
    return output.result();
  }
  for (let index = 0; index < replacement.length; index += 1) {
    const character = replacement[index] ?? "";
    if (character === "&") {
      output.append(match.groups[0] ?? "");
      continue;
    }
    if (character === "\\") {
      index += 1;
      const escaped = replacement[index];
      if (escaped === undefined) break;
      output.append(expandReplacementEscape(escaped, match));
      continue;
    }
    output.append(character);
  }
  return output.result();
}

function expandReplacementEscape(escaped: string, match: PosixMatch): string {
  if (/[1-9]/u.test(escaped)) return match.groups[Number(escaped)] ?? "";
  if (escaped === "n") return "\n";
  if (escaped === "t") return "\t";
  return escaped;
}

export function substitute(
  command: Substitute,
  record: string,
  budget: ShellBudget,
): { value: string; changed: boolean } {
  if (!command.global && command.occurrence === 0) {
    return substituteOnce(command, record, budget);
  }
  return substituteSelectedMatches(command, record, budget);
}

function substituteOnce(
  command: Substitute,
  record: string,
  budget: ShellBudget,
): { value: string; changed: boolean } {
  const match = command.pattern.exec(record);
  if (match === undefined) return { value: record, changed: false };
  const output = new SedText(budget);
  output.append(record.slice(0, match.index));
  output.append(expandReplacement(command.replacement, match, budget));
  output.append(record.slice(match.end));
  return { value: output.result(), changed: true };
}

function substituteSelectedMatches(
  command: Substitute,
  record: string,
  budget: ShellBudget,
): { value: string; changed: boolean } {
  const output = new SedText(budget);
  let last = 0;
  let seen = 0;
  let changed = false;
  let previousEnd = -1;
  for (let from = 0; from <= record.length; ) {
    budget.step();
    const match = command.pattern.exec(record, from);
    if (match === undefined) break;
    // An empty match touching the end of the previous one is not a separate
    // occurrence: `s/a*/-/g` on `baaac` gives `-b-c-`, not `-b--c-`.
    if (match.index === match.end && match.index === previousEnd) {
      from = match.end + 1;
      continue;
    }
    seen += 1;
    const replace = command.occurrence === 0 || seen >= command.occurrence;
    if (replace) {
      output.append(record.slice(last, match.index));
      output.append(expandReplacement(command.replacement, match, budget));
      last = match.end;
      changed = true;
      if (command.occurrence > 0 && !command.global) break;
    }
    previousEnd = match.end;
    // A zero-width match would otherwise never advance.
    from = match.end === match.index ? match.end + 1 : match.end;
  }
  output.append(record.slice(last));
  return { value: output.result(), changed };
}
