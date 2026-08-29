import { AwkSyntaxError, type AwkToken, type AwkTokenKind } from "./awk-lexer.js";

export class AwkParserCursor {
  protected index = 0;
  private nodes = 0;
  private depth = 0;

  constructor(
    private readonly tokens: readonly AwkToken[],
    private readonly maximumNodes: number,
    private readonly maximumDepth: number,
  ) {}

  protected node<T>(value: T): T {
    this.nodes += 1;
    if (this.nodes > this.maximumNodes) this.fail("program node limit exceeded");
    return value;
  }

  protected nested<T>(read: () => T): T {
    this.depth += 1;
    if (this.depth > this.maximumDepth) this.fail("program nesting limit exceeded");
    try {
      return read();
    } finally {
      this.depth -= 1;
    }
  }

  protected current(): AwkToken {
    return this.tokens[this.index] ?? this.tokens.at(-1) ?? { kind: "eof", value: "", offset: 0 };
  }

  protected at(kind: AwkTokenKind): boolean {
    return this.current().kind === kind;
  }

  protected atIdentifier(value?: string): boolean {
    return this.at("identifier") && (value === undefined || this.current().value === value);
  }

  protected nextIsIdentifier(value: string): boolean {
    const token = this.tokens[this.index + 1];
    return token?.kind === "identifier" && token.value === value;
  }

  protected atOperator(value: string): boolean {
    return this.at("operator") && this.current().value === value;
  }

  protected take(): AwkToken {
    const token = this.current();
    this.index += 1;
    return token;
  }

  protected atOneOf(kind: AwkTokenKind, values: readonly string[]): boolean {
    const current = this.current();
    return current.kind === kind && values.some((value) => value === current.value);
  }

  protected takeOneOf<const Values extends readonly string[]>(
    kind: AwkTokenKind,
    values: Values,
  ): Values[number] {
    const token = this.take();
    if (token.kind === kind) {
      for (const value of values) {
        if (token.value === value) return value;
      }
    }
    this.fail(`unexpected ${token.value}`, token);
  }

  protected expectOperator(value: string): void {
    if (!this.atOperator(value)) this.fail(`expected ${value}`);
    this.take();
  }

  protected fail(message: string, token = this.current()): never {
    throw new AwkSyntaxError(message, token.offset);
  }
}
