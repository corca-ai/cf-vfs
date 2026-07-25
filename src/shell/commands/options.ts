import { VfsError } from "../../core/errors.js";

export type UtilityOptionDefinition<Name extends string> =
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

export function parseUtilityOptions<Name extends string>(
  command: string,
  argv: readonly string[],
  config: UtilityOptionParserConfig<Name>,
  /** Synopsis appended to every diagnostic, when the caller declares one. */
  synopsis?: string,
): ParsedUtilityOptions<Name> {
  const unsupported: (spelling: string) => never = (spelling) =>
    usageError(command, `unsupported option ${spelling}`, synopsis);
  const requiredArgument: (spelling: string) => never = (spelling) =>
    usageError(command, `option ${spelling} requires an argument`, synopsis);
  const options: ParsedUtilityOption<Name>[] = [];
  const operands: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (optionsEnded || value === "-" || !value.startsWith("-")) {
      if (config.stopAtFirstOperand === true) {
        operands.push(...argv.slice(index));
        break;
      }
      operands.push(value);
      continue;
    }
    if (value === "--") {
      if (config.stopAtFirstOperand === true) {
        operands.push(...argv.slice(index + 1));
        break;
      }
      optionsEnded = true;
      continue;
    }
    if (value.startsWith("--")) {
      const separator = value.indexOf("=");
      const spelling = separator < 0 ? value : value.slice(0, separator);
      const definition = optionDefinition(config.long, spelling.slice(2));
      if (definition === undefined) unsupported(spelling);
      if ("argument" in definition) {
        const argument = separator < 0 ? argv[++index] : value.slice(separator + 1);
        if (argument === undefined) requiredArgument(spelling);
        options.push({ name: definition.name, argument });
      } else {
        if (separator >= 0) {
          usageError(command, `option ${spelling} does not accept an argument`, synopsis);
        }
        options.push({ name: definition.name });
      }
      continue;
    }
    if (/^-[0-9]+$/u.test(value)) {
      if (config.negativeNumberOperands === true) {
        operands.push(value);
        continue;
      }
      if (config.oldStyleCount !== undefined) {
        options.push({ name: config.oldStyleCount, argument: value.slice(1) });
        continue;
      }
    }

    const cluster = [...value.slice(1)];
    for (let optionIndex = 0; optionIndex < cluster.length; optionIndex += 1) {
      const name = cluster[optionIndex] ?? "";
      const spelling = `-${name}`;
      const definition = optionDefinition(config.short, name);
      if (definition === undefined) unsupported(spelling);
      if (!("argument" in definition)) {
        options.push({ name: definition.name });
        continue;
      }
      const attached = cluster.slice(optionIndex + 1).join("");
      const argument = attached.length > 0 ? attached : argv[++index];
      if (argument === undefined) requiredArgument(spelling);
      options.push({ name: definition.name, argument });
      break;
    }
  }

  return { options, operands };
}
