import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { inputTexts, splitLines, writeText } from "./helpers.js";

const PASTE = {
  name: "paste",
  usage: "[-s] [-d LIST] [FILE...]",
  summary: "merges corresponding records of files into delimited rows",
  options: {
    short: { s: { name: "serial" }, d: { name: "delimiters", argument: true } },
    long: { serial: { name: "serial" }, delimiters: { name: "delimiters", argument: true } },
  },
} as const satisfies AppletSpecWithOptions<"serial" | "delimiters">;

/** GNU's delimiter list: `\n`, `\t`, `\\` and `\0` (no delimiter), used in turn. */
function delimiterList(value: string): string[] {
  const delimiters: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (character !== "\\") {
      delimiters.push(character);
      continue;
    }
    index += 1;
    const next = value[index];
    delimiters.push(next === "n" ? "\n" : next === "t" ? "\t" : next === "0" ? "" : (next ?? "\\"));
  }
  return delimiters.length === 0 ? [""] : delimiters;
}

function joined(values: readonly string[], delimiters: readonly string[]): string {
  let output = values[0] ?? "";
  for (let index = 1; index < values.length; index += 1) {
    output += `${delimiters[(index - 1) % delimiters.length] ?? ""}${values[index] ?? ""}`;
  }
  return output;
}

/**
 * Merges records side by side, or each file onto one line with `-s`, joining
 * them with the delimiters in turn; a tab when `-d` is not given.
 */
export const pasteCommand = /* @__PURE__ */ defineApplet(PASTE, async (context, argv, fds) => {
  const parsed = parseAppletOptions(PASTE, argv);
  const list = parsed.options.filter((option) => option.name === "delimiters").at(-1);
  const delimiters =
    list !== undefined && "argument" in list ? delimiterList(list.argument) : ["\t"];
  const serial = parsed.options.some((option) => option.name === "serial");
  const inputs = await inputTexts(context, parsed.operands, fds[0]);
  try {
    const columns = inputs.value.map((input) =>
      splitLines(input.text).map((line) => line.replace(/\n$/u, "")),
    );
    let output = "";
    if (serial) {
      for (const column of columns) output += `${joined(column, delimiters)}\n`;
    } else {
      const rows = Math.max(0, ...columns.map((column) => column.length));
      for (let row = 0; row < rows; row += 1) {
        output += `${joined(
          columns.map((column) => column[row] ?? ""),
          delimiters,
        )}\n`;
      }
    }
    await writeText(fds[1], output);
    return 0;
  } finally {
    inputs.release();
  }
});
