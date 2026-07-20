import { VfsError } from "../core/errors.js";

export const BASH_COMPATIBILITY_VERSION = 1 as const;

export type WordPartKind = "literal" | "expand";

export interface WordPart {
  kind: WordPartKind;
  value: string;
  quoted: boolean;
}

export interface ShellWord {
  parts: WordPart[];
  sourceOffset: number;
  assignmentName?: string;
}

export type RedirectionOperator = "<" | ">" | ">>" | "2>" | "2>>" | "2>&1";

export interface Redirection {
  operator: RedirectionOperator;
  target?: ShellWord;
}

export interface SimpleCommandNode {
  type: "command";
  words: ShellWord[];
  redirections: Redirection[];
  sourceOffset: number;
}

export interface PipelineNode {
  type: "pipeline";
  negated: boolean;
  commands: SimpleCommandNode[];
}

export interface AndOrNode {
  type: "and-or";
  first: PipelineNode;
  rest: Array<{ operator: "&&" | "||"; pipeline: PipelineNode }>;
}

export interface ScriptNode {
  type: "script";
  lists: AndOrNode[];
  nodeCount: number;
}

type Operator = ";" | "\n" | "&&" | "||" | "|" | "!" | "&" | RedirectionOperator;
type Token = { type: "word"; word: ShellWord } | { type: "operator"; value: Operator; offset: number };

const REDIRECTIONS = new Set<Operator>(["<", ">", ">>", "2>", "2>>", "2>&1"]);

function syntax(message: string, offset: number): VfsError {
  return new VfsError("EINVAL", `${message} at byte ${offset}`);
}

function byteOffset(script: string, offset: number): number {
  return new TextEncoder().encode(script.slice(0, offset)).byteLength;
}

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t" || value === "\r";
}

function operatorAt(script: string, offset: number, atWordBoundary: boolean): Operator | null {
  for (const candidate of ["&&", "||", ">>"] as const) {
    if (script.startsWith(candidate, offset)) return candidate;
  }
  if (atWordBoundary) {
    for (const candidate of ["2>&1", "2>>", "2>"] as const) {
      if (!script.startsWith(candidate, offset)) continue;
      const next = script[offset + candidate.length];
      if (candidate !== "2>&1" || next === undefined || isWhitespace(next) || ";\n|&<>".includes(next)) {
        return candidate;
      }
    }
  }
  const character = script[offset];
  if (character === ";" || character === "\n" || character === "|"
    || character === "&" || character === ">" || character === "<") return character;
  const next = script[offset + 1];
  if (
    character === "!"
    && atWordBoundary
    && (next === undefined || isWhitespace(next) || ";\n|&<>".includes(next))
  ) return character;
  return null;
}

