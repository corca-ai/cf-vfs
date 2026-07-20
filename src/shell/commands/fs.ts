import { VfsError } from "../../core/errors.js";
import { basename, dirname, normalizePath } from "../../core/path.js";
import type { VfsStat } from "../../vfs/types.js";
import { BufferedTextWriter, defineCommand, commandPath, pipeToSink, writeText } from "./helpers.js";

function modeString(mode: number): string {
  const kind = (mode & 0o040000) !== 0 ? "d" : "-";
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const labels = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  return kind + bits.map((bit, index) => (mode & bit) !== 0 ? labels[index] : "-").join("");
}

export const catCommand = /* @__PURE__ */ defineCommand("cat", async (context, argv, fds) => {
  if (argv.length === 0) {
    await pipeToSink(context, fds[0], fds[1]);
    return 0;
  }
  for (const path of argv) {
    if (path === "-") await pipeToSink(context, fds[0], fds[1]);
    else await pipeToSink(context, (await context.fileSystem.readFile(commandPath(context, path))).stream, fds[1]);
  }
  return 0;
});

export const mkdirCommand = /* @__PURE__ */ defineCommand("mkdir", async (context, argv) => {
  let recursive = false;
  let mode: number | undefined;
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (value === "-p" || value === "--parents") recursive = true;
    else if (value === "-m" || value === "--mode") {
      const next = argv[++index];
      if (next === undefined || !/^[0-7]{3,4}$/u.test(next)) {
        throw new VfsError("EINVAL", "mkdir: mode must be octal");
      }
      mode = 0o040000 | Number.parseInt(next, 8);
    } else if (value.startsWith("-")) throw new VfsError("EINVAL", `mkdir: unsupported option ${value}`);
    else paths.push(value);
  }
  if (paths.length === 0) throw new VfsError("EINVAL", "mkdir: missing operand");
  for (const path of paths) await context.fileSystem.mkdir(commandPath(context, path), recursive, mode);
  return 0;
});

export const touchCommand = /* @__PURE__ */ defineCommand("touch", async (context, argv) => {
  let create = true;
  const paths: string[] = [];
  for (const value of argv) {
    if (value === "-c" || value === "--no-create") create = false;
    else if (value.startsWith("-")) throw new VfsError("EINVAL", `touch: unsupported option ${value}`);
    else paths.push(value);
  }
  if (paths.length === 0) throw new VfsError("EINVAL", "touch: missing operand");
  for (const path of paths) await context.fileSystem.touch(commandPath(context, path), { create });
  return 0;
});

export const rmCommand = /* @__PURE__ */ defineCommand("rm", async (context, argv) => {
  let recursive = false;
  let force = false;
  const paths: string[] = [];
  for (const value of argv) {
    if (value === "-r" || value === "-R" || value === "--recursive") recursive = true;
    else if (value === "-f" || value === "--force") force = true;
    else if (value.startsWith("-") && value !== "-") throw new VfsError("EINVAL", `rm: unsupported option ${value}`);
    else paths.push(value);
  }
  if (paths.length === 0 && !force) throw new VfsError("EINVAL", "rm: missing operand");
  for (const path of paths) {
    try {
      await context.fileSystem.remove(commandPath(context, path), { recursive });
    } catch (error) {
      if (!(force && error instanceof VfsError && error.code === "ENOENT")) throw error;
    }
  }
  return 0;
});

