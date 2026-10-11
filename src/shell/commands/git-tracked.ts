import { VfsError } from "../../core/errors.js";
import type { VirtualFileSystem } from "../../vfs/types.js";
import { hasFileSystemOrigin } from "../fs-origin.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
import { defineApplet } from "./applet.js";
import { gitCommand } from "./git.js";
import { GitFileSystem } from "./git-fs.js";
import { localGitPath } from "./git-options.js";
import type { GitRepository } from "./git-repository.js";
import { gitRepository } from "./git-repository.js";
import { gitMatrix } from "./git-status.js";
import { writeText } from "./helpers.js";

interface Checkpoint {
  cursor: number;
  indexToken: string;
  policy: ShellCommandContext["policy"];
  limits: ShellCommandContext["budget"]["limits"];
  credentials: string;
}

/**
 * Opt-in incremental whole-worktree staging. The host must supply the same
 * trusted, recordChanges-enabled VFS given to Shell and serialize repository
 * commands with edits, as for ordinary Git. A restart or uncertain change
 * selects the ordinary complete walk. The feed never reaches command context.
 */
export function createTrackedGitCommand(fileSystem: VirtualFileSystem) {
  const tracking = new TrackedAdd(fileSystem);
  return defineApplet(gitCommand.spec, async (context, argv, fds) => {
    try {
      return await runTracked(tracking, context, argv, fds);
    } catch (error) {
      if (error instanceof VfsError) throw error;
      await writeText(fds[2], `git: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  });
}

async function runTracked(
  tracking: TrackedAdd,
  context: ShellCommandContext,
  argv: readonly string[],
  fds: ShellFileDescriptors,
) {
  const invocation = trackedInvocation(context, argv);
  if (invocation === undefined)
    return (await gitCommand.run(context, argv, fds).completed).exitCode;
  const { repo, prefix, operation } = invocation;
  const inspection = operation === "add" ? tracking.begin(repo) : undefined;
  const paths = await changedOperands(repo, inspection?.paths);
  const selected =
    paths === undefined ? argv : [...prefix, "add", "--", ...paths.map((path) => `./${path}`)];
  const result =
    paths?.length === 0 ? 0 : (await gitCommand.run(context, selected, fds).completed).exitCode;
  if (result === 0) {
    inspection?.complete();
    if (operation === "commit") tracking.committed(repo);
  }
  return result;
}

/** Recognize only complete root staging; everything else keeps the ordinary command path. */
function trackedInvocation(context: ShellCommandContext, argv: readonly string[]) {
  let index = 0;
  let cwd = context.session.cwd;
  while (argv[index] === "-C") {
    const operand = argv[index + 1];
    if (operand === undefined) return undefined;
    cwd = localGitPath(operand, cwd);
    if (context.fileSystem.stat(cwd).kind !== "directory")
      throw new VfsError("ENOTDIR", "git: not a directory", cwd);
    index += 2;
  }
  const operation = argv[index];
  const args = argv.slice(index + 1);
  const wholeAdd = operation === "add" && isWholeAdd(args);
  if (!wholeAdd && operation !== "commit") return undefined;
  const scoped = { ...context, session: { ...context.session, cwd } };
  const repo = gitRepository(new GitFileSystem(scoped), cwd);
  if (repo.dir === repo.gitdir || context.fileSystem.realpath(cwd) !== repo.dir) return undefined;
  return { repo, prefix: argv.slice(0, index), operation };
}

function isWholeAdd(args: readonly string[]): boolean {
  if (args.length === 1) return [".", "-A", "--all"].includes(args[0] ?? "");
  return args.length === 2 && ["-A", "--all"].includes(args[0] ?? "") && args[1] === ".";
}

async function changedOperands(repo: GitRepository, paths: readonly string[] | undefined) {
  if (paths === undefined || paths.length === 0) return paths;
  // Explicit git add operands error for ignored untracked paths, whereas a
  // whole-tree add silently skips them. Keep the ordinary matrix semantics
  // before delegating the selected operands to the unchanged command.
  const rows = await gitMatrix(repo, paths, new Map());
  return rows.filter(([, , work, stage]) => work !== stage).map(([path]) => path);
}

interface AddInspection {
  paths: readonly string[] | undefined;
  complete(): void;
}

class TrackedAdd {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private generation = 0;

  constructor(private readonly fileSystem: VirtualFileSystem) {}

  private readChanges(
    cursor: number,
    context: ShellCommandContext,
    keep: (path: string) => boolean = () => true,
  ) {
    const paths = new Set<string>();
    for (;;) {
      context.budget.step();
      const page = this.fileSystem.changesSince(cursor, { limit: 1000 });
      for (const change of page.changes) {
        // 129 paths already force a full walk. Still drain the feed so the
        // cursor is complete, without retaining an entire workspace history.
        if (paths.size <= 128 && keep(change.path)) paths.add(change.path);
      }
      cursor = page.cursor;
      if (!page.more) return { paths, cursor };
    }
  }

  begin(repo: GitRepository): AddInspection {
    const context = repo.fs.context;
    const generation = ++this.generation;
    const previous = this.checkpoints.get(repo.dir);
    this.checkpoints.delete(repo.dir);
    const fallback = { paths: undefined, complete() {} };
    if (
      repo.dir === "/" ||
      !hasFileSystemOrigin(context.fileSystem, this.fileSystem) ||
      context.fileSystem.canUseBulkOperation?.("copy-source", repo.dir) !== true
    )
      return fallback;
    let before: ReturnType<TrackedAdd["readChanges"]>;
    try {
      before = this.readChanges(previous?.cursor ?? 0, context);
    } catch (error) {
      if (error instanceof VfsError && ["EPERM", "ENOTSUP"].includes(error.code)) return fallback;
      throw error;
    }
    const boundary = before;
    const credentials = JSON.stringify(context.session.credentials ?? null);
    let paths: readonly string[] | undefined;
    if (
      previous !== undefined &&
      previous.policy === context.policy &&
      previous.limits === context.budget.limits &&
      previous.credentials === credentials &&
      previous.indexToken === this.indexToken(repo)
    )
      paths = this.changedFiles(repo, before.paths);
    return {
      paths,
      complete: () => {
        if (generation !== this.generation) return;
        // A metadata symlink can depend on any ordinary file in this tree,
        // including a differently named ignore/config file. Establish reuse
        // only for symlink-free trees; any later link creation forces a full
        // add and repeats this check. Use the trusted owner only for this
        // eligibility fact, never for the actual Git reads or writes.
        if (paths === undefined) {
          context.budget.step();
          if (this.fileSystem.find({ path: repo.dir, type: "symlink", limit: 1 }).length !== 0)
            return;
        }
        // Ignore our own staging writes, but never acknowledge an interleaved
        // worktree or external dependency edit.
        const after = this.readChanges(
          boundary.cursor,
          context,
          (path) => path !== repo.gitdir && !path.startsWith(`${repo.gitdir}/`),
        );
        if (after.paths.size !== 0) return;
        const indexToken = this.indexToken(repo);
        if (indexToken === undefined) return;
        if (this.checkpoints.size >= 32) this.checkpoints.clear();
        this.checkpoints.set(repo.dir, {
          cursor: after.cursor,
          indexToken,
          policy: context.policy,
          limits: context.budget.limits,
          credentials,
        });
      },
    };
  }

  committed(repo: GitRepository): void {
    if (!hasFileSystemOrigin(repo.fs.context.fileSystem, this.fileSystem)) return;
    const checkpoint = this.checkpoints.get(repo.dir);
    this.checkpoints.delete(repo.dir);
    if (checkpoint === undefined || checkpoint.indexToken !== this.indexToken(repo)) return;
    // Our commit writes objects and refs from the unchanged staged index. An
    // intervening worktree/config/ignore edit cannot be acknowledged this way.
    const allowed = (path: string) =>
      path === repo.gitdir ||
      path === `${repo.gitdir}/HEAD` ||
      path === `${repo.gitdir}/objects` ||
      path.startsWith(`${repo.gitdir}/objects/`) ||
      path === `${repo.gitdir}/refs` ||
      path.startsWith(`${repo.gitdir}/refs/`);
    const changes = this.readChanges(checkpoint.cursor, repo.fs.context, (path) => !allowed(path));
    if (changes.paths.size !== 0) return;
    this.checkpoints.set(repo.dir, { ...checkpoint, cursor: changes.cursor });
  }

  private indexToken(repo: GitRepository): string | undefined {
    try {
      return repo.fs.context.fileSystem.getMutationToken(`${repo.gitdir}/index`);
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private isRegularFile(repo: GitRepository, path: string): boolean {
    try {
      return repo.fs.context.fileSystem.lstat(path).kind === "file";
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private changedFiles(repo: GitRepository, changes: ReadonlySet<string>): string[] | undefined {
    if (changes.size > 128) return undefined;
    const paths: string[] = [];
    for (const path of changes) {
      if (isAncestor(path, repo.dir)) return undefined;
      // External paths may back symlinked Git config or ignore files.
      if (!path.startsWith(`${repo.dir}/`)) return undefined;
      if (
        path === repo.gitdir ||
        path.startsWith(`${repo.gitdir}/`) ||
        path.endsWith("/.gitignore")
      )
        return undefined;
      if (!this.isRegularFile(repo, path)) return undefined;
      paths.push(path.slice(repo.dir.length + 1));
    }
    return paths;
  }
}

function isAncestor(path: string, directory: string): boolean {
  return path === directory || directory.startsWith(path === "/" ? "/" : `${path}/`);
}
