import { parseBracketExpression, type BracketExpression } from "./bracket.js";

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function bracketRegex(expression: BracketExpression): string {
  if (expression.ranges.length === 0) return expression.negated ? "[^/]" : "(?!)";
  const body = expression.ranges.map(([start, end]) => {
    const left = `\\u{${start.toString(16)}}`;
    const right = `\\u{${end.toString(16)}}`;
    return start === end ? left : `${left}-${right}`;
  }).join("");
  return `(?=[^/])[${expression.negated ? "^" : ""}${body}]`;
}

export function globToRegExp(pattern: string): RegExp {
  const characters = [...pattern];
  let source = "^";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "\\" && characters[index + 1] !== undefined) {
      source += escapeRegex(characters[++index] ?? "");
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const expression = parseBracketExpression(characters, index);
      if (expression === undefined) source += "\\[";
      else {
        source += bracketRegex(expression);
        index = expression.close;
      }
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`${source}$`, "u");
}

export function matchesGlob(value: string, pattern?: string): boolean {
  return pattern === undefined || globToRegExp(pattern).test(value);
}
