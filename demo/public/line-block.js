/**
 * Where the edited line lives on screen, and how to replace it.
 *
 * A line longer than the terminal is wide occupies several rows. Redrawing it
 * means going back to the first of them and replacing all of them — clearing
 * one row and writing from wherever the cursor happens to be leaves the rows
 * above behind and writes another copy underneath, which is one more copy per
 * keystroke.
 *
 * Kept apart from the client so the arithmetic can be tested without a browser:
 * the row a write ends on, and the row a cursor should land on, are the two
 * things that were wrong.
 */

/** The cells a string occupies, which its colour escapes do not. */
export function visibleWidth(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching one is the point
  return text.replace(/\x1b\[[0-9;]*m/gu, "").length;
}

/**
 * The escape sequence that replaces the current block with `prompt` + `line`,
 * and the row the cursor ends on relative to the block's first row.
 *
 * `cursorRow` is what the previous call returned, or zero for a fresh prompt.
 */
export function redrawSequence({ prompt, line, cursor, columns, cursorRow }) {
  const width = Math.max(columns, 1);
  const promptWidth = visibleWidth(prompt);
  const total = promptWidth + line.length;
  const target = promptWidth + cursor;

  let sequence = cursorRow > 0 ? `\x1b[${cursorRow}A` : "";
  // To the end of the screen, not the end of the row: the block is what is
  // being replaced, and it may be several rows tall.
  sequence += `\r\x1b[J${prompt}${line}`;

  // Writing exactly to the right edge leaves the cursor on that row with a wrap
  // pending rather than on the next one, so the row a write ends on comes from
  // the last cell written and not from the count.
  const endRow = total === 0 ? 0 : Math.floor((total - 1) / width);
  const targetRow = Math.floor(target / width);
  const targetColumn = target % width;

  if (endRow > 0) sequence += `\x1b[${endRow}A`;
  sequence += "\r";
  if (targetRow > 0) sequence += `\x1b[${targetRow}B`;
  if (targetColumn > 0) sequence += `\x1b[${targetColumn}C`;
  return { sequence, cursorRow: targetRow };
}

/** The sequence that echoes a submitted line and leaves the block behind. */
export function submitSequence({ prompt, line, cursorRow }) {
  const above = cursorRow > 0 ? `\x1b[${cursorRow}A` : "";
  return `${above}\r\x1b[J${prompt}${line}\r\n`;
}
