function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

export function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === "\\" && pattern[index + 1] !== undefined) {
      source += escapeRegex(pattern[++index] ?? "");
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const close = pattern.indexOf("]", index + 1);
      if (close < 0) {
        source += "\\[";
        continue;
      }
      let body = pattern.slice(index + 1, close);
      let negated = false;
      if (body.startsWith("!")) {
        negated = true;
        body = body.slice(1);
      }
      if (body.length === 0) {
        source += "\\[\\]";
        index = close;
        continue;
      }
      const escaped = [...body].map((value, bodyIndex) => {
        if (value === "\\" || value === "]" || (value === "^" && bodyIndex === 0)) {
          return `\\${value}`;
        }
        return value;
      }).join("");
      source += `[${negated ? "^" : ""}${escaped}]`;
      index = close;
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`${source}$`, "u");
}

export function matchesGlob(value: string, pattern?: string): boolean {
  return pattern === undefined || globToRegExp(pattern).test(value);
}
