import { VfsError } from "./errors.js";
import type { RegexEngine, TextSearchMatch } from "./types.js";

export function searchContent(
  path: string,
  text: string,
  pattern: string,
  fixed: boolean,
  ignoreCase: boolean,
  regexEngine: RegexEngine | undefined,
  maximumResults: number,
): TextSearchMatch[] {
  const matches: TextSearchMatch[] = [];
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const program = fixed ? undefined : regexEngine?.compile(pattern, ignoreCase);
  if (!fixed && !program) {
    throw new VfsError(
      "ENOSYS",
      "regex search requires an explicit RegexEngine; use fixed=true or configure one",
    );
  }

  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (matches.length >= maximumResults) break;
    const haystack = ignoreCase ? line.toLowerCase() : line;
    const column = fixed ? haystack.indexOf(needle) : program?.findLine(line) ?? -1;
    if (column >= 0) {
      matches.push({ path, line: index + 1, column: column + 1, text: line });
    }
  }
  return matches;
}

export function replaceContent(
  text: string,
  pattern: string,
  replacement: string,
  fixed: boolean,
  ignoreCase: boolean,
  global: boolean,
  regexEngine?: RegexEngine,
): { value: string; replacements: number } {
  if (!fixed) {
    if (!regexEngine) {
      throw new VfsError(
        "ENOSYS",
        "regex replacement requires an explicit RegexEngine; use fixed=true or configure one",
      );
    }
    return regexEngine.compile(pattern, ignoreCase).replace(text, replacement, global);
  }

  if (pattern.length === 0) throw new VfsError("EINVAL", "pattern cannot be empty");
  if (!ignoreCase) {
    const first = text.indexOf(pattern);
    if (first < 0) return { value: text, replacements: 0 };
    if (!global) {
      return {
        value: text.slice(0, first) + replacement + text.slice(first + pattern.length),
        replacements: 1,
      };
    }
    const parts = text.split(pattern);
    return { value: parts.join(replacement), replacements: parts.length - 1 };
  }

  const escaped = pattern.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  const flags = global ? "giu" : "iu";
  let replacements = 0;
  const value = text.replace(new RegExp(escaped, flags), () => {
    replacements += 1;
    return replacement;
  });
  return { value, replacements };
}
