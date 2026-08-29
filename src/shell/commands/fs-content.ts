import type { VfsStat } from "../../vfs/types.js";
import { openContent } from "../content.js";
import { type AppletSpec, appletUsageError, defineApplet } from "./applet.js";
import { CHARACTER_DEVICE_TYPE, FILE_TYPE_MASK, isRegularFile } from "./format.js";
import { commandPath, pipeToSink, writeText } from "./helpers.js";

const CAT = {
  name: "cat",
  usage: "[FILE...]",
  summary: "concatenates files, or standard input, to standard output",
} as const satisfies AppletSpec;

const FILE = {
  name: "file",
  usage: "PATH...",
  summary: "classifies a path as directory, inline data, or opaque content",
} as const satisfies AppletSpec;

export function describeKind(stat: VfsStat): string {
  if (stat.kind === "directory") return "directory";
  if (stat.kind === "symlink") return "symbolic link";
  return (stat.mode & FILE_TYPE_MASK) === CHARACTER_DEVICE_TYPE
    ? "character special file"
    : "regular file";
}

export const catCommand = /* @__PURE__ */ defineApplet(CAT, async (context, argv, fds) => {
  if (argv.length === 0) {
    await pipeToSink(context, fds[0], fds[1]);
    return 0;
  }
  for (const path of argv) {
    if (path === "-") {
      await pipeToSink(context, fds[0], fds[1]);
      continue;
    }
    const body = await openContent(context.fileSystem, commandPath(context, path), {
      reader: context.content,
      access: context.policy.opaqueContent,
      signal: context.signal,
    });
    await pipeToSink(context, body.stream, fds[1]);
  }
  return 0;
});

export const fileCommand = /* @__PURE__ */ defineApplet(FILE, async (context, argv, fds) => {
  if (argv.length === 0) throw appletUsageError(FILE, "missing operand");
  for (const path of argv) {
    const stat = context.fileSystem.lstat(commandPath(context, path));
    const description =
      stat.kind === "symlink"
        ? `symbolic link to ${stat.linkTarget}`
        : stat.kind === "file" && stat.contentClass === "opaque"
          ? "opaque R2 content"
          : stat.kind === "file" && isRegularFile(stat)
            ? "inline data"
            : describeKind(stat);
    await writeText(fds[1], `${path}: ${description}\n`);
  }
  return 0;
});
