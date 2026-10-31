import { appendFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node runtime-costs-2026-10-31.mjs LAB LABEL [ROUNDS]
//
// Times, in a SQL lab Durable Object holding the 10,000-page wiki, the work
// that stays slow on Workers once reads are bulk: awiki's decode and parse
// per page, awk's per-record work, and lines written to a pipe. Run once per
// deployed version (LABEL) and alternate versions across sessions; each run
// appends one JSON line per sample to runtime-costs-2026-10-31-LAB.jsonl.

const [name, label, roundsArg] = process.argv.slice(2);
if (!name || !label) throw new Error("usage: LAB LABEL [ROUNDS]");
const rounds = Number(roundsArg ?? 3);
const w = lab(name);

const all = [];
for (let offset = 0; offset < 10_000; offset += 1000) {
  const page = await w.sql(
    [
      [
        `SELECT path FROM vfs_entries WHERE path >= '/wiki/' AND path < '/wiki0' AND kind = 'file' ORDER BY path LIMIT 1000 OFFSET ${offset}`,
      ],
    ],
    { maxRows: 1000 },
  );
  all.push(...page.results[0].rows.map((row) => row.path));
}

async function readAll(mode) {
  const start = Date.now();
  for (let at = 0; at < all.length; at += 2000) await w.read(all.slice(at, at + 2000), mode);
  return Date.now() - start;
}

const SCRIPTS = {
  "awk FNR==1 glob > null": "awk 'FNR == 1' /wiki/*/*.md > /dev/null",
  "awk print $1 glob | wc -l": "awk '{ print $1 }' /wiki/*/*.md | wc -l",
  "cat dir | grep -c x": "cat /wiki/sales/*.md | grep -c owner",
  "wc -l glob | tail -1": "wc -l /wiki/*/*.md | tail -1",
  "awiki lint cold": "awiki lint -r -root /wiki > /dev/null; echo $?",
  "grep -rc owner | tail": "grep -rc owner /wiki | tail -1",
};

// ONLY=comma-separated measurements limits a session to those.
const only = process.env.ONLY?.split(",");
const wanted = (what) => only === undefined || only.includes(what);
const out = new URL(`./runtime-costs-2026-10-31-${name}.jsonl`, import.meta.url);
for (let round = 0; round < rounds; round += 1) {
  for (const mode of ["many", "decode", "parse"].filter((mode) => wanted(`read ${mode}`))) {
    const ms = await readAll(mode);
    appendFileSync(out, `${JSON.stringify({ label, round, what: `read ${mode}`, ms })}\n`);
    console.log(`${label} ${`read ${mode}`.padEnd(26)} ${String(ms).padStart(6)} ms`);
  }
  for (const [what, script] of Object.entries(SCRIPTS).filter(([what]) => wanted(what))) {
    const result = await w.shell(script);
    appendFileSync(
      out,
      `${JSON.stringify({ label, round, what, ms: result.ms, stdout: result.stdout.trim().slice(0, 80), exit: result.exitCode })}\n`,
    );
    console.log(
      `${label} ${what.padEnd(26)} ${String(result.ms).padStart(6)} ms  ${JSON.stringify(result.stdout.trim().slice(0, 40))} ${result.stderr.trim().slice(0, 60)}`,
    );
  }
}
