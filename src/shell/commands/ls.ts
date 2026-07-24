import { modeString } from "./format.js";
import { BufferedTextWriter, commandPath, defineCommand } from "./helpers.js";
import { parseUtilityOptions } from "./options.js";

const LS_OPTIONS = {
  short: {
    l: { name: "long" },
    d: { name: "directory" },
    a: { name: "all" },
    A: { name: "all" },
  },
} as const;

export const lsCommand = /* @__PURE__ */ defineCommand("ls", async (context, argv, fds) => {
  const parsed = parseUtilityOptions("ls", argv, LS_OPTIONS);
  const long = parsed.options.some((option) => option.name === "long");
  const directory = parsed.options.some((option) => option.name === "directory");
  const paths = parsed.operands.length === 0 ? ["."] : parsed.operands;
  const multiple = paths.length > 1;
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for (const [index, path] of paths.entries()) {
      const normalized = commandPath(context, path);
      const stat = await context.fileSystem.stat(normalized);
      const entries = stat.kind === "directory" && !directory
        ? await context.fileSystem.list(normalized)
        : [stat];
      if (multiple) await output.write(`${index === 0 ? "" : "\n"}${path}:\n`);
      for (const entry of entries) {
        await output.write(long
          ? `${modeString(entry.mode)} ${entry.sizeBytes.toString().padStart(8)} ${entry.name}\n`
          : `${entry.name}\n`);
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});
