import { VfsError } from "../core/errors.js";
import type {
  AndOrNode,
  ArithmeticCommandNode,
  CaseCommandNode,
  CommandNode,
  ForCommandNode,
  FunctionDefinitionNode,
  GroupCommandNode,
  IfCommandNode,
  LoopCommandNode,
  PipelineNode,
  Redirection,
  ScriptNode,
  ShellWord,
  SimpleCommandNode,
} from "./parser-ast.js";

export type * from "./parser-ast.js";
export { isIncompleteShellSyntaxError } from "./parser-errors.js";

import { ConditionalParser } from "./parser-conditional.js";
import { incompleteShellSyntaxError } from "./parser-errors.js";
import { Lexer } from "./parser-lexer.js";
import {
  isPathRedirectionOperator,
  type Operator,
  ParseContext,
  REDIRECTIONS,
  staticWord,
  type Token,
  UNSUPPORTED_RESERVED,
} from "./parser-support.js";
import { validateScriptDepth } from "./parser-validation.js";

export const BASH_COMPATIBILITY_VERSION = 5 as const;

class Parser extends ConditionalParser {
  protected andOr(): AndOrNode {
    this.add();
    const first = this.pipeline();
    const rest: AndOrNode["rest"] = [];
    while (true) {
      const token = this.peek();
      if (token?.type !== "operator" || (token.value !== "&&" && token.value !== "||")) break;
      this.take();
      this.skipNewlines();
      rest.push({ operator: token.value, pipeline: this.pipeline() });
    }
    return { type: "and-or", first, rest };
  }

  private pipeline(): PipelineNode {
    this.add();
    let negated = false;
    if (this.peekOperator() === "!") {
      this.take();
      negated = true;
    }
    const commands = [this.command()];
    while (this.peekOperator() === "|") {
      this.take();
      this.skipNewlines();
      commands.push(this.command());
    }
    return { type: "pipeline", negated, commands };
  }

  private command(): CommandNode {
    const token = this.peek();
    if (token === undefined) throw incompleteShellSyntaxError("expected command at end of script");
    if (token.type === "operator") return this.operatorCommand(token);
    if (token.type === "arithmetic-command") return this.arithmeticCommand();
    return this.wordCommand(staticWord(token.word));
  }

  private operatorCommand(token: Extract<Token, { type: "operator" }>): CommandNode {
    if (token.value === "{") return this.group(false);
    if (token.value === "(") return this.group(true);
    if (token.value === "&") throw this.tokenError("background jobs are not supported", token);
    if (REDIRECTIONS.has(token.value)) return this.simpleCommand();
    throw this.tokenError("expected command", token);
  }

  private wordCommand(value: string | undefined): CommandNode {
    if (value === "[[") return this.doubleBracketCommand();
    if (value === "if") return this.ifCommand();
    if (value === "while" || value === "until") return this.loopCommand(value === "until");
    if (value === "for") return this.forCommand();
    if (value === "case") return this.caseCommand();
    if (value !== undefined && this.isFunctionStart(value)) return this.functionDefinition(value);
    return this.simpleCommand();
  }

