import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import { inputRecord, integerValue, optionalStringChoice, stringValue } from "../core/validation.js";
import { boundedTextValues, splitLogicalLines } from "./text-input.js";

export const JOIN_UNPAIRED = ["none", "left", "right", "both"] as const;
export type JoinUnpaired = typeof JOIN_UNPAIRED[number];

export interface JoinInput {
  left: string;
  right: string;
  delimiter?: string;
  leftField?: number;
  rightField?: number;
  unpaired?: JoinUnpaired;
  maxRows?: number;
}

interface IndexedLine {
  fields: string[];
  index: number;
  line: string;
}

export async function runJoin(
  _context: CommandContext,
  input: JoinInput,
): Promise<CommandPayload<{ rows: number; matchedPairs: number }>> {
  const delimiter = input.delimiter ?? " ";
  if (delimiter.length === 0) throw new VfsError("EINVAL", "delimiter cannot be empty");
  const leftField = (input.leftField ?? 1) - 1;
  const rightField = (input.rightField ?? 1) - 1;
  const left = splitLogicalLines(input.left).lines.map((line, index) => ({
    fields: line.split(delimiter),
    index,
    line,
  }));
  const right = splitLogicalLines(input.right).lines.map((line, index) => ({
    fields: line.split(delimiter),
    index,
    line,
  }));
  const rightByKey = new Map<string, IndexedLine[]>();
  for (const entry of right) {
    const key = entry.fields[rightField];
    if (key === undefined) throw new VfsError("EINVAL", `right line ${entry.index + 1} has no join field`);
    const group = rightByKey.get(key) ?? [];
    group.push(entry);
    rightByKey.set(key, group);
  }
  const matchedRight = new Set<number>();
  const output: string[] = [];
  const maximumRows = input.maxRows ?? 10_000;
  let matchedPairs = 0;
  const unpaired = input.unpaired ?? "none";
  const emit = (line: string): void => {
    if (output.length >= maximumRows) {
      throw new VfsError("E2BIG", `join exceeds the ${maximumRows}-row limit`);
    }
    output.push(line);
  };
  for (const entry of left) {
    const key = entry.fields[leftField];
    if (key === undefined) throw new VfsError("EINVAL", `left line ${entry.index + 1} has no join field`);
    const matches = rightByKey.get(key) ?? [];
    if (matches.length === 0) {
      if (unpaired === "left" || unpaired === "both") emit(entry.line);
      continue;
    }
    for (const match of matches) {
      matchedRight.add(match.index);
      matchedPairs += 1;
      emit([
        key,
        ...entry.fields.filter((_field, index) => index !== leftField),
        ...match.fields.filter((_field, index) => index !== rightField),
      ].join(delimiter));
    }
  }
  if (unpaired === "right" || unpaired === "both") {
    for (const entry of right) {
      if (!matchedRight.has(entry.index)) emit(entry.line);
    }
  }
  return {
    stdout: output.length === 0 ? "" : `${output.join("\n")}\n`,
    data: { rows: output.length, matchedPairs },
  };
}

export const joinCommand: CommandDefinition = {
  name: "join",
  execute(context, input) {
    const record = inputRecord(input);
    const [left, right] = boundedTextValues(
      context,
      [stringValue(record, "left"), stringValue(record, "right")],
      "left and right",
    );
    const unpaired = optionalStringChoice(record, "unpaired", JOIN_UNPAIRED);
    return runJoin(context, {
      left: left ?? "",
      right: right ?? "",
      delimiter: stringValue(record, "delimiter", " "),
      leftField: integerValue(record, "leftField", 1, 1, 1_000_000),
      rightField: integerValue(record, "rightField", 1, 1, 1_000_000),
      maxRows: integerValue(record, "maxRows", 10_000, 1, 100_000),
      ...(unpaired === undefined ? {} : { unpaired }),
    });
  },
};
