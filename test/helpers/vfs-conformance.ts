import { BATCH_CONFORMANCE } from "./vfs-conformance-batches.js";
import { CORE_CONFORMANCE } from "./vfs-conformance-core.js";
import { MUTATION_CONFORMANCE } from "./vfs-conformance-mutations.js";
import type {
  VfsConformanceCase,
  VfsConformanceOptions,
  VfsFactory,
} from "./vfs-conformance-support.js";

export type { VfsFactory } from "./vfs-conformance-support.js";
export { streamThatFailsAfter } from "./vfs-conformance-support.js";

const CONFORMANCE_CASES: readonly VfsConformanceCase[] = [
  ...CORE_CONFORMANCE,
  ...MUTATION_CONFORMANCE,
  ...BATCH_CONFORMANCE,
];

/** Registers the same behavioral contract against any local or RPC-backed VFS. */
export function runVfsConformance(factory: VfsFactory, options: VfsConformanceOptions = {}): void {
  for (const register of CONFORMANCE_CASES) register(factory, options);
}
