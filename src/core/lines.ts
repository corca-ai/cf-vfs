export function splitLinesPreservingEndings(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) break;
    lines.push(text.slice(start, newline + 1));
    start = newline + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}
