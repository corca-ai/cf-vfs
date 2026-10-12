import { summarizeHistory } from "./summary.js";
import { comparablePoints, pairedRow } from "./paired.js";
const button = document.querySelector("#run-benchmark");
const status = document.querySelector("#benchmark-status");
const resultPanel = document.querySelector("#results");
const metadata = document.querySelector("#result-meta");
const tables = document.querySelector("#benchmark-tables");
const workload = document.querySelector("#file-count");
const labels = {
  "concurrent-two-adds": "Concurrent adds from two shells",
  prepare: "Prepare and commit source",
  clone: "Clone source and configure identity",
  edit: "Modify, add and delete one file",
  "status-dirty": "Status after three changes",
  "add-partial": "Stage modification and addition",
  "diff-staged": "Diff staged changes",
  "commit-partial": "Commit selected changes",
  "add-rest": "Stage remaining deletion",
  "commit-rest": "Commit remaining deletion",
  "checkout-base": "Checkout base",
  "status-final": "Final clean status",
  "batch-capacity": "Object batch capacity failure and retry",
  "batch-missing-parent": "Object batch missing parent and retry",
  "index-capacity": "Index capacity failure and retry",
  "cancel-mid-add": "Cancel add and retry",
  "serialized-two-shells": "Two shells with host serialization",
  "partial-add-retry": "Second batch failure and retry",
  "checkout-failure": "Partial checkout and forced recovery",
  write: "Write files",
  stat: "Stat files",
  "stat-after-overwrite": "Stat after one overwrite",
  read: "Read files",
  readdir: "List directory (10×)",
  append: "Append to files",
  rename: "Rename files",
  "copy-tree": "Copy subtree",
  "remove-tree": "Remove subtree",
  init: "Init repository",
  populate: "Populate worktree",
  "add-all": "Add all",
  commit: "Initial commit",
  "status-clean": "Clean status",
  "status-change": "Status after edit",
  diff: "Diff one file",
  "add-one": "Add one file",
  "commit-one": "Commit one change",
  log: "Log (2 commits)",
  branch: "Create branch",
  "checkout-old": "Checkout initial branch",
  "checkout-main": "Checkout main",
  "add-unchanged": "Add unchanged worktree",
  "change-one": "Edit one file",
  "change-all": "Edit all tracked files",
  "add-changed": "Stage all tracked changes",
  "remove-files": "Delete worktree files",
  "add-removals": "Stage all deletions",
  "add-removals-repeat": "Stage deletions (20 rounds, incl. index resets)",
  "clone-bare": "Clone local bare remote",
  "clone-worktree": "Clone local worktree",
  "fetch-unchanged": "Fetch unchanged remote",
  "push-one": "Push one commit",
  "pull-one": "Pull one commit",
  "pull-unchanged": "Pull unchanged remote",
};
let snapshot;
let polling;
let pending = false;
const time = (value) =>
  `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)} ms`;
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
const stateLabel = {
  collecting: "More runs needed",
  faster: "Faster than reference",
  slower: "Slower than reference",
  uncertain: "No clear difference",
  unresolved: "Unresolved samples",
};
function trend(row, ratio = false) {
  if (snapshot.result.protocol && !ratio) {
    const points = comparablePoints(snapshot.history ?? [], snapshot.result).map((saved) => ({
      ...saved,
      ...(pairedRow(saved, row) ?? {
        value: null,
        status: "unresolved",
        ci95: null,
        runs: saved.runs.length,
        pairs: 0,
      }),
    }));
    return sparkline(
      points,
      labels[row.operation] ?? row.operation,
      (value) => `${value.toFixed(1)} index`,
      true,
    );
  }
  const history = snapshot.result.protocol
    ? comparablePoints(snapshot.history ?? [], snapshot.result)
    : (snapshot.history ?? []).filter((p) => !p.protocol);
  const points = history.flatMap((saved) => {
    const match = saved.rows.find(
      (r) =>
        r.group === row.group &&
        r.operation === row.operation &&
        r.files === row.files &&
        r.cache === row.cache &&
        r.iterations === row.iterations,
    );
    if (!match) return [];
    let value = match.medianMs;
    if (ratio) {
      const cached = saved.rows.find(
        (r) =>
          r.group === row.group &&
          r.operation === row.operation &&
          r.files === row.files &&
          r.cache &&
          r.iterations === row.iterations,
      );
      if (!cached || value <= 0 || cached.medianMs <= 0) return [];
      value = cached.medianMs / value;
    }
    return Number.isFinite(value) ? [{ ...saved, value }] : [];
  });
  return sparkline(
    points,
    labels[row.operation] ?? row.operation,
    ratio ? (v) => `${v.toFixed(2)}×` : time,
  );
}
function sparkline(points, label, format, paired = false) {
  const wrap = element("details");
  wrap.className = "trend";
  const summary = element("summary");
  if (!points.length) {
    wrap.append(element("small", "Collecting comparable history"));
    return wrap;
  }
  const finite = points.filter((p) => Number.isFinite(p.value));
  const first = finite[0]?.value,
    last = points.at(-1);
  const change = paired
    ? Number.isFinite(last.value)
      ? last.value - 100
      : null
    : finite.length > 1 && first > 0
      ? (last.value / first - 1) * 100
      : null;
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 120 32");
  svg.setAttribute("role", "img");
  // A zero origin and a minimum 0–200 reference-index scale do not magnify tiny fluctuations.
  const bounds = finite.flatMap((p) => [p.value, ...(p.ci95 ?? [])]).filter(Number.isFinite);
  const high = Math.max(paired ? 200 : 1, ...bounds) * 1.05;
  const y = (v) => 28 - (v / high) * 24;
  svg.setAttribute(
    "aria-label",
    `${label}. ${paired ? "Frozen reference = 100. " : ""}Scale 0–${high.toFixed(1)}. Lower is better. Intervals show uncertainty.`,
  );
  if (paired) {
    const reference = document.createElementNS(ns, "line");
    reference.setAttribute("x1", "4");
    reference.setAttribute("x2", "116");
    reference.setAttribute("y1", y(100));
    reference.setAttribute("y2", y(100));
    reference.setAttribute("class", "reference-line");
    svg.append(reference);
  }
  const list = element("ol");
  let segment = [];
  const flush = () => {
    if (segment.length) {
      const line = document.createElementNS(ns, "polyline");
      line.setAttribute("points", segment.join(" "));
      svg.append(line);
      segment = [];
    }
  };
  points.forEach((point, index) => {
    const identity = point.commitHash
      ? `Commit ${point.commitHash.slice(0, 8)}`
      : `Legacy ${(point.buildId ?? point.deploymentId).slice(0, 8)}`;
    const interval = point.ci95
      ? ` · 95% interval ${format(point.ci95[0])}–${format(point.ci95[1])} (${point.intervalScope})`
      : "";
    const description = `${identity} · ${new Date(point.completedAt).toLocaleString()} · ${Number.isFinite(point.value) ? format(point.value) : "unresolved"}${interval}${paired ? ` · ${point.runs ?? 0} runs / ${point.pairs ?? 0} pairs · ${stateLabel[point.status]}` : ""}`;
    list.append(element("li", description));
    if (!Number.isFinite(point.value)) {
      flush();
      return;
    }
    const x = points.length === 1 ? 60 : 4 + (index * 112) / (points.length - 1);
    segment.push(`${x},${y(point.value)}`);
    if (point.ci95?.every(Number.isFinite)) {
      const bar = document.createElementNS(ns, "line");
      bar.setAttribute("x1", x);
      bar.setAttribute("x2", x);
      bar.setAttribute("y1", y(point.ci95[0]));
      bar.setAttribute("y2", y(point.ci95[1]));
      bar.setAttribute("class", "interval-line");
      svg.append(bar);
    }
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", x);
    dot.setAttribute("cy", y(point.value));
    dot.setAttribute("r", "2.5");
    const title = document.createElementNS(ns, "title");
    title.textContent = description;
    dot.append(title);
    svg.append(dot);
  });
  flush();
  const labelNode = element(
    "span",
    change === null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
  );
  labelNode.append(element("small", paired ? `${last.runs ?? 0} runs` : `${points.length} points`));
  if (paired && ["faster", "slower"].includes(last.status)) summary.className = last.status;
  else if (!paired && change !== null) summary.className = change < 0 ? "faster" : "slower";
  summary.append(svg, labelNode);
  wrap.append(summary, list);
  return wrap;
}
function renderSummary(result) {
  const panel = document.querySelector("#benchmark-summary");
  panel.replaceChildren();
  const metrics = summarizeHistory(snapshot.history ?? [], result);
  for (const metric of metrics) {
    const row = element("div");
    row.className = "summary-row";
    const latest = metric.points.at(-1);
    const name = element("div", metric.label);
    name.append(
      element(
        "small",
        metric.paired
          ? `${metric.workloads} workloads · ${stateLabel[latest?.status] ?? "Collecting"}`
          : `${metric.workloads} workloads · legacy unpaired data`,
      ),
    );
    const value = element("span", Number.isFinite(latest?.value) ? latest.value.toFixed(1) : "—");
    value.className = "summary-value";
    row.append(
      name,
      value,
      sparkline(metric.points, metric.label, (v) => `${v.toFixed(1)} index`, !!metric.paired),
    );
    panel.append(row);
  }
  if (result.protocol) {
    panel.append(
      element(
        "p",
        `Frozen reference ${result.protocol.referenceCommit.slice(0, 8)} = 100. Each point combines retained runs of one commit. All 146 VFS workloads have equal weight; 44 cached workloads are separate. Error bars are 95% intervals on paired log ratios, using runs as clusters when multiple runs exist. At least 3 runs are required for a directional label; row intervals are not a multiple-comparison approval gate.`,
      ),
    );
    const point = comparablePoints(snapshot.history ?? [], result).find(
      (p) => p.commitHash === result.commitHash,
    );
    panel.append(
      element(
        "p",
        `${point?.runs?.length ?? 0} retained runs / ${point?.totalRuns ?? 0} collected for this commit (latest 12 retained). Zero or missing pairs leave the affected aggregate unresolved. Absolute milliseconds below can still vary with platform conditions.`,
      ),
    );
  } else
    panel.append(
      element(
        "p",
        "Legacy unpaired measurements: oldest comparable point = 100. These historical values cannot establish a code improvement; the next requested run starts the frozen-reference series.",
      ),
    );
  const legacy = document.querySelector("#legacy-history");
  legacy.replaceChildren();
  const points = (snapshot.history ?? []).filter((p) => !p.protocol);
  legacy.hidden = points.length === 0;
  legacy.append(element("summary", `Archived unpaired history (${points.length} commits)`));
  legacy.append(
    element(
      "p",
      "Preserved for context; excluded from the new reference comparison because the protocols differ.",
    ),
  );
  const list = element("ul");
  for (const p of points)
    list.append(
      element(
        "li",
        `${p.commitHash?.slice(0, 8) ?? p.buildId?.slice(0, 8) ?? "legacy"} · ${new Date(p.completedAt).toLocaleString()}`,
      ),
    );
  legacy.append(list);
}
function render() {
  if (!snapshot) return;
  const savedResult = snapshot.result;
  const retained = savedResult?.protocol
    ? comparablePoints(snapshot.history ?? [], savedResult).find(
        (p) => p.commitHash === savedResult.commitHash,
      )
    : null;
  const result = retained
    ? {
        ...savedResult,
        rows: savedResult.rows.map((row) => {
          const matching = retained.runs.flatMap((run) =>
            run.rows
              .filter(
                (r) =>
                  r.group === row.group &&
                  r.operation === row.operation &&
                  r.files === row.files &&
                  r.cache === row.cache &&
                  r.iterations === row.iterations,
              )
              .flatMap((r) => r.samplesMs),
          );
          const sorted = [...matching].sort((a, b) => a - b),
            n = sorted.length;
          return {
            ...row,
            medianMs: n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
            minMs: sorted[0],
            maxMs: sorted.at(-1),
          };
        }),
      }
    : savedResult;
  button.disabled = pending || snapshot.status === "running";
  if (pending || snapshot.status === "running")
    status.textContent = `Benchmark running${snapshot.progress == null ? "" : ` (${snapshot.progress}% complete)`}. Everyone shares this run; the previous saved result stays visible.`;
  else if (snapshot.status === "failed") status.textContent = snapshot.error;
  else if (!result) status.textContent = "No saved result yet. Request the first benchmark.";
  else if (snapshot.nextRunAt > Date.now())
    status.textContent = `Saved result available. A new run becomes eligible at ${new Date(snapshot.nextRunAt).toLocaleTimeString()}. Requests before then reuse this result.`;
  else
    status.textContent =
      "The saved result is more than 10 minutes old. Request a benchmark to refresh it.";
  resultPanel.hidden = !result;
  if (!result) return;
  metadata.textContent = `Saved ${new Date(snapshot.modifiedAt).toLocaleString()} · Commit ${result.commitHash?.slice(0, 8) ?? "not recorded"} · Deployment ${result.deploymentId?.slice(0, 8) ?? "legacy"} · Request location ${result.colo ?? "local"} · ${result.protocol ? `${result.protocol.pairsPerRun} paired samples + warmup / run` : "3 samples + warmup (legacy)"} · ${result.verified.toLocaleString()} checks passed`;
  tables.replaceChildren();
  renderSummary(result);
  for (const group of [
    "files",
    "git",
    "git-shell",
    "coding-small",
    "coding-mixed",
    "git-recovery",
  ]) {
    const rows = result.rows.filter(
      (row) => row.group === group && row.files === Number(workload.value),
    );
    if (rows.length === 0) continue;
    const shell = !["files", "git"].includes(group);
    const wrap = element("div");
    wrap.className = "benchmark-table-wrap";
    const table = element("table");
    table.className = "benchmark-table";
    table.append(
      element(
        "caption",
        {
          "git-shell": "Shell Git commands",
          "coding-small": "Coding session · 768-byte files",
          "coding-mixed": "Coding session · includes four 256 KiB files",
          "git-recovery": "Failure and recovery checks · includes setup and validation",
        }[group] ?? (group === "files" ? "File operations" : "Git engine operations"),
      ),
    );
    const head = element("thead");
    const headings = element("tr");
    for (const title of shell
      ? ["Operation", "Time"]
      : ["Operation", "VFS", "Metadata cache", "Cache / VFS"]) {
      const th = element("th", title);
      th.scope = "col";
      headings.append(th);
    }
    head.append(headings);
    table.append(head);
    const body = element("tbody");
    for (const plain of rows.filter((row) => !row.cache)) {
      const cached = rows.find((row) => row.cache && row.operation === plain.operation);
      const tr = element("tr");
      const name = element("td", labels[plain.operation] ?? plain.operation);
      if (plain.iterations > 1)
        name.append(element("small", `${plain.iterations.toLocaleString()} operations / call`));
      tr.append(name);
      for (const row of shell ? [plain] : [plain, cached]) {
        const cell = element("td");
        const metric = element("div");
        metric.className = "metric";
        const values = element("div", row ? time(row.medianMs) : "—");
        values.className = "metric-values";
        if (row) values.append(element("small", `${time(row.minMs)} – ${time(row.maxMs)}`));
        metric.append(values);
        if (row) metric.append(trend(row));
        cell.append(metric);
        tr.append(cell);
      }
      if (shell) {
        body.append(tr);
        continue;
      }
      const ratio =
        cached && cached.medianMs > 0 && plain.medianMs > 0
          ? cached.medianMs / plain.medianMs
          : null;
      const cell = element("td");
      const metric = element("div");
      metric.className = "metric";
      const value = element("div", ratio === null ? "—" : `${ratio.toFixed(2)}×`);
      value.className = "metric-values";
      if (ratio !== null) value.classList.add(ratio < 1 ? "faster" : "slower");
      metric.append(value, trend(plain, true));
      cell.append(metric);
      tr.append(cell);
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    tables.append(wrap);
  }
}
function schedulePoll() {
  clearTimeout(polling);
  if (snapshot?.status === "running")
    polling = setTimeout(() => {
      void refresh();
    }, 2000);
}
async function refresh() {
  try {
    if (snapshot?.status === "running") {
      const progress = await fetch("/api/benchmarks?progress=1", { cache: "no-store" });
      if (!progress.ok) throw new Error("Could not load benchmark progress.");
      const state = await progress.json();
      if (state.status === "running") {
        snapshot = { ...snapshot, ...state };
        status.textContent = `Benchmark running (${state.progress ?? 0}% complete). Paired reference comparison continues in the background.`;
        schedulePoll();
        return;
      }
    }
    const response = await fetch("/api/benchmarks", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the saved result.");
    snapshot = await response.json();
    render();
    schedulePoll();
  } catch (error) {
    status.textContent = error.message;
  }
}
button.addEventListener("click", async () => {
  pending = true;
  button.disabled = true;
  status.textContent = "Requesting benchmark… It runs in the background.";
  polling = setTimeout(() => {
    void refresh();
  }, 2000);
  let requestError;
  try {
    const response = await fetch("/api/benchmarks", {
      method: "POST",
      signal: AbortSignal.timeout(180000),
    });
    const data = await response.json();
    if (!response.ok && !data.status) throw new Error(data.error ?? "Benchmark request failed.");
    snapshot = data;
  } catch (error) {
    requestError = error.message;
  } finally {
    pending = false;
    render();
    if (requestError) status.textContent = requestError;
    schedulePoll();
  }
});
workload.addEventListener("change", render);
void refresh();
