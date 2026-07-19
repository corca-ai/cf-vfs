import type { CommandDefinition } from "../src/core/command.js";
import { catCommand } from "../src/commands/cat.js";
import { cpCommand } from "../src/commands/cp.js";
import { findCommand } from "../src/commands/find.js";
import { grepCommand } from "../src/commands/grep.js";
import { headCommand } from "../src/commands/head.js";
import { lsCommand } from "../src/commands/ls.js";
import { mkdirCommand } from "../src/commands/mkdir.js";
import { mvCommand } from "../src/commands/mv.js";
import { rmCommand } from "../src/commands/rm.js";
import { sedCommand } from "../src/commands/sed.js";
import { statCommand } from "../src/commands/stat.js";
import { tailCommand } from "../src/commands/tail.js";
import { wcCommand } from "../src/commands/wc.js";
import { writeCommand } from "../src/commands/write.js";
import { VfsDurableObject } from "../src/durable-object.js";
import { createNativeRegexEngine } from "../src/regex/native.js";
import { R2BinaryStore } from "../src/storage/r2.js";

const commands = [
  catCommand,
  cpCommand,
  findCommand,
  grepCommand,
  headCommand,
  lsCommand,
  mkdirCommand,
  mvCommand,
  rmCommand,
  sedCommand,
  statCommand,
  tailCommand,
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
}

export default {
  fetch(): Response {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<VfsTestEnv>;
