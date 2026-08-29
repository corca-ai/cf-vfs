import type { PosixRegex } from "../../core/posix-regex.js";

export type AssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "^=";

export type Expression =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "regex"; readonly pattern: PosixRegex }
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "field"; readonly index: Expression }
  | { readonly kind: "tuple"; readonly values: readonly Expression[] }
  | { readonly kind: "array"; readonly name: string; readonly indices: readonly Expression[] }
  | { readonly kind: "in"; readonly key: Expression; readonly array: string }
  | { readonly kind: "call"; readonly name: string; readonly arguments: readonly Expression[] }
  | { readonly kind: "unary"; readonly operator: "!" | "+" | "-"; readonly operand: Expression }
  | {
      readonly kind: "binary";
      readonly operator:
        | "+"
        | "-"
        | "*"
        | "/"
        | "%"
        | "^"
        | "=="
        | "!="
        | "<"
        | "<="
        | ">"
        | ">="
        | "~"
        | "!~"
        | "&&"
        | "||"
        | "concat";
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "conditional";
      readonly condition: Expression;
      readonly consequent: Expression;
      readonly alternate: Expression;
    }
  | {
      readonly kind: "assign";
      readonly target: LValue;
      readonly operator: AssignmentOperator;
      readonly value: Expression;
    }
  | {
      readonly kind: "update";
      readonly target: LValue;
      readonly delta: 1 | -1;
      readonly prefix: boolean;
    };

export type LValue = Extract<Expression, { kind: "variable" | "field" | "array" }>;

export type Statement =
  | { readonly kind: "print"; readonly values: readonly Expression[] }
  | { readonly kind: "printf"; readonly values: readonly Expression[] }
  | { readonly kind: "expression"; readonly expression: Expression }
  | {
      readonly kind: "if";
      readonly condition: Expression;
      readonly consequent: readonly Statement[];
      readonly alternate: readonly Statement[];
    }
  | { readonly kind: "while"; readonly condition: Expression; readonly body: readonly Statement[] }
  | { readonly kind: "do"; readonly body: readonly Statement[]; readonly condition: Expression }
  | {
      readonly kind: "for";
      readonly initialize?: Expression;
      readonly condition?: Expression;
      readonly update?: Expression;
      readonly body: readonly Statement[];
    }
  | {
      readonly kind: "for-in";
      readonly variable: string;
      readonly array: string;
      readonly body: readonly Statement[];
    }
  | { readonly kind: "delete"; readonly target: Extract<LValue, { kind: "array" }> }
  | { readonly kind: "break" }
  | { readonly kind: "continue" }
  | { readonly kind: "next" }
  | { readonly kind: "exit"; readonly status?: Expression };

export interface AwkRule {
  readonly phase: "begin" | "record" | "end";
  readonly pattern?: Expression;
  readonly rangeEnd?: Expression;
  /** Missing means AWK's default `{ print $0 }` action. */
  readonly action?: readonly Statement[];
}

export const PRINT_KINDS = ["print", "printf"] as const;
export const LOOP_CONTROL_KINDS = ["break", "continue"] as const;
export const ASSIGNMENT_OPERATORS = [
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "^=",
] as const satisfies readonly AssignmentOperator[];
export const COMPARISON_OPERATORS = [
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "~",
  "!~",
] as const satisfies readonly Extract<Expression, { kind: "binary" }>["operator"][];
export const ADDITIVE_OPERATORS = ["+", "-"] as const;
export const MULTIPLICATIVE_OPERATORS = ["*", "/", "%"] as const;
export const UNARY_OPERATORS = ["!", "+", "-"] as const;
export const AWK_BUILTINS = new Set([
  "gsub",
  "index",
  "int",
  "length",
  "match",
  "split",
  "sprintf",
  "sub",
  "substr",
  "tolower",
  "toupper",
]);
