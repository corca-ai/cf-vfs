import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { PublicBenchmarkSuite } from "./benchmark-suite.js";

/** Identical fixture construction for the frozen reference and current code. */
export async function createBenchmarkFixture(storage: DurableObjectStorage) {
  let suite: PublicBenchmarkSuite | undefined;
  const fs = new DurableObjectFileSystem(storage, {
    workspaceId: "benchmark-fixture",
    maxEntries: 20_000,
    maxInlineLogicalBytes: 32 * 1024 * 1024,
    maxInFlightBufferedBytes: 16 * 1024 * 1024,
    onEvent: (event) => suite?.onEvent(event),
  });
  await fs.initialize();
  suite = new PublicBenchmarkSuite(fs, 1700000000000);
  return suite;
}
