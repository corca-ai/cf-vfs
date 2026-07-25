import { VfsError } from "./errors.js";

/**
 * The two POSIX regular-expression dialects this project declares.
 *
 * `basic` is what `grep` and `sed` accept by default; `extended` is `grep -E`.
 * They differ only in which characters carry a special meaning bare and which
 * need a backslash.
 */
export type PosixRegexDialect = "basic" | "extended";

const JS_SPECIAL = /[\\^$.*+?()[\]{}|/]/u;
// `-` passes through: JavaScript and POSIX agree that it is a range
// operator between two characters and a literal at either end.
const JS_BRACKET_SPECIAL = /[\\\]^]/u;

function escapeLiteral(character: string): string {
  return JS_SPECIAL.test(character) ? `\\${character}` : character;
}

/**
 * Renders one literal, folding case for ASCII letters only.
 *
 * The runtime declares `LC_ALL=C`, so `-i` must mean the twenty-six ASCII
 * pairs and nothing else. JavaScript's `i` flag under `u` also folds the
 * Kelvin sign onto `k` and the long s onto `s`, which would silently make a
 * match locale-dependent in a runtime that promises it is not.
 */
function literalSource(character: string, ignoreCase: boolean): string {
  if (!ignoreCase || !/[A-Za-z]/u.test(character)) return escapeLiteral(character);
  return `[${character.toLowerCase()}${character.toUpperCase()}]`;
}

/** Adds the opposite-case counterpart of every ASCII letter range. */
function foldBracketBody(body: string): string {
  let folded = body;
  for (const [range, counterpart] of [
    ["a-z", "A-Z"],
    ["A-Z", "a-z"],
  ] as const) {
    if (body.includes(range) && !body.includes(counterpart)) folded += counterpart;
  }
  return folded.replace(
    /([a-z])-([a-z])/gu,
    (match, low: string, high: string) => `${match}${low.toUpperCase()}-${high.toUpperCase()}`,
  );
}

function unsupported(command: string, detail: string): never {
  throw new VfsError("EINVAL", `${command}: ${detail}`);
}

/**
 * POSIX character classes, in the fixed `LC_ALL=C` locale this runtime declares.
 *
 * Each expands to an explicit ASCII range set rather than a JavaScript class,
 * so `[[:alpha:]]` cannot quietly become Unicode-aware and disagree with the
 * pinned oracle.
 */
const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "0-9A-Za-z",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\n\\v\\f\\r",
  blank: " \\t",
  punct: "!-/:-@\\[-`{-~",
  print: " -~",
  graph: "!-~",
  cntrl: "\\x00-\\x1f\\x7f",
  xdigit: "0-9A-Fa-f",
};

/**
 * Reads a bracket expression, including POSIX classes.
 *
 * The glob parser cannot be reused: it has no `[:class:]` concept, and giving
 * it one would change pathname matching. This one understands only what a
 * regular expression needs.
 */
function readBracket(
  characters: readonly string[],
  open: number,
  command: string,
  ignoreCase = false,
): { source: string; close: number } {
  let index = open + 1;
  let negated = false;
  if (characters[index] === "^") {
    negated = true;
    index += 1;
  }
  let body = "";
  // A `]` first is a literal `]`, as POSIX has it.
  if (characters[index] === "]") {
    body += "\\]";
    index += 1;
  }
  for (; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "]") {
      if (body === "") unsupported(command, "empty bracket expression");
      const folded = ignoreCase ? foldBracketBody(body) : body;
      return { source: `[${negated ? "^" : ""}${folded}]`, close: index };
    }
    if (character === "[" && characters[index + 1] === ":") {
      const close = characters.indexOf(":", index + 2);
      if (close < 0 || characters[close + 1] !== "]") unsupported(command, "unmatched [:");
      const name = characters.slice(index + 2, close).join("");
      const ranges = Object.hasOwn(POSIX_CLASSES, name) ? POSIX_CLASSES[name] : undefined;
      if (ranges === undefined) unsupported(command, `unsupported character class [:${name}:]`);
      body += ranges;
      index = close + 1;
      continue;
    }
    if (character === "\\") {
      // POSIX gives a backslash no meaning inside a bracket expression.
      body += "\\\\";
      continue;
    }
    body += JS_BRACKET_SPECIAL.test(character) ? `\\${character}` : character;
  }
  unsupported(command, "unmatched [");
}

/**
 * Translates a POSIX regular expression into a JavaScript one.
 *
 * The point is that no JavaScript syntax reaches the engine unexamined. Every
 * character is either translated into the construct POSIX gives it or escaped
 * into a literal, and anything outside the declared subset is refused with a
 * usage error rather than handed to a dialect the caller did not ask for. That
 * is what keeps `a+`, `\d`, `(?:…)`, and `\b` from meaning something here that
 * they do not mean in `grep`.
 *
 * The declared subset is: literals, `.`, `*`, bracket expressions including
 * negation, ranges, and POSIX classes, the anchors `^` and `$`, grouping,
 * alternation, the repetitions `+` and `?`, and intervals `{n}`, `{n,}`, and
 * `{n,m}`. In `basic` the last four need a backslash and bare `+?{}()|` are
 * literal; in `extended` it is the other way round. Back-references, the GNU
 * escape classes, and every JavaScript-only construct are refused.
 *
 * Anchors follow POSIX rather than JavaScript: `^` matches only at the start of
 * the record and `$` only at the end, so a `^` in the middle of a pattern is a
 * literal caret in `basic`, as GNU has it.
 */
