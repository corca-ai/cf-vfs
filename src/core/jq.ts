import { JqRuntimeError, JqSyntaxError } from "./jq-errors.js";
import {
  type JqNode as Node,
  type JqObjectEntry as ObjectEntry,
  parseJqNode,
} from "./jq-parser.js";
import {
  applyBinary,
  clampIndex,
  flatten,
  hasMember,
  nullaryBuiltin,
  requireArray,
  requireNumber,
  SKIP,
  scalarText,
} from "./jq-values.js";
import {
  compareJson,
  isJsonNumber,
  isTruthy,
  type JsonObject,
  type JsonValue,
  jsonKind,
  numberOf,
  parseJsonText,
} from "./json-value.js";

export { JqRuntimeError, JqSyntaxError } from "./jq-errors.js";

const MAX_OUTPUTS = 100_000;

/**
 * A declared subset of the `jq` filter language.
 *
 * Paths, pipes, the comma, alternatives, comparison, arithmetic, array and
 * object construction, and a named list of builtins. Everything outside that is
 * refused where it is written rather than approximated, which is the same
 * stance the `sed` profile and the regular-expression subset take: a filter
 * this accepts means here what it means in `jq`, and one it does not accept is
 * a usage error before any input is read.
 *
 * Notably absent, and refused: `def`, `reduce`, `foreach`, `try`/`catch`,
 * `label`, `as` bindings, recursive descent `..`, string interpolation, format
 * strings such as `@base64`, and the regular-expression builtins. The last is
 * deliberate rather than pending — `jq` matches with Oniguruma and this
 * repository has a POSIX engine, so `test("a+")` would mean two different
 * things under one name.
 */

export interface JqOptions {
  /** Values bound to `$name`, from `--arg` and `--argjson`. */
  readonly variables?: ReadonlyMap<string, JsonValue> | undefined;
}

export function compileJq(source: string, options: JqOptions = {}): JqFilter {
  return new JqFilter(parseJqNode(source), options.variables ?? new Map());
}

// ------------------------------------------------------------ evaluation

export class JqFilter {
  constructor(
    private readonly node: Node,
    private readonly variables: ReadonlyMap<string, JsonValue>,
  ) {}

  /** Every value this filter produces for one input. */
  run(input: JsonValue): JsonValue[] {
    const out: JsonValue[] = [];
    for (const value of this.evaluate(this.node, input)) {
      out.push(value);
      if (out.length > MAX_OUTPUTS)
        throw new JqRuntimeError("jq: filter produced too many results");
    }
    return out;
  }

  private *evaluate(node: Node, input: JsonValue): Generator<JsonValue> {
    switch (node.kind) {
      case "identity":
        yield input;
        return;
      case "literal":
        yield node.value;
        return;
      case "variable":
        yield this.variable(node.name);
        return;
      case "pipe":
        yield* this.pipe(node, input);
        return;
      case "comma":
        yield* this.evaluate(node.left, input);
        yield* this.evaluate(node.right, input);
        return;
      case "alternative":
        yield* this.alternative(node, input);
        return;
      case "negate":
        yield* this.negate(node, input);
        return;
      case "field":
        yield* this.field(node, input);
        return;
      case "index":
        yield* this.index(node, input);
        return;
      case "slice":
        yield* this.slices(node, input);
        return;
      case "iterate":
        yield* this.iterate(node, input);
        return;
      case "array":
        yield node.body === undefined ? [] : [...this.evaluate(node.body, input)];
        return;
      case "object":
        yield* this.buildObject(node.entries, 0, new Map(), input);
        return;
      case "binary":
        yield* this.binary(node, input);
        return;
      default:
        yield* this.call(node, input);
    }
  }

  private variable(name: string): JsonValue {
    const value = this.variables.get(name);
    if (value === undefined) throw new JqRuntimeError(`jq: $${name} is not defined`);
    return value;
  }

  private *pipe(node: Extract<Node, { kind: "pipe" }>, input: JsonValue): Generator<JsonValue> {
    for (const left of this.evaluate(node.left, input)) yield* this.evaluate(node.right, left);
  }

  private *alternative(
    node: Extract<Node, { kind: "alternative" }>,
    input: JsonValue,
  ): Generator<JsonValue> {
    let produced = false;
    try {
      for (const value of this.evaluate(node.left, input)) {
        if (!isTruthy(value)) continue;
        produced = true;
        yield value;
      }
    } catch (error) {
      if (!(error instanceof JqRuntimeError)) throw error;
    }
    if (!produced) yield* this.evaluate(node.right, input);
  }

