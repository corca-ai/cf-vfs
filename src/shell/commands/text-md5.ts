import { isVfsError } from "../../core/errors.js";
import { Md5 } from "../../core/md5.js";
import { chargeConsumed } from "../content.js";
import type { ShellCommandContext } from "../types.js";
import { type AppletSpec, appletUsageError, defineApplet } from "./applet.js";
import { inputStreams, readWithAbort, writeText } from "./helpers.js";

const MD5SUM = {
  name: "md5sum",
  usage: "[FILE...]",
  summary: "prints the MD5 checksum of each file or of standard input",
} as const satisfies AppletSpec;

async function md5(
  context: ShellCommandContext,
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const digest = new Md5();
  const reader = stream.getReader();
  try {
    for (;;) {
      const read = await readWithAbort(reader, context.signal);
      if (read.done) break;
      chargeConsumed(context.budget, stream, read.value.byteLength);
      digest.update(read.value);
    }
  } finally {
    reader.releaseLock();
  }
  return digest.hex();
}

/**
 * Prints `DIGEST  NAME` per operand, `-` for standard input, as GNU does. The
 * body is streamed, so an opaque R2 body is read when the session may stream
 * it; an operand that cannot be read is reported and the rest still printed.
 */
export const md5sumCommand = /* @__PURE__ */ defineApplet(MD5SUM, async (context, argv, fds) => {
  const operands = argv[0] === "--" ? argv.slice(1) : argv;
  const option = argv[0] === "--" ? undefined : operands.find((value) => /^-./u.test(value));
  if (option !== undefined) throw appletUsageError(MD5SUM, `unsupported option ${option}`);
  let status = 0;
  for (const name of operands.length === 0 ? ["-"] : operands) {
    try {
      for await (const input of inputStreams(context, [name], fds[0])) {
        await writeText(fds[1], `${await md5(context, input.stream)}  ${name}\n`);
      }
    } catch (error) {
      if (!isVfsError(error)) throw error;
      await writeText(fds[2], `md5sum: ${name}: ${error.message}\n`);
      status = 1;
    }
  }
  return status;
});
