import { expect, it } from "vitest";
import { tokenizeAwk } from "../src/shell/commands/awk-lexer.js";
import { parseAwkProgram } from "../src/shell/commands/awk-parser.js";
import { parseShellScript } from "../src/shell/parser.js";
import { AWK_DEPTH_CASES } from "./helpers/boundary-cases.js";

it("bounds parsing before nested function definitions exhaust the stack", () => {
  expect(() => parseShellScript("f() { g() { :; }; }", 100000)).not.toThrow();
  expect(() => parseShellScript(`${"f() ".repeat(5000)}{ :; }`, 100000)).toThrowError(
    expect.objectContaining({ code: "E2BIG" }),
  );
});

it("bounds nested compound commands during parsing", () => {
  expect(() => parseShellScript("{ { :; }; }", 100000)).not.toThrow();
  expect(() => parseShellScript(`${"{ ".repeat(5000)}:;${" }".repeat(5000)}`, 100000)).toThrowError(
    expect.objectContaining({ code: "E2BIG" }),
  );
});

it("restores parser depth after sibling compound commands", () => {
  expect(() => parseShellScript("{ :; }; ".repeat(100), 10000, 8)).not.toThrow();
});

it.each(AWK_DEPTH_CASES)("bounds AWK $name syntax with a valid shallow control", ({ make }) => {
  expect(() => parseAwkProgram(tokenizeAwk(make(2)), 100000, 64)).not.toThrow();
  expect(() => parseAwkProgram(tokenizeAwk(make(5000)), 100000, 64)).toThrowError(
    expect.objectContaining({ code: "EINVAL", message: expect.stringContaining("nesting limit") }),
  );
});
