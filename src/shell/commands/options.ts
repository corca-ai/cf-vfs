import { VfsError } from "../../core/errors.js";

export type UtilityOptionDefinition<Name extends string> =
  | { readonly name: Name }
  | { readonly name: Name; readonly argument: true };

export interface UtilityOptionParserConfig<Name extends string> {
  readonly short?: Readonly<Record<string, UtilityOptionDefinition<Name>>>;
  readonly long?: Readonly<Record<string, UtilityOptionDefinition<Name>>>;
  readonly oldStyleCount?: Name;
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

function unsupported(command: string, spelling: string): never {
  throw new VfsError("EINVAL", `${command}: unsupported option ${spelling}`);
}

function requiredArgument(command: string, spelling: string): never {
  throw new VfsError("EINVAL", `${command}: option ${spelling} requires an argument`);
}

export function parseUtilityOptions<Name extends string>(
  command: string,
  argv: readonly string[],
  config: UtilityOptionParserConfig<Name>,
): ParsedUtilityOptions<Name> {
  const options: ParsedUtilityOption<Name>[] = [];
  const operands: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (optionsEnded || value === "-" || !value.startsWith("-")) {
      operands.push(value);
      continue;
    }
    if (value === "--") {
      optionsEnded = true;
      continue;
    }
    if (value.startsWith("--")) {
      const separator = value.indexOf("=");
      const spelling = separator < 0 ? value : value.slice(0, separator);
      const definition = optionDefinition(config.long, spelling.slice(2));
      if (definition === undefined) unsupported(command, spelling);
      if ("argument" in definition) {
        const argument = separator < 0 ? argv[++index] : value.slice(separator + 1);
        if (argument === undefined) requiredArgument(command, spelling);
        options.push({ name: definition.name, argument });
      } else {
        if (separator >= 0) {
          throw new VfsError("EINVAL", `${command}: option ${spelling} does not accept an argument`);
        }
        options.push({ name: definition.name });
      }
      continue;
    }
    if (config.oldStyleCount !== undefined && /^-[0-9]+$/u.test(value)) {
      options.push({ name: config.oldStyleCount, argument: value.slice(1) });
      continue;
    }

    const cluster = [...value.slice(1)];
    for (let optionIndex = 0; optionIndex < cluster.length; optionIndex += 1) {
      const name = cluster[optionIndex] ?? "";
      const spelling = `-${name}`;
      const definition = optionDefinition(config.short, name);
      if (definition === undefined) unsupported(command, spelling);
      if (!("argument" in definition)) {
        options.push({ name: definition.name });
        continue;
      }
      const attached = cluster.slice(optionIndex + 1).join("");
      const argument = attached.length > 0 ? attached : argv[++index];
      if (argument === undefined) requiredArgument(command, spelling);
      options.push({ name: definition.name, argument });
      break;
    }
  }

  return { options, operands };
}
