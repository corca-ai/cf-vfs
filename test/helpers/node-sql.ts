import { afterEach } from "vitest";
import { NodeSqlFileSystem, type NodeSqlFileSystemOptions } from "../../src/testing/node.js";

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
