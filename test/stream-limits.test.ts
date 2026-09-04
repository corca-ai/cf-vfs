import { expect, it } from "vitest";
import {
  collectBytes,
  collectRechunkedBytes,
  readUtf8,
  streamFromChunks,
} from "../src/vfs/streams.js";

it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid byte limit %s before locking the input",
  async (maximum) => {
    const stream = streamFromChunks([new Uint8Array([65])]);
    await expect(collectBytes(stream, maximum)).rejects.toMatchObject({ code: "EINVAL" });
    await expect(collectRechunkedBytes(stream, maximum, 2)).rejects.toMatchObject({
      code: "EINVAL",
    });
    await expect(readUtf8(stream, maximum)).rejects.toMatchObject({ code: "EINVAL" });
    expect(stream.locked).toBe(false);
    expect(await readUtf8(stream, 1)).toBe("A");
  },
);

it("accepts a zero-byte budget for empty input", async () => {
  expect(await collectRechunkedBytes("", 0, 1)).toEqual({ chunks: [], sizeBytes: 0 });
  expect(await collectBytes("", 0)).toEqual({ chunks: [], sizeBytes: 0 });
  expect(await readUtf8(streamFromChunks([]), 0)).toBe("");
});
