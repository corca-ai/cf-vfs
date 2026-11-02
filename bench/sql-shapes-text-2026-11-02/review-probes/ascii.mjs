import { lab } from "../../sql-lab/lab.mjs";

const w = lab("pipes");
const q = `SELECT count(*) AS chunks, count(DISTINCT entry_id) AS entries, sum(length(CAST(body AS TEXT)) != length(body)) AS nonascii_chunks, max(chunk_index) AS maxidx, max(length(body)) AS maxlen FROM vfs_inline_chunks`;
console.log((await w.sql([[q]], { maxRows: 1 })).results[0].rows[0]);
const q2 = `SELECT count(*) AS files FROM vfs_entries WHERE kind='file'`;
console.log((await w.sql([[q2]], { maxRows: 1 })).results[0].rows[0]);
