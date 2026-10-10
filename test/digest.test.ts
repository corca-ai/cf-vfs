import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/vfs/digest.js";

describe("SHA-256 input boundaries", () => {
  const bytes = new Uint8Array([99, 1, 2, 3, 4, 99]);
  it.each([
    {
      name: "contiguous subviews with an outside prefix and suffix",
      chunks: [bytes.subarray(1, 3), bytes.subarray(3, 5)],
      expected: [1, 2, 3, 4],
    },
    {
      name: "gaps in one backing buffer",
      chunks: [bytes.subarray(1, 2), bytes.subarray(4, 5)],
      expected: [1, 4],
    },
    {
      name: "reordered views",
      chunks: [bytes.subarray(3, 5), bytes.subarray(1, 3)],
      expected: [3, 4, 1, 2],
    },
    {
      name: "separate buffers",
      chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
      expected: [1, 2, 3, 4],
    },
    { name: "an empty body", chunks: [], expected: [] },
  ])("hashes $name as the concatenated byte sequence", async ({ chunks, expected }) => {
    const digest = createHash("sha256").update(new Uint8Array(expected)).digest("hex");
    await expect(sha256Hex(chunks, expected.length)).resolves.toBe(digest);
  });

  it("copies a SharedArrayBuffer view before crossing the Web Crypto boundary", async () => {
    const buffer = new SharedArrayBuffer(4);
    const bytes = new Uint8Array(buffer);
    bytes.set([1, 2, 3, 4]);

    await expect(sha256Hex([new Uint8Array(buffer, 1, 2)], 2)).resolves.toBe(
      "ee9040f65c341855e070ff438eb0ea9d5b831b2a2c270fb7ef592d750408e3b3",
    );
  });
});
