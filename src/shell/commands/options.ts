import { VfsError } from "../../core/errors.js";

type UtilityOptionDefinition<Name extends string> =
  | { readonly name: Name }
  | { readonly name: Name; readonly argument: true };

export interface UtilityOptionParserConfig<Name extends string> {
  readonly short?: Readonly<Record<string, UtilityOptionDefinition<Name>>>;
  readonly long?: Readonly<Record<string, UtilityOptionDefinition<Name>>>;
  readonly oldStyleCount?: Name;
  /**
   * Stops scanning at the first operand instead of permuting.
   *
   * A utility whose operands are themselves a command line needs this:
   * `command grep -c PATTERN` and `xargs grep -c PATTERN` must hand `-c` to
   * `grep`, not claim it. Without it the scanner reaches past the command name
   * and rejects the invoked utility's own options.
   */
  readonly stopAtFirstOperand?: boolean;
  /**
   * Treats `-123` as an operand rather than an option cluster. Utilities whose
   * operands are signed integers need this; it is mutually exclusive with
   * `oldStyleCount`, which claims the same spelling as an option.
   */
  readonly negativeNumberOperands?: boolean;
}

export type ParsedUtilityOption<Name extends string> =
  | { readonly name: Name }
  | { readonly name: Name; readonly argument: string };

export interface ParsedUtilityOptions<Name extends string> {
  readonly options: readonly ParsedUtilityOption<Name>[];
  readonly operands: readonly string[];
}

function optionDefinition<Name extends string>(
  definitions: Readonly<Record<string, UtilityOptionDefinition<Name>>> | undefined,
  name: string,
): UtilityOptionDefinition<Name> | undefined {
  return definitions !== undefined && Object.hasOwn(definitions, name)
    ? definitions[name]
    : undefined;
}

function usageError(command: string, message: string, synopsis: string | undefined): never {
  throw new VfsError(
    "EINVAL",
    synopsis === undefined ? `${command}: ${message}` : `${command}: ${message}\n${synopsis}`,
  );
}

function parseLongOption<Name extends string>(
  value: string,
  index: number,
  argv: readonly string[],
  config: UtilityOptionParserConfig<Name>,
  options: ParsedUtilityOption<Name>[],
  command: string,
  synopsis: string | undefined,
): number {
  const separator = value.indexOf("=");
  const spelling = separator < 0 ? value : value.slice(0, separator);
  const definition = optionDefinition(config.long, spelling.slice(2));
  if (definition === undefined) usageError(command, `unsupported option ${spelling}`, synopsis);
  if (!("argument" in definition)) {
    if (separator >= 0)
      usageError(command, `option ${spelling} does not accept an argument`, synopsis);
    options.push({ name: definition.name });
    return index;
  }
  const argument = separator < 0 ? argv[index + 1] : value.slice(separator + 1);
  if (argument === undefined)
    usageError(command, `option ${spelling} requires an argument`, synopsis);
  options.push({ name: definition.name, argument });
  return separator < 0 ? index + 1 : index;
}

function parseShortOptions<Name extends string>(
  value: string,
  index: number,
  argv: readonly string[],
  config: UtilityOptionParserConfig<Name>,
  options: ParsedUtilityOption<Name>[],
  command: string,
  synopsis: string | undefined,
): number {
  const cluster = [...value.slice(1)];
  for (let optionIndex = 0; optionIndex < cluster.length; optionIndex += 1) {
    const name = cluster[optionIndex] ?? "";
    const spelling = `-${name}`;
    const definition = optionDefinition(config.short, name);
    if (definition === undefined) usageError(command, `unsupported option ${spelling}`, synopsis);
    if (!("argument" in definition)) {
      options.push({ name: definition.name });
      continue;
    }
    const attached = cluster.slice(optionIndex + 1).join("");
    const argument = attached.length > 0 ? attached : argv[index + 1];
    if (argument === undefined)
      usageError(command, `option ${spelling} requires an argument`, synopsis);
    options.push({ name: definition.name, argument });
    return attached.length > 0 ? index : index + 1;
  }
  return index;
}

function parseNumericOption<Name extends string>(
  value: string,
  config: UtilityOptionParserConfig<Name>,
  options: ParsedUtilityOption<Name>[],
  operands: string[],
): boolean {
  if (!/^-[0-9]+$/u.test(value)) return false;
  if (config.negativeNumberOperands === true) operands.push(value);
  else if (config.oldStyleCount !== undefined) {
    options.push({ name: config.oldStyleCount, argument: value.slice(1) });
  } else return false;
  return true;
}

function isOperand(value: string): boolean {
  return value === "-" || !value.startsWith("-");
}

function appendRemainingWhenStopped(
  argv: readonly string[],
  start: number,
  stopAtFirstOperand: boolean | undefined,
  operands: string[],
): boolean {
  if (stopAtFirstOperand !== true) return false;
  operands.push(...argv.slice(start));
  return true;
}

export function parseUtilityOptions<Name extends string>(
  command: string,
  argv: readonly string[],
  config: UtilityOptionParserConfig<Name>,
  /** Synopsis appended to every diagnostic, when the caller declares one. */
  synopsis?: string,
): ParsedUtilityOptions<Name> {
  const options: ParsedUtilityOption<Name>[] = [];
  const operands: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (isOperand(value)) {
      if (appendRemainingWhenStopped(argv, index, config.stopAtFirstOperand, operands)) break;
      operands.push(value);
      continue;
    }
    if (value === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (value.startsWith("--")) {
      index = parseLongOption(value, index, argv, config, options, command, synopsis);
      continue;
    }
    if (parseNumericOption(value, config, options, operands)) continue;
    index = parseShortOptions(value, index, argv, config, options, command, synopsis);
  }

  return { options, operands };
}
