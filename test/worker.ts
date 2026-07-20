import type { CommandDefinition } from "../src/core/command.js";
import type {
  AppendTextOptions,
  MetadataUpdateOptions,
  TouchOptions,
  VfsStat,
  WriteResult,
} from "../src/core/types.js";
import { basenameCommand } from "../src/commands/basename.js";
import { catCommand } from "../src/commands/cat.js";
import { chmodCommand } from "../src/commands/chmod.js";
import { cmpCommand } from "../src/commands/cmp.js";
import { commCommand } from "../src/commands/comm.js";
import { cpCommand } from "../src/commands/cp.js";
import { cutCommand } from "../src/commands/cut.js";
import { diffCommand } from "../src/commands/diff.js";
import { dirnameCommand } from "../src/commands/dirname.js";
import { duCommand } from "../src/commands/du.js";
import { findCommand } from "../src/commands/find.js";
import { foldCommand } from "../src/commands/fold.js";
import { grepCommand } from "../src/commands/grep.js";
import { headCommand } from "../src/commands/head.js";
import { joinCommand } from "../src/commands/join.js";
import { lsCommand } from "../src/commands/ls.js";
import { mkdirCommand } from "../src/commands/mkdir.js";
import { mktempCommand } from "../src/commands/mktemp.js";
import { mvCommand } from "../src/commands/mv.js";
import { nlCommand } from "../src/commands/nl.js";
import { pasteCommand } from "../src/commands/paste.js";
import { patchCommand } from "../src/commands/patch.js";
import { pwdCommand } from "../src/commands/pwd.js";
import { realpathCommand } from "../src/commands/realpath.js";
import { rmCommand } from "../src/commands/rm.js";
import { rmdirCommand } from "../src/commands/rmdir.js";
import { sedCommand } from "../src/commands/sed.js";
import { sha256sumCommand } from "../src/commands/sha256sum.js";
import { sortCommand } from "../src/commands/sort.js";
import { statCommand } from "../src/commands/stat.js";
import { tailCommand } from "../src/commands/tail.js";
import { teeCommand } from "../src/commands/tee.js";
import { testCommand } from "../src/commands/test.js";
import { touchCommand } from "../src/commands/touch.js";
import { trCommand } from "../src/commands/tr.js";
import { treeCommand } from "../src/commands/tree.js";
import { uniqCommand } from "../src/commands/uniq.js";
import { wcCommand } from "../src/commands/wc.js";
import { writeCommand } from "../src/commands/write.js";
import { VfsDurableObject } from "../src/durable-object.js";
import { createNativeRegexEngine } from "../src/regex/native.js";
import { R2BinaryStore } from "../src/storage/r2.js";

const commands = [
  basenameCommand,
  catCommand,
  chmodCommand,
  cmpCommand,
  commCommand,
  cpCommand,
  cutCommand,
  diffCommand,
  dirnameCommand,
  duCommand,
  findCommand,
  foldCommand,
  grepCommand,
  headCommand,
  joinCommand,
  lsCommand,
  mkdirCommand,
  mktempCommand,
  mvCommand,
  nlCommand,
  pasteCommand,
  patchCommand,
  pwdCommand,
  realpathCommand,
  rmCommand,
  rmdirCommand,
  sedCommand,
  sha256sumCommand,
  sortCommand,
  statCommand,
  tailCommand,
  teeCommand,
  testCommand,
  touchCommand,
  trCommand,
  treeCommand,
  uniqCommand,
  wcCommand,
  writeCommand,
] satisfies readonly CommandDefinition[];

export class TestWorkspaceVfs extends VfsDurableObject<VfsTestEnv> {
  constructor(ctx: DurableObjectState, env: VfsTestEnv) {
    super(ctx, env, {
      commands,
      binaryStore: new R2BinaryStore(env.VFS_TEST_BUCKET),
      regexEngine: createNativeRegexEngine(),
      chunkBytes: 1024,
      maxTextFileBytes: 8 * 1024 * 1024,
    });
  }

  appendText(path: string, text: string, options?: AppendTextOptions): WriteResult {
    return this.fileSystem.appendText(path, text, options);
  }

  touchPath(path: string, options?: TouchOptions): VfsStat {
    return this.fileSystem.touch(path, options);
  }

  setPathMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    return this.fileSystem.setMetadata(path, options);
  }
}

export default {
  fetch(): Response {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<VfsTestEnv>;
