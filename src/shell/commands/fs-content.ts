import type { VfsStat } from "../../vfs/types.js";
import { openContent } from "../content.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { CHARACTER_DEVICE_TYPE, FILE_TYPE_MASK, isRegularFile } from "./format.js";
import { type CatFormat, CatFormatter, formatToSink } from "./fs-cat-format.js";
import { commandPath, pipeToSink, writeText } from "./helpers.js";

const CAT = {
  name: "cat",
  usage: "[-AbeEnstTuv] [FILE...]",
  summary: "concatenates files, or standard input, to standard output",
  options: {
    short: {
      A: { name: "show-all" },
      b: { name: "number-nonblank" },
      e: { name: "e" },
      E: { name: "show-ends" },
      n: { name: "number" },
      s: { name: "squeeze-blank" },
      t: { name: "t" },
      T: { name: "show-tabs" },
      u: { name: "unbuffered" },
      v: { name: "show-nonprinting" },
    },
    long: {
      "show-all": { name: "show-all" },
      "number-nonblank": { name: "number-nonblank" },
      "show-ends": { name: "show-ends" },
      number: { name: "number" },
      "squeeze-blank": { name: "squeeze-blank" },
      "show-tabs": { name: "show-tabs" },
      "show-nonprinting": { name: "show-nonprinting" },
    },
  },
} as const satisfies AppletSpecWithOptions<
  | "show-all"
  | "number-nonblank"
  | "e"
  | "show-ends"
  | "number"
  | "squeeze-blank"
  | "t"
  | "show-tabs"
  | "unbuffered"
  | "show-nonprinting"
>;

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

function catFormat(argv: readonly string[]): { format: CatFormat | undefined; paths: string[] } {
  const parsed = parseAppletOptions(CAT, argv);
  const has = (...names: string[]): boolean =>
    parsed.options.some((option) => names.includes(option.name));
  const format: CatFormat = {
    number: has("number"),
    numberNonBlank: has("number-nonblank"),
    squeeze: has("squeeze-blank"),
    showEnds: has("show-ends", "show-all", "e"),
    showTabs: has("show-tabs", "show-all", "t"),
    showNonPrinting: has("show-nonprinting", "show-all", "e", "t"),
  };
  const formatting = Object.values(format).some(Boolean);
  return { format: formatting ? format : undefined, paths: [...parsed.operands] };
}

/** Without a display option the bytes pass through untouched, as one stream. */
export const catCommand = /* @__PURE__ */ defineApplet(CAT, async (context, argv, fds) => {
  const { format, paths } = catFormat(argv);
  const formatter = format === undefined ? undefined : new CatFormatter(format);
  const copy = (stream: ReadableStream<Uint8Array>): Promise<void> =>
    formatter === undefined
      ? pipeToSink(context, stream, fds[1])
      : formatToSink(context, stream, fds[1], formatter);
  for (const path of paths.length === 0 ? ["-"] : paths) {
    if (path === "-") {
      await copy(fds[0]);
      continue;
    }
    const body = await openContent(context.fileSystem, commandPath(context, path), {
      reader: context.content,
      access: context.policy.opaqueContent,
      signal: context.signal,
    });
    await copy(body.stream);
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
