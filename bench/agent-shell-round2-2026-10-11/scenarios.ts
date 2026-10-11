import {
  expectedFiles as originalExpected,
  files as originalFiles,
  scenarios as originalScenarios,
} from "../agent-shell-2026-10-11/scenarios.ts";

// Unique supplementary strings exercise the encoded fallback; long common
// prefixes guard against replacing native comparison with a JS character loop.
const unicodeLines = Array.from(
  { length: 400 },
  (_, i) => `${String.fromCodePoint(0x10000 + ((i * 197) % 400))}-record`,
);
const prefixLines = Array.from(
  { length: 300 },
  (_, i) => `${"a".repeat(4096)}${String((i * 137) % 300).padStart(3, "0")}`,
);
const sortedUnicode = Array.from(
  { length: 400 },
  (_, i) => `${String.fromCodePoint(0x10000 + i)}-record\n`,
).join("");
const sortedPrefix = Array.from(
  { length: 300 },
  (_, i) => `${"a".repeat(4096)}${String(i).padStart(3, "0")}\n`,
).join("");
export const files = {
  ...originalFiles,
  "/unicode-sort.txt": `${unicodeLines.join("\n")}\n`,
  "/prefix-sort.txt": `${prefixLines.join("\n")}\n`,
};
export const scenarios = [
  ...originalScenarios,
  { name: "supplementary-sort", script: "sort /unicode-sort.txt", stdout: sortedUnicode },
  { name: "long-prefix-sort", script: "sort /prefix-sort.txt", stdout: sortedPrefix },
];
export const expectedFiles = originalExpected;
