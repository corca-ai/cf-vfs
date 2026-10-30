import { writeFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node operand-bisect-2026-10-30.mjs LAB
//
// Splits where a command over 8,055 operands spends its time on Cloudflare:
// pathname expansion alone, output to a pipe or to /dev/null, and the
// per-operand work of grep, wc and awk with bulk reads offered. One request
// each, three rounds; medians.

const [name] = process.argv.slice(2);
const w = lab(name);
const SCRIPTS = {
  empty: "true",
  "glob only": "echo /wiki/*/*.md > /dev/null",
  "glob, one word per file to a pipe": "printf '%s\\n' /wiki/*/*.md | wc -l",
  "grep -lF > /dev/null": "grep -lF '[[note-0001' /wiki/*/*.md > /dev/null",
  "grep -lF | wc -l": "grep -lF '[[note-0001' /wiki/*/*.md | wc -l",
  "grep -rlF > /dev/null": "grep -rlF '[[note-0001' /wiki > /dev/null",
  "wc -l > /dev/null": "wc -l /wiki/*/*.md > /dev/null",
  "wc -l | tail -1": "wc -l /wiki/*/*.md | tail -1",
  "awk FNR==1 > /dev/null": "awk 'FNR == 1' /wiki/*/*.md > /dev/null",
  "cat > /dev/null": "cat /wiki/*/*.md > /dev/null",
};
const samples = {};
for (let round = 0; round < 3; round += 1) {
  for (const [label, script] of Object.entries(SCRIPTS)) {
    const result = await w.shell(script);
    samples[label] ??= [];
    samples[label].push(result.ms);
    if (round === 0)
      console.log(
        `${label.padEnd(36)} exit ${result.exitCode} ${JSON.stringify(result.stdout.trim()).slice(0, 40)} ${result.stderr.trim().slice(0, 80)}`,
      );
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[1];
for (const [label, values] of Object.entries(samples)) {
  console.log(
    `${label.padEnd(36)} ${String(median(values)).padStart(6)} ms  [${values.join(", ")}]`,
  );
}
writeFileSync(
  new URL(`./operand-bisect-2026-10-30-${name}.json`, import.meta.url),
  `${JSON.stringify(samples, null, 1)}\n`,
);
