import { expect, it } from "vitest";
import { tokenizeAwk } from "../src/shell/commands/awk-lexer.js";
import { parseAwkProgram } from "../src/shell/commands/awk-parser.js";
import { parseShellScript } from "../src/shell/parser.js";

it("bounds parsing before nested function definitions exhaust the stack", () => {
  expect(() => parseShellScript("f() ".repeat(5000) + "{ :; }", 100000)).toThrowError(
    expect.objectContaining({ code: "E2BIG" }),
  );
});

it("bounds nested compound commands during parsing", () => {
  expect(() => parseShellScript(`${"{ ".repeat(5000)}:;${" }".repeat(5000)}`, 100000)).toThrowError(
    expect.objectContaining({ code: "E2BIG" }),
  );
});

it("restores parser depth after sibling compound commands", () => {
  expect(() => parseShellScript("{ :; }; ".repeat(100), 10000, 8)).not.toThrow();
});

it.each([
  `BEGIN { ${"a=".repeat(5000)}1 }`,
  `BEGIN { ${"if(1) ".repeat(5000)}print 1 }`,
  `BEGIN { print ${"!".repeat(5000)}1 }`,
  `BEGIN { print ${"1^".repeat(5000)}1 }`,
  `BEGIN { print ${"$".repeat(5000)}1 }`,
  `BEGIN { print ${"1?1:".repeat(5000)}1 }`,
])("bounds recursive AWK syntax", (source) => {
  expect(() => parseAwkProgram(tokenizeAwk(source), 100000, 64)).toThrowError(
    expect.objectContaining({ code: "EINVAL", message: expect.stringContaining("nesting limit") }),
  );
});

it("bounds an AWK expression tree before recursive evaluation", () => {
  const source = `BEGIN { print ${"1+".repeat(5000)}1 }`;
  expect(() => parseAwkProgram(tokenizeAwk(source), 100000, 64)).toThrowError(
    expect.objectContaining({ code: "EINVAL", message: expect.stringContaining("nesting limit") }),
  );
});
