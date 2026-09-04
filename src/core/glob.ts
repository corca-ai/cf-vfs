import { type BracketExpression, parseBracketExpression } from "./bracket.js";

import { VfsError } from "./errors.js";

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function bracketRegex(expression: BracketExpression): string {
  if (expression.ranges.length === 0) return expression.negated ? "[^/]" : "(?!)";
  const body = expression.ranges
    .map(([start, end]) => {
      const left = `\\u{${start.toString(16)}}`;
      const right = `\\u{${end.toString(16)}}`;
      return start === end ? left : `${left}-${right}`;
    })
    .join("");
  return `(?=[^/])[${expression.negated ? "^" : ""}${body}]`;
}

function globParts(pattern: string): string[] {
  if (pattern.length > 16_384) throw new VfsError("E2BIG", "glob pattern length limit exceeded");
  const characters = [...pattern];
  const parts: string[] = [];
  let source = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    switch (character) {
      case "\\":
        source += escapeRegex(characters[++index] ?? "\\");
        break;
      case "*":
        parts.push(source);
        source = "";
        break;
      case "?":
        source += "[^/]";
        break;
      case "[": {
        const expression = parseBracketExpression(characters, index);
        source += expression === undefined ? "\\[" : bracketRegex(expression);
        if (expression !== undefined) index = expression.close;
        break;
      }
      default:
        source += escapeRegex(character);
    }
  }
  parts.push(source);
  return parts.filter((part, index) => index === 0 || part !== "" || index === parts.length - 1);
}

export function globToRegExp(pattern: string): RegExp {
  const parts = globParts(pattern);
  let expression = `^${parts[0] ?? ""}`;
  // Lookahead commits the earliest fixed fragment after each non-final star.
  // Backtracking cannot multiply choices across successive wildcards.
  for (let index = 1; index < parts.length; index += 1) {
    const fixed = parts[index] ?? "";
    expression +=
      index === parts.length - 1
        ? `[^/]*${fixed}`
        : `(?=(?<g${index}>[^/]*?${fixed}))\\k<g${index}>`;
  }
  return new RegExp(`${expression}$`, "u");
}

export function matchesGlob(value: string, pattern?: string): boolean {
  return pattern === undefined || globToRegExp(pattern).test(value);
}
