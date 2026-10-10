function rowKey(row) {
  return JSON.stringify([row.group, row.operation, row.files, row.cache]);
}

function indexRows(rows) {
  const indexed = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    if (indexed.has(key)) throw new Error("Duplicate benchmark workload");
    indexed.set(key, row);
  }
  return indexed;
}

/** Validate the entire comparison before printing any performance ratios. */
export function comparePublicResults(baseline, candidate, allowAddedWorkloads = false) {
  if (baseline.measurement !== candidate.measurement || baseline.engine !== candidate.engine)
    throw new Error("Baseline workload or measurement differs");
  const older = indexRows(baseline.rows);
  const newer = indexRows(candidate.rows);
  if (!allowAddedWorkloads && older.size !== newer.size)
    throw new Error("Baseline workload or measurement differs");
  for (const [key, row] of older) {
    const next = newer.get(key);
    if (next === undefined) throw new Error("A baseline workload is missing");
    if (next.iterations !== row.iterations) throw new Error("Baseline row differs");
  }
  return candidate.rows.map((row) => {
    const previous = older.get(rowKey(row));
    if (previous === undefined && !allowAddedWorkloads) throw new Error("Baseline row differs");
    return { row, previous };
  });
}
