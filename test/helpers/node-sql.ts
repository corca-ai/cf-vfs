import { afterEach } from "vitest";
import { NodeSqlFileSystem, type NodeSqlFileSystemOptions } from "../../src/testing/node.js";
import type { VirtualFileSystem } from "../../src/vfs/types.js";

const openFileSystems = new Set<NodeSqlFileSystem>();

afterEach(() => {
  for (const fileSystem of openFileSystems) fileSystem.close();
  openFileSystems.clear();
});

export function createTestFileSystem(options: NodeSqlFileSystemOptions = {}): NodeSqlFileSystem {
  const fileSystem = new NodeSqlFileSystem(options);
  openFileSystems.add(fileSystem);
  return fileSystem;
}

/** A real filesystem with only its optional POSIX-view capability withheld. */
export function withoutPosixCredentials(fileSystem: NodeSqlFileSystem): VirtualFileSystem {
  return new Proxy(fileSystem, {
    get(target, property, receiver) {
      if (property === "forCredentials") return undefined;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A real filesystem whose credential views withhold `readMany`, so reads go one call each. */
export function withoutBulkReads(fileSystem: NodeSqlFileSystem): NodeSqlFileSystem {
  const withoutReadMany = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(inner, property) {
        if (property === "readMany") return undefined;
        const value: unknown = Reflect.get(inner, property);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  return new Proxy(fileSystem, {
    get(target, property) {
      if (property === "readMany") return undefined;
      if (property === "forCredentials")
        return (...args: Parameters<NodeSqlFileSystem["forCredentials"]>) =>
          withoutReadMany(target.forCredentials(...args));
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
