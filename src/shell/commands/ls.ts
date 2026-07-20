import { VfsError } from "../../core/errors.js";
import { BufferedTextWriter, commandPath, defineCommand } from "./helpers.js";

function modeString(mode: number): string {
  const kind = (mode & 0o040000) !== 0 ? "d" : "-";
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const labels = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return kind + bits.map((bit, index) => (mode & bit) !== 0 ? labels[index] : "-").join("");
}

export const lsCommand = /* @__PURE__ */ defineCommand("ls", async (context, argv, fds) => {
  let long = false;
  let directory = false;
  const paths: string[] = [];
  for (const value of argv) {
    if (value === "-l") long = true;
    else if (value === "-d") directory = true;
    else if (value === "-a" || value === "-A") continue;
    else if (value.startsWith("-")) throw new VfsError("EINVAL", `ls: unsupported option ${value}`);
    else paths.push(value);
  }
  if (paths.length === 0) paths.push(".");
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