  private *negate(node: Extract<Node, { kind: "negate" }>, input: JsonValue): Generator<JsonValue> {
    for (const value of this.evaluate(node.of, input)) yield -requireNumber(value, "negated");
  }

  private *field(node: Extract<Node, { kind: "field" }>, input: JsonValue): Generator<JsonValue> {
    for (const target of this.evaluate(node.of, input)) {
      const value = this.member(target, node.name, node.optional);
      if (value !== SKIP) yield value;
    }
  }

  private *index(node: Extract<Node, { kind: "index" }>, input: JsonValue): Generator<JsonValue> {
    for (const target of this.evaluate(node.of, input)) {
      for (const index of this.evaluate(node.index, input)) {
        const value = this.at(target, index, node.optional);
        if (value !== SKIP) yield value;
      }
    }
  }

  private *slices(node: Extract<Node, { kind: "slice" }>, input: JsonValue): Generator<JsonValue> {
    for (const target of this.evaluate(node.of, input)) {
      const froms = node.from === undefined ? [null] : [...this.evaluate(node.from, input)];
      const tos = node.to === undefined ? [null] : [...this.evaluate(node.to, input)];
      for (const from of froms) {
        for (const to of tos) {
          const value = this.slice(target, from, to, node.optional);
          if (value !== SKIP) yield value;
        }
      }
    }
  }

  private *iterate(
    node: Extract<Node, { kind: "iterate" }>,
    input: JsonValue,
  ): Generator<JsonValue> {
    for (const target of this.evaluate(node.of, input)) {
      if (Array.isArray(target)) yield* target;
      else if (target instanceof Map) yield* target.values();
      else if (!node.optional)
        throw new JqRuntimeError(`jq: cannot iterate over ${jsonKind(target)}`);
    }
  }

  private *binary(node: Extract<Node, { kind: "binary" }>, input: JsonValue): Generator<JsonValue> {
    if (node.operator === "and" || node.operator === "or") return yield* this.boolean(node, input);
    // `jq` evaluates the right side first, so `.[] * 2` pairs each left value
    // with each right one in that order.
    for (const right of this.evaluate(node.right, input)) {
      for (const left of this.evaluate(node.left, input)) {
        yield applyBinary(node.operator, left, right);
      }
    }
  }

  private *boolean(
    node: Extract<Node, { kind: "binary" }>,
    input: JsonValue,
  ): Generator<JsonValue> {
    for (const left of this.evaluate(node.left, input)) {
      const shortCircuit = node.operator === "and" ? !isTruthy(left) : isTruthy(left);
      if (shortCircuit) yield node.operator === "or";
      else for (const right of this.evaluate(node.right, input)) yield isTruthy(right);
    }
  }

  private *buildObject(
    entries: readonly ObjectEntry[],
    index: number,
    built: JsonObject,
    input: JsonValue,
  ): Generator<JsonValue> {
    const entry = entries[index];
    if (entry === undefined) {
      yield new Map(built);
      return;
    }
    for (const key of this.evaluate(entry.key, input)) {
      if (typeof key !== "string") {
        throw new JqRuntimeError(`jq: object keys must be strings, not ${jsonKind(key)}`);
      }
      for (const value of this.evaluate(entry.value, input)) {
        const next = new Map(built);
        next.set(key, value);
        yield* this.buildObject(entries, index + 1, next, input);
      }
    }
  }

  private member(target: JsonValue, name: string, optional: boolean): JsonValue | typeof SKIP {
    if (target === null) return null;
    if (target instanceof Map) return target.get(name) ?? null;
    if (optional) return SKIP;
    throw new JqRuntimeError(`jq: cannot index ${jsonKind(target)} with "${name}"`);
  }

  private at(target: JsonValue, index: JsonValue, optional: boolean): JsonValue | typeof SKIP {
    if (typeof index === "string") return this.member(target, index, optional);
    if (isJsonNumber(index)) {
      if (target === null) return null;
      if (!Array.isArray(target)) {
        if (optional) return SKIP;
        throw new JqRuntimeError(`jq: cannot index ${jsonKind(target)} with a number`);
      }
      const position = Math.trunc(numberOf(index));
      const resolved = position < 0 ? target.length + position : position;
      return target[resolved] ?? null;
    }
    if (optional) return SKIP;
    throw new JqRuntimeError(`jq: cannot index ${jsonKind(target)} with ${jsonKind(index)}`);
  }

