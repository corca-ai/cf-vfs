import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { inputRecord, integerValue, stringValue } from "../core/validation.js";
import { compareByteStreams, readFileByteStream } from "./file-content.js";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const HARD_MAX_BYTES = 64 * 1024 * 1024;

export interface CmpInput {
  from: string;
  to: string;
  maxBytes?: number;
}

export async function runCmp(
  context: CommandContext,
  input: CmpInput,
): Promise<CommandPayload<{
  from: string;
  to: string;
  equal: boolean;
  bytesCompared: number;
  firstDifferenceByte: number | null;
  firstDifferenceLine: number | null;
}>> {
  const maximum = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const from = await readFileByteStream(context, input.from, maximum);
  let to;
  try {
    to = await readFileByteStream(context, input.to, maximum);
  } catch (error) {
    await from.stream.cancel("comparison target could not be opened");
    throw error;
  }
  const compared = await compareByteStreams(from.stream, to.stream);
  const stdout = compared.equal
    ? ""
    : `${from.path} ${to.path} differ: byte ${compared.firstDifferenceByte}, line ${compared.firstDifferenceLine}\n`;
  return {
    exitCode: compared.equal ? 0 : 1,
    stdout,
    data: { from: from.path, to: to.path, ...compared },
  };
}

export const cmpCommand: CommandDefinition = {
  name: "cmp",
  execute(context, input) {
    const record = inputRecord(input);
    return runCmp(context, {
      from: stringValue(record, "from"),
      to: stringValue(record, "to"),
      maxBytes: integerValue(record, "maxBytes", DEFAULT_MAX_BYTES, 0, HARD_MAX_BYTES),
    });
  },
};
