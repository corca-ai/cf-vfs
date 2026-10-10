import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const root = new URL("./", import.meta.url);
const results = [];
for (const name of (await readdir(root)).sort()) {
  if (!/^(?:local|cf)-.*\.json(?:\.gz)?$/u.test(name)) continue;
  let bytes = await readFile(new URL(name, root));
  if (name.endsWith(".gz")) bytes = gunzipSync(bytes);
  const data = JSON.parse(bytes.toString());
  if (!data.metrics || !Array.isArray(data.regressions)) {
    results.push({
      file: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: "partial checkpoint, supplementary control or other metric; not latency approval",
    });
    continue;
  }
  results.push({
    file: name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    credentials: data.credentials ?? "none",
    identityTime: data.identityTime ?? null,
    fixtureRootMode: data.fixtureRootMode ?? null,
    fullPlan: data.fullPlan ?? true,
    stageOrder: data.stageOrder ?? false,
    trials: data.trials,
    metrics: data.metrics,
    regressions: data.regressions.length,
    confirmed: data.confirmed.length,
    costRegressions: data.costRegressions.length,
  });
}
await writeFile(new URL("inventory.json", root), JSON.stringify(results, null, 2) + "\n");
const lines = [
  "# Raw measurement inventory",
  "",
  "Ratios are candidate/baseline. Lower is faster. A confidence interval containing1 does not prove a latency improvement. These rows are evidence, not automatic approvals. Older protocols and changed credentials must not be pooled. SHA-256 hashes in inventory.json refer to decompressed original bytes.",
  "",
  "| Evidence | Credentials | Full plan | Pairs | Overall ratio [95% CI] | >5% flags | Confirmed flags | Cost increases |",
  "|---|---|---|---|---|---|---|---|",
];
for (const r of results) {
  if (!r.metrics) continue;
  const m = r.metrics.find((x) => x.id === "overall");
  const f = (x) => x.toFixed(4);
  const ratio = m ? `${f(m.ratio.median)} [${m.ratio.ci95.map(f).join(", ")}]` : "—";
  lines.push(
    `| [${r.file}](${r.file}) | ${typeof r.credentials === "object" ? JSON.stringify(r.credentials) : r.credentials} | ${r.fullPlan} | ${r.trials} | ${ratio} | ${r.regressions} | ${r.confirmed} | ${r.costRegressions} |`,
  );
}
await writeFile(new URL("inventory.md", root), lines.join("\n") + "\n");
console.log(`Indexed ${results.length} evidence files`);
