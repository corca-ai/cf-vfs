import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compilePosixRegex as after } from "../dist/core/posix-regex.js";

assert.ok(process.argv[2], "Pass a saved baseline dist directory");
const root = pathToFileURL(`${resolve(process.argv[2])}/`);
const { compilePosixRegex: before } = await import(new URL("core/posix-regex.js", root));
const atoms = [
  "a",
  "b",
  "😀",
  "[ab]",
  ".",
  "[^x]",
  "(a|ab)",
  "(a*)",
  "[[:alpha:]]",
  "\ud83d",
  "\ude00",
  "",
];
const patterns = [
  ...new Set(atoms.flatMap((a) => [a, `${a}*`, `^${a}$`, `(${a})?b`, `${a}{2}`, `(${a}|x)+`])),
];
patterns.push("a+", "a\\+", "\\(a*\\)b", "a^b", "a$b", "[]]", "[a-a]", "\\.", "^([a-z]+[0-9]+)+$");
let seed = 719;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
const alphabet = ["a", "b", "x", "1", "A", "😀", "𐐀", "\ud83d", "\ude00", "\n"];
const texts = [
  "",
  "a",
  "ab",
  "😀",
  "😀x😀x",
  "needle123".repeat(50),
  "ab".repeat(80),
  "a".repeat(400) + "!",
];
for (let i = 0; i < 70; i++)
  texts.push(Array.from({ length: random(18) }, () => alphabet[random(alphabet.length)]).join(""));
let comparisons = 0;
function outcome(fn) {
  try {
    return fn();
  } catch (e) {
    return { error: e.code, message: e.message };
  }
}
for (const dialect of ["basic", "extended"])
  for (const ignoreCase of [false, true])
    for (const source of patterns) {
      const a = outcome(() => before(source, dialect, "test", { ignoreCase }));
      const b = outcome(() => after(source, dialect, "test", { ignoreCase }));
      if (a.error || b.error) {
        assert.deepEqual(b, a);
        continue;
      }
      for (const text of texts) {
        const context = JSON.stringify({ source, dialect, ignoreCase, text });
        assert.deepEqual(
          outcome(() => b.test(text)),
          outcome(() => a.test(text)),
          context,
        );
        comparisons++;
        for (const from of new Set([
          -1,
          0,
          0.5,
          1,
          2,
          5,
          text.length,
          text.length + 0.5,
          NaN,
          Infinity,
        ])) {
          assert.deepEqual(
            outcome(() => b.exec(text, from)),
            outcome(() => a.exec(text, from)),
            context + " from=" + from,
          );
          comparisons++;
        }
      }
    }
console.log(
  JSON.stringify({
    baseline: process.argv[2],
    patterns: patterns.length,
    texts: texts.length,
    comparisons,
  }),
);
