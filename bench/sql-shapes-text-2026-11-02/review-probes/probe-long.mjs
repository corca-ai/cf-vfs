import { lab } from "../../sql-lab/lab.mjs";

const w = lab(process.argv[2]);
const b = Buffer.alloc(1 << 20, 0x61);
for (let i = 0; i < b.length; i += 4096) b[i] = 0;
b[b.length - 1] = 0x0a;
const tests = [
  ["e-acute x 500k (1 MB)", "é".repeat(500000)],
  ["CJK x 349525", "中".repeat(349525)],
  ["ascii 1MiB NUL every 4k", b.toString("latin1")],
  ["mixed emoji/CRLF/BOM", "ab😀\r\n中é﻿".repeat(20000)],
];
for (const [label, s] of tests) {
  const q = (
    await w.sql(
      [
        [
          `SELECT CAST(CAST(? AS BLOB) AS TEXT) AS t, CAST(substr(CAST(? AS BLOB), -150) AS TEXT) AS tail`,
          [s, s],
        ],
      ],
      { maxRows: 1 },
    )
  ).results[0].rows[0];
  const m = /^([\s\S]*)… \((\d+) chars\)$/.exec(q.t);
  const tailSrc = new TextDecoder().decode(Buffer.from(s).subarray(-150));
  console.log(
    label.padEnd(24),
    "head ok",
    s.startsWith(m[1]),
    "jslen",
    m[2],
    "expected",
    s.length,
    "tail ok",
    q.tail === tailSrc,
  );
}