  private isFunctionStart(value: string): boolean {
    return (
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) &&
      this.peekOperator(1) === "(" &&
      this.peekOperator(2) === ")"
    );
  }

  private group(subshell: boolean): GroupCommandNode {
    return this.withDepth(() => {
      const open = this.take();
      const sourceOffset = open.type === "operator" ? open.offset : 0;
      const close: Operator = subshell ? ")" : "}";
      const body = this.requiredList(
        { operators: new Set([close]) },
        subshell ? "subshell" : "brace group",
        !subshell,
      );
      if (this.peek() === undefined) {
        throw incompleteShellSyntaxError(`expected ${close} at byte ${sourceOffset}`);
      }
      this.expectOperator(close);
      const redirections = this.redirections();
      this.add();
      return { type: "group", body, subshell, redirections, sourceOffset };
    });
  }

  private ifCommand(): IfCommandNode {
    return this.withDepth(() => this.parseIfCommand());
  }

  private parseIfCommand(): IfCommandNode {
    const sourceOffset = this.takeWordOffset();
    const branches: IfCommandNode["branches"] = [];
    let condition = this.requiredList({ words: new Set(["then"]) }, "if condition", true);
    this.expectWord("then");
    while (true) {
      const body = this.requiredList({ words: new Set(["elif", "else", "fi"]) }, "if branch", true);
      branches.push({ condition, body });
      const keyword = this.ifTerminator();
      if (keyword !== "elif") return this.finishIf(sourceOffset, branches, keyword);
      this.take();
      condition = this.requiredList({ words: new Set(["then"]) }, "elif condition", true);
      this.expectWord("then");
    }
  }

  private ifTerminator(): string | undefined {
    const next = this.peek();
    if (next?.type === "word") return staticWord(next.word);
    if (next === undefined) throw incompleteShellSyntaxError("expected fi at end of script");
    throw this.tokenError("expected elif, else, or fi", next);
  }

  private finishIf(
    sourceOffset: number,
    branches: IfCommandNode["branches"],
    keyword: string | undefined,
  ): IfCommandNode {
    let alternate: ScriptNode | undefined;
    if (keyword === "else") {
      this.take();
      alternate = this.requiredList({ words: new Set(["fi"]) }, "else branch", true);
    }
    this.expectWord("fi");
    const redirections = this.redirections();
    this.add();
    return {
      type: "if",
      branches,
      ...(alternate === undefined ? {} : { alternate }),
      redirections,
      sourceOffset,
    };
  }

  private loopCommand(until: boolean): LoopCommandNode {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      const condition = this.requiredList(
        { words: new Set(["do"]) },
        until ? "until condition" : "while condition",
        true,
      );
      this.expectWord("do");
      const body = this.requiredList(
        { words: new Set(["done"]) },
        until ? "until body" : "while body",
        true,
      );
      this.expectWord("done");
      const redirections = this.redirections();
      this.add();
      return { type: "loop", condition, body, until, redirections, sourceOffset };
    });
  }

  private forCommand(): ForCommandNode {
    return this.withDepth(() => this.parseForCommand());
  }

  private parseForCommand(): ForCommandNode {
    const sourceOffset = this.takeWordOffset();
    const nameToken = this.take();
    const name = nameToken.type === "word" ? staticWord(nameToken.word) : undefined;
    if (name === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw this.tokenError("for requires a variable name", nameToken);
    }
    let words: ShellWord[] | undefined;
    if (this.peek()?.type === "word" && staticWord(this.peekWord()) === "in") {
      this.take();
      words = [];
      while (this.peek()?.type === "word") words.push(this.takeWord());
    }
    if (!this.isSeparator(this.peek())) {
      const token = this.peek();
      if (token === undefined) {
        throw incompleteShellSyntaxError("for requires do at end of script");
      }
      throw this.tokenError("for word list requires a separator", token);
    }
    this.skipSeparators();
    this.expectWord("do");
    const body = this.requiredList({ words: new Set(["done"]) }, "for body", true);
    this.expectWord("done");
    const redirections = this.redirections();
    this.add();
    return {
      type: "for",
      name,
      ...(words === undefined ? {} : { words }),
      body,
      redirections,
      sourceOffset,
    };
  }

  private caseCommand(): CaseCommandNode {
    return this.withDepth(() => this.parseCaseCommand());
  }

  private parseCaseCommand(): CaseCommandNode {
    const sourceOffset = this.takeWordOffset();
    const word = this.takeWord();
    this.skipNewlines();
    this.expectWord("in");
    this.skipSeparators();
    const clauses: CaseCommandNode["clauses"] = [];
    while (this.peek()?.type !== "word" || staticWord(this.peekWord()) !== "esac") {
      if (this.peekOperator() === "(") this.take();
      const patterns: ShellWord[] = [this.takeWord()];
      while (this.peekOperator() === "|") {
        this.take();
        patterns.push(this.takeWord());
      }
      this.expectOperator(")");
      const body = this.parse({ words: new Set(["esac"]), operators: new Set([";;"]) });
      clauses.push({ patterns, body });
      if (this.peekOperator() === ";;") {
        this.take();
        this.skipSeparators();
      } else if (this.peek()?.type !== "word" || staticWord(this.peekWord()) !== "esac") {
        const token = this.peek();
        if (token === undefined) {
          throw incompleteShellSyntaxError("expected esac at end of script");
        }
        throw this.tokenError("case clause requires ;; or esac", token);
      }
    }
    this.expectWord("esac");
    const redirections = this.redirections();
    this.add();
    return { type: "case", word, clauses, redirections, sourceOffset };
  }

  private arithmeticCommand(): ArithmeticCommandNode {
    const token = this.take();
    if (token.type !== "arithmetic-command")
      throw this.tokenError("expected arithmetic command", token);
    const redirections = this.redirections();
    this.add();
    return {
      type: "arithmetic-command",
      expression: token.expression,
      redirections,
      sourceOffset: token.offset,
    };
  }

  private functionDefinition(name: string): FunctionDefinitionNode {
    const token = this.take();
    const sourceOffset = token.type === "word" ? token.word.sourceOffset : 0;
    this.expectOperator("(");
    this.expectOperator(")");
    this.skipNewlines();
    const body = this.command();
    if (body.type === "command" || body.type === "function-definition") {
      throw new VfsError(
        "EINVAL",
        `function body must be a compound command at byte ${sourceOffset}`,
      );
    }
    this.add();
    return { type: "function-definition", name, body, sourceOffset };
  }

  private simpleCommand(): SimpleCommandNode {
    this.add();
    const first = this.peek();
    const sourceOffset = this.tokenOffset(first);
    const words: ShellWord[] = [];
    const redirections: Redirection[] = [];
    this.collectSimpleCommand(words, redirections);
    this.assertCommandParts(first, words, redirections);
    this.validateCommandWord(words, sourceOffset);
    return { type: "command", words, redirections, sourceOffset };
  }

  private collectSimpleCommand(words: ShellWord[], redirections: Redirection[]): void {
    while (true) {
      const token = this.peek();
      if (token?.type === "word") {
        words.push(token.word);
        this.take();
        continue;
      }
      if (token?.type === "operator" && REDIRECTIONS.has(token.value)) {
        redirections.push(this.redirection());
        continue;
      }
      return;
    }
  }

  private assertCommandParts(
    first: Token | undefined,
    words: readonly ShellWord[],
    redirections: readonly Redirection[],
  ): void {
    if (words.length === 0 && redirections.length === 0) {
      if (first === undefined)
        throw incompleteShellSyntaxError("expected command at end of script");
      throw this.tokenError("expected command", first);
    }
  }

  private validateCommandWord(words: readonly ShellWord[], sourceOffset: number): void {
    const commandWord = words.find((word) => word.assignmentName === undefined);
    const rawCommand = staticWord(commandWord);
    if (rawCommand !== undefined && UNSUPPORTED_RESERVED.has(rawCommand)) {
      throw new VfsError(
        "EINVAL",
        `reserved syntax ${rawCommand} is not supported at byte ${commandWord?.sourceOffset ?? sourceOffset}`,
      );
    }
    if (rawCommand === "[[" || rawCommand === "]]" || /\[[^\]]*\]=/u.test(rawCommand ?? "")) {
      throw new VfsError(
        "EINVAL",
        `array and extended-test syntax is not supported at byte ${commandWord?.sourceOffset ?? sourceOffset}`,
      );
    }
  }

  private tokenOffset(token: Token | undefined): number {
    if (token === undefined) return 0;
    return token.type === "word" ? token.word.sourceOffset : token.offset;
  }

  protected redirections(): Redirection[] {
    const output: Redirection[] = [];
    while (this.peek()?.type === "operator" && REDIRECTIONS.has(this.peekOperator() ?? ";")) {
      output.push(this.redirection());
    }
    return output;
  }

  private redirection(): Redirection {
    const token = this.take();
    if (token.type !== "operator" || !REDIRECTIONS.has(token.value)) {
      throw this.tokenError("expected redirection", token);
    }
    if (token.value === "2>&1") return { operator: "2>&1" };
    if (token.value === ">&2") return { operator: ">&2" };
    const target = this.take();
    if (target.type !== "word") throw this.tokenError("redirection requires a word", target);
    if (token.value === "<<" || token.value === "<<-") {
      if (token.document === undefined)
        throw this.tokenError("here-document body is missing", token);
      return { operator: token.value, document: token.document };
    }
    if (token.value === "<<<") return { operator: "<<<", target: target.word };
    if (!isPathRedirectionOperator(token.value))
      throw this.tokenError("unsupported redirection", token);
    return { operator: token.value, target: target.word };
  }
}

function parseInternal(
  source: string,
  context: ParseContext,
  baseByteOffset: number,
  depth: number,
): ScriptNode {
  context.depth(depth);
  const tokens = new Lexer(source, context, baseByteOffset, depth, parseInternal).lex();
  const parser = new Parser(tokens, context, depth);
  const script = parser.parse();
  if (!parser.finished()) throw new VfsError("EINVAL", "unexpected trailing shell syntax");
  return script;
}

export function parseShellScript(
  script: string,
  maximumNodes: number,
  maximumDepth = 64,
  accountNodes: (count: number) => void = () => undefined,
  checkDeadline: () => void = () => undefined,
): ScriptNode {
  const context = new ParseContext(maximumNodes, maximumDepth, accountNodes, checkDeadline);
  const parsed = parseInternal(script, context, 0, 1);
  const result = { ...parsed, nodeCount: context.nodes };
  validateScriptDepth(result, maximumDepth, 1);
  return result;
}
