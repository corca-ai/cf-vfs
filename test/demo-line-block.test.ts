import { expect, it } from "vitest";
// @ts-expect-error -- the demo client is plain JavaScript served as an asset.
import { redrawSequence, submitSequence, visibleWidth } from "../demo/public/line-block.js";

const PROMPT = "\u001b[38;5;81mcf-vfs\u001b[0m:\u001b[38;5;114m/home/demo\u001b[0m$ ";
const PROMPT_WIDTH = 19;

/**
 * The arithmetic behind the edited line.
 *
 * A wrapped line was redrawn by clearing one row and writing from wherever the
 * cursor was, which left the rows above it behind and added a copy underneath
 * on every keystroke. These assert the two quantities that were wrong: the row
 * a write ends on, and the row the cursor should land on.
 */
it("measures a prompt in cells rather than characters", () => {
  expect(visibleWidth(PROMPT)).toBe(PROMPT_WIDTH);
  expect(visibleWidth("plain")).toBe(5);
});

it("stays on one row for a line that fits", () => {
  const { sequence, cursorRow } = redrawSequence({
    prompt: PROMPT,
    line: "ls",
    cursor: 2,
    columns: 80,
    cursorRow: 0,
  });
  expect(cursorRow).toBe(0);
  expect(sequence).not.toContain("\u001b[1A");
  expect(sequence).toContain("\u001b[J");
  expect(sequence.endsWith(`\r\u001b[${PROMPT_WIDTH + 2}C`)).toBe(true);
});

it("returns to the first row of a wrapped block before replacing it", () => {
  const line = "x".repeat(61);
  const first = redrawSequence({
    prompt: PROMPT,
    line,
    cursor: line.length,
    columns: 40,
    cursorRow: 0,
  });
  // 19 + 61 = 80 cells over 40 columns: the cursor ends on the third row.
  expect(first.cursorRow).toBe(2);

  const second = redrawSequence({
    prompt: PROMPT,
    line: `${line}y`,
    cursor: line.length + 1,
    columns: 40,
    cursorRow: first.cursorRow,
  });
  // Without this the redraw would start on the last row and write a copy.
  expect(second.sequence.startsWith("\u001b[2A\r\u001b[J")).toBe(true);
});

it("does not accumulate rows across repeated redraws", () => {
  let cursorRow = 0;
  let line = "";
  for (const character of "echo a deliberately long command that wraps") {
    line += character;
    ({ cursorRow } = redrawSequence({
      prompt: PROMPT,
      line,
      cursor: line.length,
      columns: 40,
      cursorRow,
    }));
  }
  // 19 + 43 = 62 cells over 40 columns is two rows, however many keystrokes
  // it took to get there.
  expect(cursorRow).toBe(1);
});

it("counts the row a write ends on from the last cell, not the count", () => {
  // Exactly 40 cells fills one row and leaves the cursor there with a wrap
  // pending; treating it as two rows would move up one row too many next time.
  const line = "x".repeat(40 - PROMPT_WIDTH);
  const { sequence } = redrawSequence({
    prompt: PROMPT,
    line,
    cursor: 0,
    columns: 40,
    cursorRow: 0,
  });
  expect(sequence).not.toContain("\u001b[1A\r\u001b[1B");
  expect(sequence.endsWith(`\r\u001b[${PROMPT_WIDTH}C`)).toBe(true);
});

it("places the cursor where the caller left it, not at the end", () => {
  const { sequence, cursorRow } = redrawSequence({
    prompt: PROMPT,
    line: "abcdefghij",
    cursor: 3,
    columns: 40,
    cursorRow: 0,
  });
  expect(cursorRow).toBe(0);
  expect(sequence.endsWith(`\r\u001b[${PROMPT_WIDTH + 3}C`)).toBe(true);
});

it("clears the whole block when echoing a submitted line", () => {
  expect(submitSequence({ prompt: PROMPT, line: "ls", cursorRow: 2 })).toBe(
    `\u001b[2A\r\u001b[J${PROMPT}ls\r\n`,
  );
  expect(submitSequence({ prompt: PROMPT, line: "ls", cursorRow: 0 })).toBe(
    `\r\u001b[J${PROMPT}ls\r\n`,
  );
});
