import type { ArithmeticNode } from "./arithmetic.js";

export interface LiteralWordPart {
  kind: "literal";
  value: string;
  quoted: boolean;
}

export type ParameterOperator = "-" | ":-" | "=" | ":=" | "+" | ":+" | "?" | ":?";
export type ParameterDefaultOperator = ParameterOperator;

/** The original Version 2 AST shape, retained for parser API compatibility. */
export interface BasicParameterExpansion {
  name: string;
  length: boolean;
  operator?: ParameterOperator;
  word?: ShellWord;
}

interface AdvancedParameterExpansionBase {
  name: string;
  length: false;
  operator?: undefined;
  word?: undefined;
}

export type ParameterExpansion =
  | BasicParameterExpansion
  | (AdvancedParameterExpansionBase & {
      kind: "remove";
      removalOperator: "#" | "##" | "%" | "%%";
      pattern: ShellWord;
    })
  | (AdvancedParameterExpansionBase & {
      kind: "replace";
      all: boolean;
      pattern: ShellWord;
      replacement: ShellWord;
    })
  | (AdvancedParameterExpansionBase & {
      kind: "substring";
      offset: ShellWord;
      substringLength?: ShellWord;
    })
  | (AdvancedParameterExpansionBase & {
      kind: "indirect";
    });

export interface ParameterWordPart {
  kind: "parameter";
  expansion: ParameterExpansion;
  quoted: boolean;
}

export interface CommandWordPart {
  kind: "command";
  script: ScriptNode;
  quoted: boolean;
}

export interface ArithmeticWordPart {
  kind: "arithmetic";
  expression: ArithmeticNode;
  quoted: boolean;
}

export type WordPart = LiteralWordPart | ParameterWordPart | CommandWordPart | ArithmeticWordPart;

export interface ShellWord {
  parts: WordPart[];
  sourceOffset: number;
  assignmentName?: string;
}

const PATH_REDIRECTION_OPERATORS = ["<", ">", ">>", "2>", "2>>", "&>", "&>>"] as const;

export type PathRedirectionOperator = (typeof PATH_REDIRECTION_OPERATORS)[number];

export type Redirection =
  | { operator: PathRedirectionOperator; target: ShellWord }
  | { operator: "2>&1" }
  | { operator: ">&2" }
  | { operator: "<<<"; target: ShellWord }
  | { operator: "<<" | "<<-"; document: ShellWord };

export interface SimpleCommandNode {
  type: "command";
  words: ShellWord[];
  redirections: Redirection[];
  sourceOffset: number;
}

export interface GroupCommandNode {
  type: "group";
  body: ScriptNode;
  subshell: boolean;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface IfCommandNode {
  type: "if";
  branches: Array<{ condition: ScriptNode; body: ScriptNode }>;
  alternate?: ScriptNode;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface LoopCommandNode {
  type: "loop";
  condition: ScriptNode;
  body: ScriptNode;
  until: boolean;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface ForCommandNode {
  type: "for";
  name: string;
  words?: ShellWord[];
  body: ScriptNode;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface CaseCommandNode {
  type: "case";
  word: ShellWord;
  clauses: Array<{ patterns: ShellWord[]; body: ScriptNode }>;
  redirections: Redirection[];
  sourceOffset: number;
}

export interface ArithmeticCommandNode {
  type: "arithmetic-command";
  expression: ArithmeticNode;
  redirections: Redirection[];
  sourceOffset: number;
}

export type ConditionalUnaryOperator =
  | "-n"
  | "-z"
  | "-e"
  | "-f"
  | "-d"
  | "-s"
  | "-r"
  | "-w"
  | "-x"
  | "-L"
  | "-h"
  | "-c"
  | "-v";
export type ConditionalBinaryOperator =
  | "=="
  | "!="
  | "<"
  | ">"
  | "-eq"
  | "-ne"
  | "-lt"
  | "-le"
  | "-gt"
  | "-ge";

export type ConditionalExpression =
  | { type: "conditional-word"; word: ShellWord }
  | { type: "conditional-unary"; operator: ConditionalUnaryOperator; operand: ShellWord }
  | {
      type: "conditional-binary";
      operator: ConditionalBinaryOperator;
      left: ShellWord;
      right: ShellWord;
    }
  | { type: "conditional-not"; expression: ConditionalExpression }
  | {
      type: "conditional-boolean";
      operator: "&&" | "||";
      left: ConditionalExpression;
      right: ConditionalExpression;
    }
  | { type: "conditional-group"; expression: ConditionalExpression };

export interface DoubleBracketCommandNode {
  type: "double-bracket";
  expression: ConditionalExpression;
  redirections: Redirection[];
  sourceOffset: number;
}

export type CompoundCommandNode =
  | GroupCommandNode
  | IfCommandNode
  | LoopCommandNode
  | ForCommandNode
  | CaseCommandNode
  | ArithmeticCommandNode
  | DoubleBracketCommandNode;

export interface FunctionDefinitionNode {
  type: "function-definition";
  name: string;
  body: CompoundCommandNode;
  sourceOffset: number;
}

export type CommandNode = SimpleCommandNode | CompoundCommandNode | FunctionDefinitionNode;

export interface PipelineNode {
  type: "pipeline";
  negated: boolean;
  commands: CommandNode[];
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
