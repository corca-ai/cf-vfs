import { VfsError } from "../core/errors.js";
import { SqlFileSystem, type SqlFileSystemOptions } from "./sql.js";

// Cloudflare caps a BLOB or complete table row at 2 MB. Leave ample room for
// the composite primary-key columns and SQLite record encoding.
const MAX_SQLITE_INLINE_CHUNK_BYTES = 1024 * 1024;

export type DurableObjectFileSystemOptions = SqlFileSystemOptions;

export class DurableObjectFileSystem extends SqlFileSystem {
  constructor(storage: DurableObjectStorage, options: DurableObjectFileSystemOptions = {}) {
    if (options.chunkBytes !== undefined && options.chunkBytes > MAX_SQLITE_INLINE_CHUNK_BYTES) {
      throw new VfsError(
        "EINVAL",
        `chunkBytes cannot exceed ${MAX_SQLITE_INLINE_CHUNK_BYTES} for SQLite storage`,
      );
    }
    super(storage, options);
  }
}
