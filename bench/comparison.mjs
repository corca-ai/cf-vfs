import assert from "node:assert/strict";

export function pairOrder(index) {
  return index % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
}

function percentile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function distribution(samples) {
  assert.ok(samples.length > 0 && samples.every((value) => Number.isFinite(value) && value > 0));
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
  };
}

export function pairedRatio(baseline, candidate) {
  assert.equal(baseline.length, candidate.length);
  distribution(baseline);
  distribution(candidate);
  const ratios = baseline.map((duration, index) => candidate[index] / duration);
  // Deterministic paired bootstrap makes the summary reproducible from raw pairs.
  let seed = 0x12345678;
  const bootstrapped = [];
  for (let sample = 0; sample < 2000; sample += 1) {
    const resampled = ratios.map(() => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return ratios[Math.floor((seed / 2 ** 32) * ratios.length)];
    });
    bootstrapped.push(distribution(resampled).median);
  }
  bootstrapped.sort((a, b) => a - b);
  return {
    ...distribution(ratios),
    ci95: [percentile(bootstrapped, 0.025), percentile(bootstrapped, 0.975)],
  };
}

export async function measurePairs(suites, name, warmups, samples) {
  for (const suite of Object.values(suites)) await suite.prepare(name);
  const durations = { baseline: [], candidate: [] };
  let expected;
  for (let index = 0; index < warmups + samples; index += 1) {
    for (const version of pairOrder(index)) {
      const started = performance.now();
      const result = await suites[version].run(name);
      const duration = performance.now() - started;
      expected ??= result;
      // Outputs are checked inside the suite; SQL costs must also remain exact.
      assert.deepEqual(result, expected, `${name}: ${version} output or structural cost changed`);
      if (index >= warmups) durations[version].push(duration);
    }
  }
  return {
    name,
    baselineMs: distribution(durations.baseline),
    candidateMs: distribution(durations.candidate),
    ratio: pairedRatio(durations.baseline, durations.candidate),
    costs: expected,
    rawMs: durations,
  };
}
