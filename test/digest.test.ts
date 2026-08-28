import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/vfs/digest.js";

describe("SHA-256 input boundaries", () => {
  it("copies a SharedArrayBuffer view before crossing the Web Crypto boundary", async () => {
    const buffer = new SharedArrayBuffer(4);
    const bytes = new Uint8Array(buffer);
    bytes.set([1, 2, 3, 4]);

    await expect(sha256Hex([new Uint8Array(buffer, 1, 2)], 2)).resolves.toBe(
      "ee9040f65c341855e070ff438eb0ea9d5b831b2a2c270fb7ef592d750408e3b3",
    );
  });
});
