import type { CommandContext, CommandDefinition, CommandPayload } from "../core/command.js";
import { integerValue } from "../core/validation.js";
import { oneOrManyPaths } from "./common.js";
import { hexDigest, readFileByteStream } from "./file-content.js";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const HARD_MAX_BYTES = 256 * 1024 * 1024;

export interface Sha256sumInput {
  paths: string[];
  maxBytes?: number;
}

export interface Sha256sumEntry {
  path: string;
  digest: string;
  sizeBytes: number;
}

export async function runSha256sum(
  context: CommandContext,
  input: Sha256sumInput,
): Promise<CommandPayload<{ entries: Sha256sumEntry[] }>> {
  const entries: Sha256sumEntry[] = [];
  for (const requested of input.paths) {
    const file = await readFileByteStream(context, requested, input.maxBytes ?? DEFAULT_MAX_BYTES);
    const DigestStreamConstructor = (crypto as Crypto & {
      DigestStream: typeof DigestStream;
    }).DigestStream;
    const digestStream = new DigestStreamConstructor("SHA-256");
    await file.stream.pipeTo(digestStream);
    entries.push({
      path: file.path,
      digest: hexDigest(await digestStream.digest),
      sizeBytes: file.stat.sizeBytes,
    });
  }
  return {
    stdout: entries.map((entry) => `${entry.digest}  ${entry.path}`).join("\n") + "\n",
    data: { entries },
  };
}

export const sha256sumCommand: CommandDefinition = {
  name: "sha256sum",
  execute(context, input) {
    const { record, paths } = oneOrManyPaths(input);
    return runSha256sum(context, {
      paths,
      maxBytes: integerValue(record, "maxBytes", DEFAULT_MAX_BYTES, 0, HARD_MAX_BYTES),
    });
  },
};
