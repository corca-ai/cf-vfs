import { lab } from "../../sql-lab/lab.mjs";

const w = lab(process.argv[2]);
const cases = {
  bom: "EFBBBF61",
  bom_mid: "61EFBBBF62",
  above_max: "F490808061",
  five_byte: "F888808080",
  nonchar_ffff: "EFBFBF61",
  cesu: "EDA0BDEDB880",
  crlf: "610D0A620D",
  cr_only: "0D",
  fffd_only: "EFBFBD",
  ff_only: "FF",
  nul_end: "6100",
  nul_only: "00",
  empty: "",
  emoji: "F09F9880",
  split_a: "E282",
  split_b: "AC61",
};
const sel = Object.entries(cases)
  .map(([k, h]) => `CAST(x'${h}' AS TEXT) AS ${k}`)
  .join(", ");
const extra = `, CAST(x'E282' || x'AC61' AS TEXT) AS concat_then_cast, typeof(x'E282' || x'AC61') AS concat_type, hex(x'E282' || x'AC61') AS concat_hex`;
const r = (await w.sql([[`SELECT ${sel}${extra}`]], { maxRows: 1 })).results[0].rows[0];
const ref = (h) => {
  try {
    return JSON.stringify(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(h, "hex")));
  } catch {
    return "INVALID";
  }
};
const refKeep = (h) => {
  try {
    return JSON.stringify(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(h, "hex")),
    );
  } catch {
    return "INVALID";
  }
};
for (const [k, h] of Object.entries(cases)) {
  const v = r[k];
  console.log(
    k.padEnd(13),
    h.padEnd(14),
    "TEXT",
    JSON.stringify(v).padEnd(18),
    "cps",
    typeof v === "string" ? [...v].map((c) => c.codePointAt(0).toString(16)).join(" ") : String(v),
    "| shell(fatal,stripBOM)",
    ref(h),
    "| awiki(keepBOM)",
    refKeep(h),
  );
}
console.log("concat_then_cast", JSON.stringify(r.concat_then_cast), r.concat_type, r.concat_hex);
// long strings
for (const [label, unit, n] of [
  ["e-acute x 500k (1 MB)", "C3A9", 500000],
  ["ascii 1MiB w/ NUL every 4k", null, 0],
  ["CJK 3-byte x 349525", "E4B8AD", 349525],
]) {
  let hex, expect;
  if (unit) {
    hex = unit.repeat(n);
    expect = new TextDecoder().decode(Buffer.from(hex, "hex"));
  } else {
    const b = Buffer.alloc(1 << 20, 0x61);
    for (let i = 0; i < b.length; i += 4096) b[i] = 0;
    b[b.length - 1] = 0x0a;
    hex = b.toString("hex");
    expect = b.toString("latin1");
  }
  const q = (
    await w.sql([[`SELECT CAST(x'${hex}' AS TEXT) AS t, length(x'${hex}') AS bytes`]], {
      maxRows: 1,
    })
  ).results[0].rows[0];
  console.log(
    label,
    "equal",
    q.t === expect,
    "jslen",
    q.t.length,
    "expectlen",
    expect.length,
    "bytes",
    q.bytes,
    "utf8(t)",
    Buffer.byteLength(q.t),
  );
}
