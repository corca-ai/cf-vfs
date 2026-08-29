import { type BracketExpression, parseBracketExpression } from "./bracket.js";

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

export function globToRegExp(pattern: string): RegExp {
  const characters = [...pattern];
  let source = "^";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    switch (character) {
      case "\\":
        source += escapeRegex(characters[++index] ?? "\\");
        break;
      case "*":
        source += "[^/]*";
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
  return new RegExp(`${source}$`, "u");
}

export function matchesGlob(value: string, pattern?: string): boolean {
  return pattern === undefined || globToRegExp(pattern).test(value);
}
