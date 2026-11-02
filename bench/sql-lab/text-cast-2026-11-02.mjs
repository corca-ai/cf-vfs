import { lab } from "./lab.mjs";

// Usage: node text-cast-2026-11-02.mjs LAB
//
// What a body read as TEXT becomes in JavaScript when its bytes are not valid
// UTF-8: each case is cast in SQLite and returned as a string; the code points
// and UTF-8 length show whether the bytes can be recovered or told apart from
// valid text. Meant for a local `cf dev` lab.
const [name] = process.argv.slice(2);
if (!name) throw new Error("usage: LAB");
const w = lab(name);
const cases = {
  truncated4: "F09F9861",
  overlong: "C08061",
  surrogate: "EDA08061",
  lone_cont: "8061",
  nul: "61006263",
  fffd: "EFBFBD61",
  valid: "E282AC61",
  latin1: "E961",
};
const sql = `SELECT ${Object.entries(cases)
  .map(
    ([k, hex]) =>
      `CAST(x'${hex}' AS TEXT) AS ${k}, hex(CAST(x'${hex}' AS TEXT)) AS ${k}_hex, length(CAST(x'${hex}' AS TEXT)) AS ${k}_len`,
  )
  .join(", ")}`;
const { results } = await w.sql([[sql]], { maxRows: 1 });
const row = results[0].rows[0];
for (const k of Object.keys(cases)) {
  const v = row[k];
  console.log(
    k.padEnd(11),
    JSON.stringify(v),
    "codepoints",
    typeof v === "string" ? [...v].map((c) => c.codePointAt(0).toString(16)).join(" ") : v,
    "utf8",
    typeof v === "string" ? Buffer.byteLength(v) : "-",
    "src",
    cases[k].length / 2,
    "sqlite hex",
    row[`${k}_hex`],
  );
}
