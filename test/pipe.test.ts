import { expect, it } from "vitest";
import { createBytePipe } from "../src/shell/pipe.js";
import { PIPE_CASES } from "./helpers/pipe-cases.js";

for (const [name, run] of Object.entries(PIPE_CASES)) it(name, run);

// workerd leaves an aborted pipeTo with preventCancel pending, old pipe or new.
it("loses nothing when a pipeTo is stopped before a reader takes over", async () => {
  const { readable, sink } = createBytePipe({
    maximumBytes: 1024,
    signal: new AbortController().signal,
    name: "p",
  });
  const stop = new AbortController();
  const piped = readable.pipeTo(new WritableStream(), { signal: stop.signal, preventCancel: true });
  stop.abort(new Error("stop"));
  await expect(piped).rejects.toThrow("stop");
  const reader = readable.getReader();
  await sink.write(Uint8Array.of(3));
  await sink.write(Uint8Array.of(4));
  await sink.close();
  expect(await reader.read()).toEqual({ done: false, value: Uint8Array.of(3) });
  expect(await reader.read()).toEqual({ done: false, value: Uint8Array.of(4) });
  expect((await reader.read()).done).toBe(true);
});