export const rmdirCommand = /* @__PURE__ */ defineCommand("rmdir", async (context, argv) => {
  if (argv.length === 0) throw new VfsError("EINVAL", "rmdir: missing operand");
  for (const path of argv) {
    const normalized = commandPath(context, path);
    const stat = await context.fileSystem.stat(normalized);
    if (stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", normalized);
    await context.fileSystem.remove(normalized);
  }
  return 0;
});

async function destinationPath(
  context: Parameters<typeof commandPath>[0],
  source: string,
  targetValue: string,
): Promise<string> {
  const target = commandPath(context, targetValue);
  const stat = await context.fileSystem.inspectWriteTarget(target);
  if (stat === null) return target;
  return stat.kind === "directory" ? `${target === "/" ? "" : target}/${basename(source)}` : target;
}

export const mvCommand = /* @__PURE__ */ defineCommand("mv", async (context, argv) => {
  let replace = false;
  const values: string[] = [];
  for (const value of argv) {
    if (value === "-f" || value === "--force") replace = true;
    else if (value.startsWith("-")) throw new VfsError("EINVAL", `mv: unsupported option ${value}`);
    else values.push(value);
  }
  if (values.length !== 2) throw new VfsError("EINVAL", "mv: requires source and destination");
  const source = commandPath(context, values[0]);
  const target = await destinationPath(context, source, values[1] ?? "");
  await context.fileSystem.move(source, target, { replace });
  return 0;
});

export const cpCommand = /* @__PURE__ */ defineCommand("cp", async (context, argv) => {
  let replace = false;
  let recursive = false;
  const values: string[] = [];
  for (const value of argv) {
    if (value === "-f" || value === "--force") replace = true;
    else if (value === "-r" || value === "-R" || value === "--recursive") recursive = true;
    else if (value.startsWith("-")) throw new VfsError("EINVAL", `cp: unsupported option ${value}`);
    else values.push(value);
  }
  if (values.length !== 2) throw new VfsError("EINVAL", "cp: requires source and destination");
  const source = commandPath(context, values[0]);
  const target = await destinationPath(context, source, values[1] ?? "");
  await context.fileSystem.copy(source, target, { replace, recursive });
  return 0;
});

export const findCommand = /* @__PURE__ */ defineCommand("find", async (context, argv, fds) => {
  const roots: string[] = [];
  let name: string | undefined;
  let type: "file" | "directory" | undefined;
  let maxDepth: number | undefined;
  let index = 0;
  while (index < argv.length && !(argv[index] ?? "").startsWith("-")) roots.push(argv[index++] ?? ".");
  if (roots.length === 0) roots.push(".");
  while (index < argv.length) {
    const option = argv[index++];
    if (option === "-name") {
      name = argv[index++];
      if (name === undefined) throw new VfsError("EINVAL", "find: -name requires a pattern");
    } else if (option === "-type") {
      const value = argv[index++];
      if (value === "f") type = "file";
      else if (value === "d") type = "directory";
      else throw new VfsError("EINVAL", "find: -type must be f or d");
    } else if (option === "-maxdepth") {
      const value = argv[index++];
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw new VfsError("EINVAL", "find: -maxdepth requires a non-negative integer");
      }
      maxDepth = Number(value);
    } else if (option === "-print") continue;
    else throw new VfsError("EINVAL", `find: unsupported expression ${option ?? ""}`);
  }
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for (const root of roots) {
      const normalized = commandPath(context, root);
      const entries = await context.fileSystem.find({
        path: normalized,
        includeRoot: true,
        ...(name === undefined ? {} : { name }),
        ...(type === undefined ? {} : { type }),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        limit: context.budget.limits.maxGlobMatches,
      });
      for (const entry of entries) await output.write(`${entry.path}\n`);
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

function statText(stat: VfsStat): string {
  return [
    `  File: ${stat.path}`,
    `  Size: ${stat.sizeBytes}`,
    `  Type: ${stat.kind === "directory" ? "directory" : `${stat.contentClass} file`}`,
    `  Mode: ${stat.mode.toString(8)} (${modeString(stat.mode)})`,
    `Revision: ${stat.revision}`,
    `Mutation: ${stat.mutationToken}`,
  ].join("\n") + "\n";
}

export const statCommand = /* @__PURE__ */ defineCommand("stat", async (context, argv, fds) => {
  if (argv.length === 0) throw new VfsError("EINVAL", "stat: missing operand");
  for (const path of argv) await writeText(fds[1], statText(await context.fileSystem.stat(commandPath(context, path))));
  return 0;
});

export const chmodCommand = /* @__PURE__ */ defineCommand("chmod", async (context, argv) => {
  const [modeValue, ...paths] = argv;
  if (modeValue === undefined || paths.length === 0 || !/^[0-7]{3,4}$/u.test(modeValue)) {
    throw new VfsError("EINVAL", "chmod: requires an octal mode and paths");
  }
  const permission = Number.parseInt(modeValue, 8);
  for (const path of paths) {
    const normalized = commandPath(context, path);
    const stat = await context.fileSystem.stat(normalized);
    await context.fileSystem.setMetadata(normalized, {
      mode: (stat.kind === "directory" ? 0o040000 : 0o100000) | permission,
    });
  }
  return 0;
});

export const duCommand = /* @__PURE__ */ defineCommand("du", async (context, argv, fds) => {
  const paths = argv.length === 0 ? ["."] : [...argv];
  for (const path of paths) {
    const normalized = commandPath(context, path);
    const entries = await context.fileSystem.find({ path: normalized, includeRoot: true });
    const size = entries.reduce((total, stat) => total + (stat.kind === "file" ? stat.sizeBytes : 0), 0);
    await writeText(fds[1], `${Math.ceil(size / 1024)}\t${path}\n`);
  }
  return 0;
});

export const treeCommand = /* @__PURE__ */ defineCommand("tree", async (context, argv, fds) => {
  const rootValue = argv[0] ?? ".";
  const root = commandPath(context, rootValue);
  const entries = await context.fileSystem.find({ path: root, includeRoot: true });
  const output = new BufferedTextWriter(context, fds[1]);
  try {
    for (const entry of entries) {
      const relative = entry.path === root ? "." : entry.path.slice(root === "/" ? 1 : root.length + 1);
      const depth = relative === "." ? 0 : relative.split("/").length;
      await output.write(`${"  ".repeat(Math.max(0, depth - 1))}${entry.name}\n`);
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return 0;
});

export const basenameCommand = /* @__PURE__ */ defineCommand("basename", async (_context, argv, fds) => {
  if (argv.length !== 1) throw new VfsError("EINVAL", "basename: requires one path");
  await writeText(fds[1], `${basename(argv[0] ?? "")}\n`);
  return 0;
});

export const dirnameCommand = /* @__PURE__ */ defineCommand("dirname", async (_context, argv, fds) => {
  if (argv.length !== 1) throw new VfsError("EINVAL", "dirname: requires one path");
  await writeText(fds[1], `${dirname(argv[0] ?? "")}\n`);
  return 0;
});

export const realpathCommand = /* @__PURE__ */ defineCommand("realpath", async (context, argv, fds) => {
  if (argv.length === 0) throw new VfsError("EINVAL", "realpath: missing operand");
  for (const path of argv) {
    const normalized = normalizePath(path, context.session.cwd);
    await context.fileSystem.stat(normalized);
    await writeText(fds[1], `${normalized}\n`);
  }
  return 0;
});

export const mktempCommand = /* @__PURE__ */ defineCommand("mktemp", async (context, argv, fds) => {
  const template = argv.at(-1)?.startsWith("-") === false ? argv.at(-1) ?? "tmp.XXXXXX" : "tmp.XXXXXX";
  if (!template.includes("XXXXXX")) throw new VfsError("EINVAL", "mktemp: template must contain XXXXXX");
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

export const fileCommand = /* @__PURE__ */ defineCommand("file", async (context, argv, fds) => {
  if (argv.length === 0) throw new VfsError("EINVAL", "file: missing operand");
  for (const path of argv) {
    const stat = await context.fileSystem.stat(commandPath(context, path));
    const description = stat.kind === "directory"
      ? "directory"
      : stat.contentClass === "opaque" ? "opaque R2 content" : "inline data";
    await writeText(fds[1], `${path}: ${description}\n`);
  }
  return 0;
});
