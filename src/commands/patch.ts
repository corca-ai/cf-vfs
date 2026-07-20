import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { applyUnifiedPatch } from "../core/unified-patch.js";
import { inputRecord, optionalInteger, optionalString, stringValue } from "../core/validation.js";
import { commandPath } from "./common.js";
import { boundedTextValues, commandText } from "./text-input.js";

export interface PatchInput {
  path: string;
  patch: string;
  ifRevision?: number;
}

export async function runPatch(
  context: CommandContext,
  input: PatchInput,
): Promise<CommandPayload<{
  path: string;
  revision: number;
  sizeBytes: number;
  hunks: number;
  additions: number;
  deletions: number;
}>> {
  const path = commandPath(context, input.path);
  const current = await context.fileSystem.readText(path);
  const applied = applyUnifiedPatch(current.text, input.patch);
  const written = await context.fileSystem.writeText(path, applied.text, {
    disposition: "replace",
    ifRevision: input.ifRevision ?? current.stat.revision,
    mode: current.stat.mode,
  });
  return {
    data: {
      path: written.path,
      revision: written.revision,
      sizeBytes: written.sizeBytes,
      hunks: applied.hunks,
      additions: applied.additions,
      deletions: applied.deletions,
    },
  };
}

export const patchCommand: CommandDefinition = {
  name: "patch",
  execute(context, input) {
    const record = inputRecord(input);
    const ifRevision = optionalInteger(record, "ifRevision", 1, Number.MAX_SAFE_INTEGER);
    const explicitPatch = optionalString(record, "patch");
    const patch = boundedTextValues(
      context,
      [explicitPatch ?? commandText(context, record)],
      "patch",
    )[0] ?? "";
    return runPatch(context, {
      path: stringValue(record, "path"),
      patch,
      ...(ifRevision === undefined ? {} : { ifRevision }),
    });
  },
};