  private slice(
    target: JsonValue,
    from: JsonValue,
    to: JsonValue,
    optional: boolean,
  ): JsonValue | typeof SKIP {
    if (target === null) return null;
    if (typeof target === "string") {
      const points = [...target];
      const start = clampIndex(from, 0, points.length);
      const end = clampIndex(to, points.length, points.length);
      return points.slice(start, Math.max(start, end)).join("");
    }
    if (Array.isArray(target)) {
      const start = clampIndex(from, 0, target.length);
      const end = clampIndex(to, target.length, target.length);
      return target.slice(start, Math.max(start, end));
    }
    if (optional) return SKIP;
    throw new JqRuntimeError(`jq: cannot slice ${jsonKind(target)}`);
  }

  private *call(node: Extract<Node, { kind: "call" }>, input: JsonValue): Generator<JsonValue> {
    const { name, args } = node;
    if (args.length === 0) {
      const value = nullaryBuiltin(name, input);
      if (value !== SKIP) yield value;
      return;
    }
    if (args.length === 1) return yield* this.unaryCall(name, this.argument(node, 0), input);
    if (args.length === 2 && name === "range") {
      return yield* this.range(this.argument(node, 0), this.argument(node, 1), input);
    }
    throw new JqSyntaxError(`jq: ${name}/${args.length} is not a function in this profile`);
  }

  private argument(node: Extract<Node, { kind: "call" }>, index: number): Node {
    const argument = node.args[index];
    if (argument === undefined) {
      throw new JqRuntimeError(`jq: ${node.name} is missing an argument`);
    }
    return argument;
  }

  private *unaryCall(name: string, argument: Node, input: JsonValue): Generator<JsonValue> {
    switch (name) {
      case "has":
        return yield* this.has(argument, input);
      case "select":
        return yield* this.select(argument, input);
      case "map":
        return yield* this.map(argument, input);
      case "join":
        return yield* this.join(argument, input);
      case "split":
        return yield* this.split(argument, input);
      case "sort_by":
        return yield* this.sortBy(argument, input);
      case "range":
        return yield* this.range(undefined, argument, input);
      case "flatten":
        return yield* this.flatten(argument, input);
      default:
        throw new JqSyntaxError(`jq: ${name}/1 is not a function in this profile`);
    }
  }

  private *has(argument: Node, input: JsonValue): Generator<JsonValue> {
    for (const key of this.evaluate(argument, input)) yield hasMember(input, key);
  }

  private *select(argument: Node, input: JsonValue): Generator<JsonValue> {
    for (const test of this.evaluate(argument, input)) {
      if (isTruthy(test)) yield input;
    }
  }

  private *map(argument: Node, input: JsonValue): Generator<JsonValue> {
    const out: JsonValue[] = [];
    for (const item of requireArray(input, "map")) out.push(...this.evaluate(argument, item));
    yield out;
  }

  private *join(argument: Node, input: JsonValue): Generator<JsonValue> {
    for (const separator of this.evaluate(argument, input)) {
      if (typeof separator !== "string") throw new JqRuntimeError("jq: join needs a string");
      yield requireArray(input, "join")
        .map((item) => (item === null ? "" : scalarText(item, "join")))
        .join(separator);
    }
  }

  private *split(argument: Node, input: JsonValue): Generator<JsonValue> {
    for (const separator of this.evaluate(argument, input)) {
      if (typeof input !== "string" || typeof separator !== "string") {
        throw new JqRuntimeError("jq: split needs strings");
      }
      yield separator === "" ? [...input] : input.split(separator);
    }
  }

  private *sortBy(argument: Node, input: JsonValue): Generator<JsonValue> {
    const keyed = requireArray(input, "sort_by").map((item) => ({
      item,
      key: [...this.evaluate(argument, item)],
    }));
    keyed.sort((left, right) => compareJson(left.key, right.key));
    yield keyed.map((entry) => entry.item);
  }

  private *range(fromNode: Node | undefined, toNode: Node, input: JsonValue): Generator<JsonValue> {
    const froms =
      fromNode === undefined
        ? [0]
        : [...this.evaluate(fromNode, input)].map((value) => requireNumber(value, "range"));
    const tos = [...this.evaluate(toNode, input)].map((value) => requireNumber(value, "range"));
    for (const from of froms) {
      for (const to of tos) {
        for (let value = from; value < to; value += 1) yield value;
      }
    }
  }

  private *flatten(argument: Node, input: JsonValue): Generator<JsonValue> {
    for (const value of this.evaluate(argument, input)) {
      yield flatten(requireArray(input, "flatten"), requireNumber(value, "flatten"));
    }
  }
}

/** Parses one `--argjson` value, which is ordinary JSON. */
export function parseJqArgument(text: string): JsonValue {
  return parseJsonText(text, "jq");
}
