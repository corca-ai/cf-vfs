import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { VfsError } from "../core/errors.js";
import { booleanValue, inputRecord, stringValue } from "../core/validation.js";
import { boundedTextValues, splitLogicalLines } from "./text-input.js";

export interface CommInput {
  left: string;
  right: string;
  suppressLeft?: boolean;
  suppressRight?: boolean;
  suppressCommon?: boolean;
  checkOrder?: boolean;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireSorted(lines: readonly string[], name: string): void {
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous !== undefined && current !== undefined && compareText(previous, current) > 0) {
      throw new VfsError("EINVAL", `${name} must be sorted`);
    }
  }
}

export async function runComm(
  _context: CommandContext,
  input: CommInput,
): Promise<CommandPayload<{ leftOnly: number; rightOnly: number; common: number }>> {
  const left = splitLogicalLines(input.left).lines;
  const right = splitLogicalLines(input.right).lines;
  if (input.checkOrder ?? true) {
    requireSorted(left, "left");
    requireSorted(right, "right");
  }
  const visible = [!input.suppressLeft, !input.suppressRight, !input.suppressCommon];
  const output: string[] = [];
  let leftOnly = 0;
  let rightOnly = 0;
  let common = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  const emit = (column: number, line: string): void => {
    if (!visible[column]) return;
    const prefix = visible.slice(0, column).filter(Boolean).length;
    output.push(`${"\t".repeat(prefix)}${line}`);
  };
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftLine = left[leftIndex];
    const rightLine = right[rightIndex];
    if (leftLine !== undefined && rightLine !== undefined && leftLine === rightLine) {
      common += 1;
      emit(2, leftLine);
      leftIndex += 1;
      rightIndex += 1;
    } else if (rightLine === undefined || (leftLine !== undefined && leftLine < rightLine)) {
      leftOnly += 1;
      emit(0, leftLine ?? "");
      leftIndex += 1;
    } else {
      rightOnly += 1;
      emit(1, rightLine);
      rightIndex += 1;
    }
  }
  return {
    stdout: output.length === 0 ? "" : `${output.join("\n")}\n`,
    data: { leftOnly, rightOnly, common },
  };
}

export const commCommand: CommandDefinition = {
  name: "comm",
  execute(context, input) {
    const record = inputRecord(input);
    const [left, right] = boundedTextValues(
      context,
      [stringValue(record, "left"), stringValue(record, "right")],
      "left and right",
    );
    return runComm(context, {
      left: left ?? "",
      right: right ?? "",
      suppressLeft: booleanValue(record, "suppressLeft"),
      suppressRight: booleanValue(record, "suppressRight"),
      suppressCommon: booleanValue(record, "suppressCommon"),
      checkOrder: booleanValue(record, "checkOrder", true),
    });
  },
};
