import { DurableObject } from "cloudflare:workers";
import type { CommandDefinition, ExecuteRequest, ExecuteResult } from "./core/command.js";
import { CommandExecutor } from "./core/executor.js";
import type {
  BinaryRange,
  BinaryReadResult,
  BinaryStreamReadResult,
  BinaryWriteResult,
  BinaryWriteOptions,
  EntryPage,
  FindPageOptions,
  PageOptions,
} from "./core/types.js";
import {
  DurableObjectFileSystem,
  type DurableObjectFileSystemOptions,
} from "./storage/do-sql.js";

export interface VfsDurableObjectOptions extends DurableObjectFileSystemOptions {
  commands: readonly CommandDefinition[];
}

export abstract class VfsDurableObject<Environment> extends DurableObject<Environment> {
  protected readonly fileSystem: DurableObjectFileSystem;
  private readonly executor: CommandExecutor;

  protected constructor(
    ctx: DurableObjectState,
    env: Environment,
    options: VfsDurableObjectOptions,
  ) {
    super(ctx, env);
    this.fileSystem = new DurableObjectFileSystem(ctx.storage, options);
    this.executor = new CommandExecutor(this.fileSystem, options.commands);
  }

  execute(request: ExecuteRequest): Promise<ExecuteResult> {
    return this.executor.execute(request);
  }

  putBinary(
    path: string,
    bytes: ArrayBuffer,
    options?: BinaryWriteOptions,
  ): Promise<BinaryWriteResult> {
    return this.fileSystem.writeBinary(path, bytes, options);
  }

  readBinary(path: string, range?: BinaryRange): Promise<BinaryReadResult> {
    return this.fileSystem.readBinary(path, range);
  }

  readBinaryStream(path: string, range?: BinaryRange): Promise<BinaryStreamReadResult> {
    return this.fileSystem.readBinaryStream(path, range);
  }

  listPage(path: string, options?: PageOptions): EntryPage {
    return this.fileSystem.listPage(path, options);
  }

  findPage(options: FindPageOptions): EntryPage {
    return this.fileSystem.findPage(options);
  }

  drainBinaryGarbage(limit?: number): Promise<{ deleted: number; remaining: number }> {
    return this.fileSystem.drainBinaryGarbage(limit);
  }
}
