import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, parseClientMessage } from "../demo/protocol.js";

/**
 * The demo's wire protocol reads untrusted browser input.
 *
 * Tested here rather than through a Durable Object because the rules worth
 * getting wrong are all in the parsing, and a message that is accepted with a
 * malformed offset travels back out as one the client splices into a line.
 */
describe("demo protocol", () => {
  it("accepts the messages it declares", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" });
    expect(parseClientMessage(JSON.stringify({ type: "line", line: "ls" }))).toEqual({
      type: "line",
      line: "ls",
    });
    expect(parseClientMessage(JSON.stringify({ type: "signal", signal: "SIGINT" }))).toEqual({
      type: "signal",
      signal: "SIGINT",
    });
    expect(
      parseClientMessage(JSON.stringify({ type: "complete", line: "cat r", cursor: 5, token: 3 })),
    ).toEqual({ type: "complete", line: "cat r", cursor: 5, token: 3 });
    expect(parseClientMessage(JSON.stringify({ type: "resize", columns: 120, rows: 40 }))).toEqual({
      type: "resize",
      columns: 120,
      rows: 40,
    });
  });

  it("refuses a cursor that is not an offset into the line", () => {
    // `NaN` is the one that matters: it survives arithmetic, serializes as
    // `null`, and the client would splice a reply at `null` offsets.
    for (const cursor of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -1, 6, "3", null]) {
      const message = JSON.stringify({ type: "complete", line: "cat r", cursor, token: 1 });
      expect(() => parseClientMessage(message), String(cursor)).toThrowError(
        /offset into the line/u,
      );
    }
    // The boundary is inclusive: a cursor at the end of the line is where a
    // user actually presses Tab.
    expect(
      parseClientMessage(JSON.stringify({ type: "complete", line: "cat", cursor: 3, token: 0 })),
    ).toMatchObject({ cursor: 3 });
  });

  it("refuses a token or dimensions that are not whole numbers", () => {
    expect(() =>
      parseClientMessage(JSON.stringify({ type: "complete", line: "", cursor: 0, token: 1.5 })),
    ).toThrowError(/offset into the line/u);
    for (const columns of [Number.NaN, 1.5, "80", null]) {
      const message = JSON.stringify({ type: "resize", columns, rows: 24 });
      expect(() => parseClientMessage(message), String(columns)).toThrowError(/whole numbers/u);
    }
  });

  it("refuses what is not a message at all", () => {
    for (const raw of ["", "not json", "[]", "null", '"text"', "{}"]) {
      expect(() => parseClientMessage(raw), raw).toThrowError();
    }
    expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrowError(/unsupported/u);
    expect(() => parseClientMessage(JSON.stringify({ type: "line", line: 5 }))).toThrowError(
      /unsupported/u,
    );
    // Binary frames are not this protocol.
    expect(() => parseClientMessage(new ArrayBuffer(8))).toThrowError();
  });

  it("refuses a message larger than the cap it advertises", () => {
    const oversized = JSON.stringify({ type: "line", line: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(oversized.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(() => parseClientMessage(oversized)).toThrowError(/too large|E2BIG/u);
    // And one just inside it is accepted, so the cap is a boundary rather than
    // a number that rejects everything interesting.
    const fits = JSON.stringify({ type: "line", line: "x".repeat(1024) });
    expect(parseClientMessage(fits)).toMatchObject({ type: "line" });
  });
});
