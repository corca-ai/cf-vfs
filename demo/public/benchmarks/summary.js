/** Stable workload identity; never average milliseconds from unlike operations. */
export function workloadKey(row) {
  return JSON.stringify([row.group, row.operation, row.files, row.cache, row.iterations]);
}
export function geometricMean(values) {
  if (!values.length) return null;
  if (!values.every((value) => Number.isFinite(value) && value > 0))
    throw new Error("Geometric means require positive finite values");
  return Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length);
}
export const summaryMetrics = [
  { id: "overall", label: "Overall · VFS", includes: (row) => !row.cache },
  { id: "files", label: "File operations · VFS", includes: (row) => !row.cache && row.group === "files" },
  { id: "git", label: "Git & coding · VFS", includes: (row) => !row.cache && row.group !== "files" },
  { id: "cache", label: "Metadata cache", includes: (row) => row.cache },
];
function indexRows(rows) {
  const indexed = new Map();
  for (const row of rows) {
    const key = workloadKey(row);
    if (indexed.has(key)) throw new Error("Duplicate benchmark workload");
    indexed.set(key, row);
  }
  return indexed;
}
/** Same full workload cohort for every point, including unchanged iteration counts. */
export function summarizeHistory(history, result) {
  const expected = indexRows(result.rows);
  const points = history.filter((point) => {
    if ((point.engine && point.engine !== result.engine) ||
      (point.measurement && point.measurement !== result.measurement)) return false;
    const rows = indexRows(point.rows);
    return rows.size === expected.size && [...expected.keys()].every((key) => rows.has(key));
  });
  const indexed = points.map((point) => indexRows(point.rows));
  return summaryMetrics.map((metric) => {
    const selected = result.rows.filter(metric.includes);
    // A clock-rounded zero is not a ratio. Exclude that workload from ALL points.
    const cohort = selected.filter((row) => indexed.every((rows) => {
      const value = rows.get(workloadKey(row)).medianMs;
      return Number.isFinite(value) && value > 0;
    }));
    const baseline = indexed[0];
    return {
      ...metric,
      workloads: cohort.length,
      excluded: selected.length - cohort.length,
      skipped: history.length - points.length,
      regressions: indexed.length < 2 ? null : cohort.filter((row) =>
        indexed.at(-1).get(workloadKey(row)).medianMs / indexed.at(-2).get(workloadKey(row)).medianMs > 1.05).length,
      points: baseline && cohort.length ? points.map((point, index) => ({
        ...point,
        value: 100 * geometricMean(cohort.map((row) =>
          indexed[index].get(workloadKey(row)).medianMs / baseline.get(workloadKey(row)).medianMs)),
      })) : [],
    };
  });
}
/** Descriptive screening only: repeated paired trials are needed for adoption. */
export function assessPairs(pairs, threshold = 0.05) {
  const comparable = [], unresolved = [], costRegressions = [];
  for (const { row, previous } of pairs) {
    if (!previous || !Number.isFinite(row.medianMs) || !Number.isFinite(previous.medianMs) ||
      row.medianMs <= 0 || previous.medianMs <= 0) {
      unresolved.push(row);
      continue;
    }
    comparable.push({ row, ratio: row.medianMs / previous.medianMs });
    for (const counter of ["statements", "rowsRead", "rowsWritten"]) {
      if (row.sql?.[counter] > previous.sql?.[counter])
        costRegressions.push({ row, counter, before: previous.sql[counter], after: row.sql[counter] });
    }
  }
  const regressions = comparable.filter(({ ratio }) => ratio > 1 + threshold);
  return {
    threshold,
    costRegressions,
    workloads: pairs.length,
    comparable: comparable.length,
    sqlCoverage: pairs.filter(({ row, previous }) => row.sql && previous?.sql).length,
    unresolved,
    regressions,
    metrics: summaryMetrics.map((metric) => ({
      id: metric.id,
      label: metric.label,
      ratio: geometricMean(comparable.filter(({ row }) => metric.includes(row)).map(({ ratio }) => ratio)),
    })),
    worstRatio: comparable.length ? Math.max(...comparable.map(({ ratio }) => ratio)) : null,
    requiresReview: unresolved.length > 0 || regressions.length > 0 || costRegressions.length > 0,
  };
}
