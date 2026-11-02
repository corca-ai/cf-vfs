import { lab } from "../../sql-lab/lab.mjs";

const w = lab("pipes");
const cases = {
  bom: "EFBBBF61",
  bom_mid: "61EFBBBF62",
  split_head: "61E282",
  split_tail: "AC62",
  cjk: "E4B8ADE69687",
  astral: "F09F9880",
};
const sql = `SELECT ${Object.entries(cases)
  .map(([k, h]) => `CAST(x'${h}' AS TEXT) AS ${k}`)
  .join(", ")}`;
const row = (await w.sql([[sql]], { maxRows: 1 })).results[0].rows[0];
for (const [k, h] of Object.entries(cases)) {
  const s = row[k];
  const bytes = Buffer.from(h, "hex");
  let td;
  try {
    td = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    td = "<EIO>";
  }
  const enc = Buffer.from(new TextEncoder().encode(s)).toString("hex").toUpperCase();
  console.log(
    k.padEnd(10),
    "sql->js",
    JSON.stringify(s),
    "| TextDecoder(fatal)",
    JSON.stringify(td),
    "| equal",
    s === td,
    "| re-encode==src",
    enc === h,
    "| hasFFFD",
    s.includes("�"),
  );
}