export function translatePosixRegex(
  pattern: string,
  dialect: PosixRegexDialect,
  command: string,
  ignoreCase = false,
): string {
  const characters = [...pattern];
  const extended = dialect === "extended";
  let source = "";
  let groupDepth = 0;
  // Tracks whether a repetition operator has something to repeat.
  let repeatable = false;

  const interval = (index: number, close: number): { source: string; next: number } => {
    const body = characters.slice(index, close).join("");
    if (!/^[0-9]+(?:,[0-9]*)?$/u.test(body)) unsupported(command, `invalid interval {${body}}`);
    return { source: `{${body}}`, next: close };
  };

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    if (character === "\\") {
      const next = characters[index + 1];
      if (next === undefined) unsupported(command, "trailing backslash");
      index += 1;
      if (!extended && (next === "(" || next === ")")) {
        if (next === "(") {
          source += "(";
          groupDepth += 1;
          repeatable = false;
        } else {
          if (groupDepth === 0) unsupported(command, "unmatched \\)");
          source += ")";
          groupDepth -= 1;
          repeatable = true;
        }
        continue;
      }
      if (!extended && (next === "|" || next === "+" || next === "?")) {
        if (next === "|") {
          source += "|";
          repeatable = false;
        } else {
          if (!repeatable) unsupported(command, `nothing to repeat before \\${next}`);
          source += next;
          repeatable = false;
        }
        continue;
      }
      if (!extended && next === "{") {
        const close = characters.indexOf("\\", index + 1);
        if (close < 0 || characters[close + 1] !== "}") unsupported(command, "unmatched \\{");
        if (!repeatable) unsupported(command, "nothing to repeat before \\{");
        const translated = interval(index + 1, close);
        source += translated.source;
        repeatable = false;
        index = close + 1;
        continue;
      }
      // Everything else after a backslash is the literal character. POSIX says
      // an undefined escape is undefined, and refusing the ones JavaScript
      // would claim keeps `\d` and `\b` from silently meaning a class here.
      // Alphanumerics are where JavaScript keeps its classes, and `<`, `>`,
      // and `` ` `` are GNU word-boundary extensions. Refusing all of them
      // keeps the declared subset honest.
      if (/[A-Za-z0-9<>`']/u.test(next)) {
        unsupported(command, `unsupported escape \\${next}`);
      }
      source += literalSource(next, ignoreCase);
      repeatable = true;
      continue;
    }

    if (character === "[") {
      const bracket = readBracket(characters, index, command, ignoreCase);
      source += bracket.source;
      index = bracket.close;
      repeatable = true;
      continue;
    }

    if (character === ".") {
      // POSIX `.` matches any character; records never contain a newline here.
      source += "[\\s\\S]";
      repeatable = true;
      continue;
    }

    if (character === "*") {
      // A leading `*` is a literal asterisk in both dialects; a repetition
      // operator consumes what it repeats, so it cannot itself be repeated.
      source += repeatable ? "*" : "\\*";
      repeatable = !repeatable;
      continue;
    }

    if (character === "^") {
      // Anchored only at the start; elsewhere it is a literal in `basic`. An
      // anchor has nothing to repeat, so a `*` after one is a literal asterisk.
      const anchor: boolean = source === "" || (extended && !repeatable);
      source += anchor ? "^" : "\\^";
      repeatable = !anchor;
      continue;
    }

    if (character === "$") {
      const last = index === characters.length - 1;
      if (last || extended) source += "$";
      else source += "\\$";
      repeatable = false;
      continue;
    }

    if (extended && (character === "(" || character === ")")) {
      if (character === "(") {
        source += "(";
        groupDepth += 1;
        repeatable = false;
      } else {
        if (groupDepth === 0) unsupported(command, "unmatched )");
        source += ")";
        groupDepth -= 1;
        repeatable = true;
      }
      continue;
    }

    if (extended && (character === "|" || character === "+" || character === "?")) {
      if (character === "|") {
        source += "|";
        repeatable = false;
      } else {
        if (!repeatable) unsupported(command, `nothing to repeat before ${character}`);
        source += character;
        repeatable = false;
      }
      continue;
    }

    if (extended && character === "{") {
      const close = characters.indexOf("}", index + 1);
      if (close < 0) unsupported(command, "unmatched {");
      if (!repeatable) unsupported(command, "nothing to repeat before {");
      const translated = interval(index + 1, close);
      source += translated.source;
      repeatable = false;
      index = close;
      continue;
    }

    source += literalSource(character, ignoreCase);
    repeatable = true;
  }

  if (groupDepth !== 0) unsupported(command, "unmatched group");
  return source;
}

/**
 * Compiles a POSIX pattern, refusing anything outside the declared subset.
 *
 * `ignoreCase` uses the JavaScript flag rather than case-folding the record, so
 * a bracket range keeps its meaning.
 */
export function compilePosixRegex(
  pattern: string,
  dialect: PosixRegexDialect,
  command: string,
  options: { readonly ignoreCase?: boolean; readonly global?: boolean } = {},
): RegExp {
  // Case folding happens in the translation, not through the `i` flag: that
  // flag folds Unicode, and this runtime declares the C locale.
  const source = translatePosixRegex(pattern, dialect, command, options.ignoreCase === true);
  const flags = `u${options.global === true ? "g" : ""}`;
  try {
    return new RegExp(source, flags);
  } catch {
    unsupported(command, "invalid regular expression");
  }
}
