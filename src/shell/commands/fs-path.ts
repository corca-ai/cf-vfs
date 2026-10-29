import { VfsError } from "../../core/errors.js";
import { normalizeFileSystemPath } from "../../core/path.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { commandPath, writeText } from "./helpers.js";

const BASENAME = {
  name: "basename",
  usage: "PATH [SUFFIX] | -a [-s SUFFIX] PATH...",
  summary: "prints the final component of a path",
  options: {
    short: { a: { name: "multiple" }, s: { name: "suffix", argument: true } },
    long: { multiple: { name: "multiple" }, suffix: { name: "suffix", argument: true } },
  },
} as const satisfies AppletSpecWithOptions<"multiple" | "suffix">;

const DIRNAME = {
  name: "dirname",
  usage: "PATH",
  summary: "prints the directory component of a path",
} as const satisfies AppletSpec;

const REALPATH = {
  name: "realpath",
  usage: "PATH...",
  summary: "prints the normalized absolute path of an existing entry",
} as const satisfies AppletSpec;

const MKTEMP = {
  name: "mktemp",
  usage: "[TEMPLATE]",
  summary: "creates a uniquely named empty file",
} as const satisfies AppletSpec;

function lexicalBasename(path: string): string {
  const withoutTrailingSlashes = path.replace(/\/+$/u, "");
  if (withoutTrailingSlashes === "") return path === "" ? "" : "/";
  return withoutTrailingSlashes.slice(withoutTrailingSlashes.lastIndexOf("/") + 1);
}

function lexicalDirname(path: string): string {
  if (path === "") return ".";
  const withoutTrailingSlashes = path.replace(/\/+$/u, "");
  if (withoutTrailingSlashes === "") return "/";
  const separator = withoutTrailingSlashes.lastIndexOf("/");
  if (separator < 0) return ".";
  const parent = withoutTrailingSlashes.slice(0, separator).replace(/\/+$/u, "");
  return parent === "" ? "/" : parent;
}

/** GNU removes a suffix only when something would remain. */
function withoutSuffix(name: string, suffix: string | undefined): string {
  return suffix !== undefined && suffix !== "" && name !== suffix && name.endsWith(suffix)
    ? name.slice(0, -suffix.length)
    : name;
}

export const basenameCommand = /* @__PURE__ */ defineApplet(
  BASENAME,
  async (_context, argv, fds) => {
    const parsed = parseAppletOptions(BASENAME, argv);
    const suffixOption = parsed.options.filter((option) => option.name === "suffix").at(-1);
    const optionSuffix =
      suffixOption !== undefined && "argument" in suffixOption ? suffixOption.argument : undefined;
    const multiple =
      optionSuffix !== undefined || parsed.options.some((option) => option.name === "multiple");
    const names = parsed.operands;
    if (names.length === 0) throw appletUsageError(BASENAME, "missing operand");
    if (!multiple && names.length > 2) throw appletUsageError(BASENAME, "extra operand");
    const suffix = multiple ? optionSuffix : names[1];
    const paths = multiple ? names : names.slice(0, 1);
    for (const path of paths) {
      await writeText(fds[1], `${withoutSuffix(lexicalBasename(path), suffix)}\n`);
    }
    return 0;
  },
);

export const dirnameCommand = /* @__PURE__ */ defineApplet(DIRNAME, async (_context, argv, fds) => {
  if (argv.length !== 1) throw appletUsageError(DIRNAME, "requires one path");
  await writeText(fds[1], `${lexicalDirname(argv[0] ?? "")}\n`);
  return 0;
});

export const realpathCommand = /* @__PURE__ */ defineApplet(
  REALPATH,
  async (context, argv, fds) => {
    if (argv.length === 0) throw appletUsageError(REALPATH, "missing operand");
    for (const path of argv) {
      const normalized = normalizeFileSystemPath(path, context.session.cwd);
      const canonical = context.fileSystem.realpath(normalized);
      context.fileSystem.stat(canonical);
      await writeText(fds[1], `${canonical}\n`);
    }
    return 0;
  },
);

export const mktempCommand = /* @__PURE__ */ defineApplet(MKTEMP, async (context, argv, fds) => {
  if (argv.length > 1) throw appletUsageError(MKTEMP, "accepts at most one template");
  const template = argv[0] ?? "tmp.XXXXXX";
  if (template.startsWith("-")) throw appletUsageError(MKTEMP, `unsupported option ${template}`);
  if (!template.includes("XXXXXX")) throw appletUsageError(MKTEMP, "template must contain XXXXXX");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
    const path = commandPath(context, template.replace("XXXXXX", suffix));
    try {
      await context.fileSystem.writeFile(path, new Uint8Array(), { disposition: "create" });
      await writeText(fds[1], `${path}\n`);
      return 0;
    } catch (error) {
      if (!(error instanceof VfsError && error.code === "EEXIST")) throw error;
    }
  }
  throw new VfsError("EEXIST", "mktemp: could not create a unique file");
});
