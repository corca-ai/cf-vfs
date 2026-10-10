import { VfsError } from "../src/core/errors.js";

/** One room-wide queue also covers clone's source and destination and path aliases. */
export class WorkspaceOperations {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private readonly capacity = 64) {}

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.pending >= this.capacity)
      return Promise.reject(new VfsError("EAGAIN", "Workspace is busy; retry shortly"));
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );
    return result;
  }
}