function lex(script: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  let parts: WordPart[] = [];
  let wordOffset = 0;

  function startWord(): void {
    if (parts.length === 0) wordOffset = offset;
  }

  function append(kind: WordPartKind, value: string, quoted: boolean): void {
    startWord();
    const previous = parts.at(-1);
    if (previous?.kind === kind && previous.quoted === quoted) previous.value += value;
    else parts.push({ kind, value, quoted });
  }

  function flushWord(): void {
    if (parts.length === 0) return;
    const first = parts[0];
    const assignmentName = first !== undefined && !first.quoted
      ? /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(first.value)?.[1]
      : undefined;
    tokens.push({
      type: "word",
      word: {
        parts,
        sourceOffset: byteOffset(script, wordOffset),
        ...(assignmentName === undefined ? {} : { assignmentName }),
      },
    });
    parts = [];
  }

  while (offset < script.length) {
    const character = script[offset];
    if (character === undefined) break;
    if (character === "(" || character === ")") {
      throw syntax(
        "parenthesized syntax is not supported by this language version",
        byteOffset(script, offset),
      );
    }
    if (isWhitespace(character)) {
      flushWord();
      offset += 1;
      continue;
    }
    if (character === "#" && parts.length === 0) {
      while (offset < script.length && script[offset] !== "\n") offset += 1;
      continue;
    }
    if (parts.length === 0 && script.startsWith("2>&", offset)) {
      const exact = script.startsWith("2>&1", offset);
      const next = script[offset + 4];
      if (!exact || (next !== undefined && !isWhitespace(next) && !";\n|&<>".includes(next))) {
        throw syntax(
          "arbitrary file descriptors are not supported by this language version",
          byteOffset(script, offset),
        );
      }
    }
    const operator = operatorAt(script, offset, parts.length === 0);
    if (operator !== null) {
      if (
        (operator === ">" || operator === ">>" || operator === "<")
        && parts.length > 0
        && parts.every((part) => !part.quoted)
        && /^[0-9]+$/u.test(parts.map((part) => part.value).join(""))
      ) {
        throw syntax(
          "arbitrary file descriptors are not supported by this language version",
          byteOffset(script, wordOffset),
        );
      }
      flushWord();
      tokens.push({ type: "operator", value: operator, offset: byteOffset(script, offset) });
      offset += operator.length;
      continue;
    }
    if (character === "'") {
      startWord();
      const start = offset++;
      let value = "";
      while (offset < script.length && script[offset] !== "'") value += script[offset++];
      if (script[offset] !== "'") throw syntax("unterminated single quote", byteOffset(script, start));
      offset += 1;
      append("literal", value, true);
      continue;
    }
    if (character === "\"") {
      startWord();
      const start = offset++;
      let value = "";
      let appended = false;
      const flushExpandable = (): void => {
        if (value.length === 0) return;
        append("expand", value, true);
        appended = true;
        value = "";
      };
      while (offset < script.length && script[offset] !== "\"") {
        const current = script[offset++];
        if (current === "\\") {
          const next = script[offset];
          if (next === undefined) {
            throw syntax("unterminated escape", byteOffset(script, offset - 1));
          }
          if (next === "$" || next === "\"" || next === "\\" || next === "\n") {
            flushExpandable();
            if (next !== "\n") {
              append("literal", next, true);
              appended = true;
            }
            offset += 1;
          } else {
            value += `\\${next}`;
            offset += 1;
          }
        } else value += current;
      }
      if (script[offset] !== "\"") {
        throw syntax("unterminated double quote", byteOffset(script, start));
      }
      offset += 1;
      if (value.includes("$(") || value.includes("`")) {
        throw syntax(
          "command substitution is not supported by this language version",
          byteOffset(script, start),
        );
      }
      flushExpandable();
      if (!appended) append("literal", "", true);
      continue;
    }
    if (character === "$" && (script[offset + 1] === "'" || script[offset + 1] === "\"")) {
      throw syntax(
        "locale and ANSI-C quotes are not supported by this language version",
        byteOffset(script, offset),
      );
    }
    if (character === "\\") {
      startWord();
      const next = script[offset + 1];
      if (next === undefined) throw syntax("unterminated escape", byteOffset(script, offset));
      offset += 2;
      if (next !== "\n") append("literal", next, true);
      continue;
    }
    let value = "";
    startWord();
    while (offset < script.length) {
      const current = script[offset];
      if (current === "(" || current === ")") {
        throw syntax(
          "parenthesized syntax is not supported by this language version",
          byteOffset(script, offset),
        );
      }
      if (current === undefined || isWhitespace(current) || current === "'" || current === "\""
        || current === "\\" || operatorAt(script, offset, false) !== null) break;
      value += current;
      offset += 1;
    }
    if (value.includes("$(") || value.includes("`")) {
      throw syntax(
        "command substitution is not supported by this language version",
        byteOffset(script, wordOffset),
      );
    }
    if (/\$(?:\*|-|\$)/u.test(value)) {
      throw syntax(
        "special parameter is not supported by this language version",
        byteOffset(script, wordOffset),
      );
    }
    for (const match of value.matchAll(/\$\{([^}]*)\}/gu)) {
      if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[?#@]|[0-9]+)$/u.test(match[1] ?? "")) {
        throw syntax(
          "parameter expansion operator is not supported by this language version",
          byteOffset(script, wordOffset),
        );
      }
    }
    if (value.includes("${") && !/\$\{[^}]+\}/u.test(value)) {
      throw syntax("unterminated parameter expansion", byteOffset(script, wordOffset));
    }
    append("expand", value, false);
  }
  flushWord();
  return tokens;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private nodes = 1;
  private readonly maximumNodes: number;

  constructor(tokens: Token[], maximumNodes: number) {
    this.tokens = tokens;
    this.maximumNodes = maximumNodes;
  }

  parse(): ScriptNode {
    const lists: AndOrNode[] = [];
    this.skipSeparators();
    while (this.peek() !== undefined) {
      lists.push(this.andOr());
      const token = this.peek();
      if (token === undefined) break;
      if (token.type !== "operator" || (token.value !== ";" && token.value !== "\n")) {
        throw syntax("expected command separator", token.type === "word" ? token.word.sourceOffset : token.offset);
      }
      this.skipSeparators();
    }
    return { type: "script", lists, nodeCount: this.nodes };
  }

  private addNode(): void {
    this.nodes += 1;
    if (this.nodes > this.maximumNodes) throw new VfsError("E2BIG", "shell AST node limit exceeded");
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private take(): Token {
    const token = this.tokens[this.index++];
    if (token === undefined) throw syntax("unexpected end of script", 0);
    return token;
  }

  private skipSeparators(): void {
    while (true) {
      const token = this.peek();
      if (token?.type === "operator" && (token.value === ";" || token.value === "\n")) this.index += 1;
      else return;
    }
  }

  private andOr(): AndOrNode {
    this.addNode();
    const first = this.pipeline();
    const rest: AndOrNode["rest"] = [];
    while (true) {
      const token = this.peek();
      if (token?.type !== "operator" || (token.value !== "&&" && token.value !== "||")) break;
      this.take();
      rest.push({ operator: token.value, pipeline: this.pipeline() });
    }
    return { type: "and-or", first, rest };
  }

  private pipeline(): PipelineNode {
    this.addNode();
    let negated = false;
    const token = this.peek();
    if (token?.type === "operator" && token.value === "!") {
      this.take();
      negated = true;
    }
    const commands = [this.command()];
    while (this.peek()?.type === "operator" && this.peekOperator() === "|") {
      this.take();
      commands.push(this.command());
    }
    return { type: "pipeline", negated, commands };
  }

  private peekOperator(): Operator | undefined {
    const token = this.peek();
    return token?.type === "operator" ? token.value : undefined;
  }

  private command(): SimpleCommandNode {
    this.addNode();
    const first = this.peek();
    const sourceOffset = first === undefined
      ? 0
      : first.type === "word" ? first.word.sourceOffset : first.offset;
    const words: ShellWord[] = [];
    const redirections: Redirection[] = [];
    while (true) {
      const token = this.peek();
      if (token?.type === "word") {
        words.push(token.word);
        this.take();
        continue;
      }
      if (token?.type === "operator" && REDIRECTIONS.has(token.value)) {
        this.take();
        const operator = token.value as RedirectionOperator;
        if (operator === "2>&1") {
          redirections.push({ operator });
          continue;
        }
        const target = this.take();
        if (target.type !== "word") throw syntax("redirection requires a word", token.offset);
        redirections.push({ operator, target: target.word });
        continue;
      }
      break;
    }
    if (words.length === 0 && redirections.length === 0) throw syntax("expected command", sourceOffset);
    const reserved = new Set([
      "if", "then", "elif", "else", "fi", "for", "select", "while", "until",
      "do", "done", "case", "esac", "function", "time", "coproc", "{", "}",
    ]);
    const commandWord = words.find((word) => word.assignmentName === undefined);
    if (
      commandWord !== undefined
      && commandWord.parts.every((part) => !part.quoted)
      && reserved.has(commandWord.parts.map((part) => part.value).join(""))
    ) {
      throw syntax("reserved syntax is not supported by this language version", commandWord.sourceOffset);
    }
    const rawCommand = commandWord?.parts.map((part) => part.value).join("");
    if (rawCommand === "[[" || rawCommand === "]]" || /\[[^\]]*\]=/u.test(rawCommand ?? "")) {
      throw syntax("array and extended-test syntax is not supported by this language version", commandWord?.sourceOffset ?? sourceOffset);
    }
    for (const word of words) {
      const raw = word.parts.map((part) => part.value).join("");
      if (word.parts.some((part) => !part.quoted) && /\{[^{}]*,[^{}]*\}/u.test(raw)) {
        throw syntax("brace expansion is not supported by this language version", word.sourceOffset);
      }
    }
    return { type: "command", words, redirections, sourceOffset };
  }
}

export function parseShellScript(script: string, maximumNodes: number): ScriptNode {
  return new Parser(lex(script), maximumNodes).parse();
}
