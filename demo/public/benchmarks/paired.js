// Ratios are formed inside each matched pair, never from separate run medians.
const key = (row) =>
  JSON.stringify([row.group, row.operation, row.files, row.cache, row.iterations]);
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const t975 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201];
export function estimatePaired(logVectors) {
  if (!logVectors.length || logVectors.some((v) => !v.length || v.some((x) => !Number.isFinite(x))))
    return null;
  const runMeans = logVectors.map(mean);
  // Sessions are clusters: adding pairs within one run never invents new runs.
  const independent = logVectors.length > 1 ? runMeans : logVectors[0];
  const center = mean(runMeans),
    n = independent.length;
  const sampleMean = mean(independent);
  const variance =
    n < 2 ? null : independent.reduce((sum, x) => sum + (x - sampleMean) ** 2, 0) / (n - 1);
  const margin =
    variance === null ? null : (t975[Math.min(n - 1, 11)] ?? 1.96) * Math.sqrt(variance / n);
  const ci95 =
    margin === null ? null : [100 * Math.exp(center - margin), 100 * Math.exp(center + margin)];
  return {
    value: 100 * Math.exp(center),
    ci95,
    runs: logVectors.length,
    pairs: logVectors.reduce((sum, v) => sum + v.length, 0),
    intervalScope: logVectors.length > 1 ? "between runs" : "within one run",
    status:
      logVectors.length < 3
        ? "collecting"
        : !ci95
          ? "unresolved"
          : ci95[1] < 100
            ? "faster"
            : ci95[0] > 100
              ? "slower"
              : "uncertain",
  };
}
export function comparablePoints(history, result) {
  const expected = result.rows.map(key).sort().join("\n");
  return history.filter(
    (p) =>
      p.protocol?.id === result.protocol?.id &&
      p.protocol?.referenceHash === result.protocol?.referenceHash &&
      p.engine === result.engine &&
      p.measurement === result.measurement &&
      p.runs?.length &&
      p.rows.map(key).sort().join("\n") === expected,
  );
}
function valid(row, pairs) {
  return (
    row?.samplesMs.length === pairs &&
    row.referenceMs?.length === pairs &&
    [...row.samplesMs, ...row.referenceMs].every((x) => Number.isFinite(x) && x > 0)
  );
}
export function estimateWorkloads(point, selected) {
  if (!point.runs?.length || !selected.length) return null;
  const vectors = [];
  for (const run of point.runs) {
    const indexed = new Map(run.rows.map((row) => [key(row), row]));
    const rows = selected.map((row) => indexed.get(key(row)));
    const count = point.protocol.pairsPerRun;
    if (rows.some((row) => !valid(row, count))) return null;
    vectors.push(
      Array.from({ length: count }, (_, i) =>
        mean(rows.map((row) => Math.log(row.samplesMs[i] / row.referenceMs[i]))),
      ),
    );
  }
  return estimatePaired(vectors);
}
export function pairedSummary(history, result, metrics) {
  const points = comparablePoints(history, result);
  return metrics.map((metric) => {
    const selected = result.rows.filter(metric.includes);
    // Keep all workloads. A zero/incomplete measurement makes the aggregate unresolved.
    const estimates = points.map((point) => ({
      point,
      estimate: estimateWorkloads(point, selected),
    }));
    return {
      ...metric,
      workloads: selected.length,
      excluded: 0,
      skipped: history.length - points.length,
      regressions: null,
      paired: true,
      unresolved: estimates.filter((x) => !x.estimate).length,
      points: estimates.map(({ point, estimate }) => ({
        ...point,
        ...(estimate ?? {
          value: null,
          ci95: null,
          status: "unresolved",
          runs: point.runs.length,
          pairs: 0,
        }),
      })),
    };
  });
}
export function pairedRow(point, row) {
  return estimateWorkloads(point, [row]);
}

/** Independent run clusters for incremental (previous commit → current) comparisons. */
export function comparePoints(previous, candidate, selected) {
  if (previous.protocol?.id !== candidate.protocol?.id) return null;
  const a = estimateWorkloads(previous, selected),
    b = estimateWorkloads(candidate, selected);
  if (!a || !b) return null;
  const values = (point) =>
    point.runs.map((run) =>
      Math.log(estimateWorkloads({ ...point, runs: [run] }, selected).value / 100),
    );
  const av = values(previous),
    bv = values(candidate),
    am = mean(av),
    bm = mean(bv);
  const sem2 = (v, m) =>
    v.length < 2 ? null : v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1) / v.length;
  const sa = sem2(av, am),
    sb = sem2(bv, bm);
  let ci95 = null;
  if (sa !== null && sb !== null) {
    const sum = sa + sb;
    const df = sum === 0 ? 11 : sum ** 2 / (sa ** 2 / (av.length - 1) + sb ** 2 / (bv.length - 1));
    const critical = t975[Math.max(1, Math.min(11, Math.floor(df)))];
    const margin = critical * Math.sqrt(sum);
    ci95 = [100 * Math.exp(bm - am - margin), 100 * Math.exp(bm - am + margin)];
  }
  return {
    value: 100 * Math.exp(bm - am),
    ci95,
    previousRuns: av.length,
    currentRuns: bv.length,
    status:
      av.length < 3 || bv.length < 3
        ? "collecting"
        : ci95[1] < 100
          ? "faster"
          : ci95[0] > 100
            ? "slower"
            : "uncertain",
  };
}
