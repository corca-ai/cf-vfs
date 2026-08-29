import { VfsError } from "../core/errors.js";
import type {
  CaseCommandNode,
  CommandNode,
  ConditionalExpression,
  ForCommandNode,
  IfCommandNode,
  LoopCommandNode,
  ParameterExpansion,
  Redirection,
  ScriptNode,
  ShellWord,
} from "./parser-ast.js";

function assertDepth(maximumDepth: number, depth: number): void {
  if (depth > maximumDepth) throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
}

function validateExpansionDepth(
  expansion: ParameterExpansion,
  maximumDepth: number,
  depth: number,
): void {
  if (!("kind" in expansion)) {
    if (expansion.word !== undefined) validateWordDepth(expansion.word, maximumDepth, depth);
    return;
  }
  if (expansion.kind === "remove") {
    validateWordDepth(expansion.pattern, maximumDepth, depth);
    return;
  }
  if (expansion.kind === "replace") {
    validateWordDepth(expansion.pattern, maximumDepth, depth);
    validateWordDepth(expansion.replacement, maximumDepth, depth);
    return;
  }
  if (expansion.kind === "substring") {
    validateWordDepth(expansion.offset, maximumDepth, depth);
    if (expansion.substringLength !== undefined) {
      validateWordDepth(expansion.substringLength, maximumDepth, depth);
    }
  }
}

function validateWordDepth(word: ShellWord, maximumDepth: number, depth: number): void {
  assertDepth(maximumDepth, depth);
  for (const part of word.parts) {
    if (part.kind === "command") validateScriptDepth(part.script, maximumDepth, depth + 1);
    if (part.kind === "parameter") {
      validateExpansionDepth(part.expansion, maximumDepth, depth + 1);
    }
  }
}

function validateRedirections(
  redirections: readonly Redirection[],
  maximumDepth: number,
  depth: number,
): void {
  for (const redirection of redirections) {
    if ("target" in redirection) validateWordDepth(redirection.target, maximumDepth, depth);
    if ("document" in redirection) validateWordDepth(redirection.document, maximumDepth, depth);
  }
}

function validateConditionalDepth(
  expression: ConditionalExpression,
  maximumDepth: number,
  depth: number,
): void {
  const pending: Array<{ expression: ConditionalExpression; depth: number }> = [
    { expression, depth },
  ];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    assertDepth(maximumDepth, current.depth);
    const item = current.expression;
    if (item.type === "conditional-word") {
      validateWordDepth(item.word, maximumDepth, current.depth);
    } else if (item.type === "conditional-unary") {
      validateWordDepth(item.operand, maximumDepth, current.depth);
    } else if (item.type === "conditional-binary") {
      validateWordDepth(item.left, maximumDepth, current.depth);
      validateWordDepth(item.right, maximumDepth, current.depth);
    } else if (item.type === "conditional-not" || item.type === "conditional-group") {
      pending.push({ expression: item.expression, depth: current.depth + 1 });
    } else {
      pending.push(
        { expression: item.right, depth: current.depth },
        { expression: item.left, depth: current.depth },
      );
    }
  }
}

function validateIfDepth(node: IfCommandNode, maximumDepth: number, depth: number): void {
  for (const branch of node.branches) {
    validateScriptDepth(branch.condition, maximumDepth, depth + 1);
    validateScriptDepth(branch.body, maximumDepth, depth + 1);
  }
  if (node.alternate !== undefined) validateScriptDepth(node.alternate, maximumDepth, depth + 1);
}

function validateLoopDepth(node: LoopCommandNode, maximumDepth: number, depth: number): void {
  validateScriptDepth(node.condition, maximumDepth, depth + 1);
  validateScriptDepth(node.body, maximumDepth, depth + 1);
}

function validateForDepth(node: ForCommandNode, maximumDepth: number, depth: number): void {
  for (const word of node.words ?? []) validateWordDepth(word, maximumDepth, depth);
  validateScriptDepth(node.body, maximumDepth, depth + 1);
}

function validateCaseDepth(node: CaseCommandNode, maximumDepth: number, depth: number): void {
  validateWordDepth(node.word, maximumDepth, depth);
  for (const clause of node.clauses) {
    for (const pattern of clause.patterns) validateWordDepth(pattern, maximumDepth, depth);
    validateScriptDepth(clause.body, maximumDepth, depth + 1);
  }
}

function validateCompoundDepth(node: CommandNode, maximumDepth: number, depth: number): void {
  if (node.type === "group") validateScriptDepth(node.body, maximumDepth, depth + 1);
  if (node.type === "if") validateIfDepth(node, maximumDepth, depth);
  if (node.type === "loop") validateLoopDepth(node, maximumDepth, depth);
  if (node.type === "for") validateForDepth(node, maximumDepth, depth);
  if (node.type === "case") validateCaseDepth(node, maximumDepth, depth);
  if (node.type === "double-bracket") {
    validateConditionalDepth(node.expression, maximumDepth, depth + 1);
  }
}

function validateCommandDepth(node: CommandNode, maximumDepth: number, depth: number): void {
  assertDepth(maximumDepth, depth);
  if (node.type === "command") {
    for (const word of node.words) validateWordDepth(word, maximumDepth, depth);
    validateRedirections(node.redirections, maximumDepth, depth);
    return;
  }
  if (node.type === "function-definition") {
    validateCommandDepth(node.body, maximumDepth, depth + 1);
    return;
  }
  validateRedirections(node.redirections, maximumDepth, depth);
  validateCompoundDepth(node, maximumDepth, depth);
}

export function validateScriptDepth(script: ScriptNode, maximumDepth: number, depth: number): void {
  assertDepth(maximumDepth, depth);
  for (const list of script.lists) {
    for (const pipeline of [list.first, ...list.rest.map((item) => item.pipeline)]) {
      for (const command of pipeline.commands) validateCommandDepth(command, maximumDepth, depth);
    }
  }
}
