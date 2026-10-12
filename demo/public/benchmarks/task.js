import { comparablePoints, pairedRow } from "./paired.js";
import { element, sparkline, stateLabel } from "./trend.js";

const button = document.querySelector("#run-task");
const status = document.querySelector("#task-status");
const panel = document.querySelector("#task-summary");
const endpoint = "/api/benchmarks/task";
let timer;
const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[m] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
};
function render(state) {
  button.disabled = state.status === "running";
  status.textContent = state.status === "running"
    ? `Task benchmark running (${state.progress ?? 0}%). Previous results stay visible.`
    : state.error ?? (state.result ? `Saved ${new Date(state.result.completedAt).toLocaleString()} · commit ${state.result.commitHash.slice(0, 8)}. Lower is better.` : "No task measurements yet. Request the first run.");
  if (!state.result) return;
  const points = comparablePoints(state.history ?? [], state.result);
  const row = state.result.rows[0];
  const latest = points.at(-1);
  if (!row || !latest) return;
  panel.replaceChildren();
  const add = (name, value, detail, trends, paired) => {
    const node = element("div");
    node.className = "summary-row";
    const label = element("div", name);
    label.append(element("small", detail));
    const number = element("div", value);
    number.className = "summary-value";
    node.append(label, number, sparkline(trends, name, (x) => x.toFixed(1), paired));
    panel.append(node);
  };
  const timings = points.map((point) => ({ ...point, ...(pairedRow(point, row) ?? { value: null, status: "unresolved", runs: point.runs.length }) }));
  const ms = median(latest.runs.flatMap((run) => run.rows[0].samplesMs));
  add("Complete task", `${ms?.toFixed(0) ?? "—"} ms`, `${stateLabel[timings.at(-1)?.status]} · trend: reference = 100`, timings, true);
  for (const [field, label] of [["statements", "SQL statements"], ["rowsRead", "SQL rows read"], ["rowsWritten", "SQL rows written"]]) {
    const trends = points.map((point) => ({ ...point, value: median(point.runs.flatMap((run) => run.rows[0].costs?.candidate.map((cost) => cost[field]) ?? [])) }));
    const reference = median(latest.runs.flatMap((run) => run.rows[0].costs?.reference.map((cost) => cost[field]) ?? []));
    add(label, trends.at(-1)?.value?.toLocaleString() ?? "—", `Separate replay · reference ${reference?.toLocaleString() ?? "—"}`, trends, false);
  }
}
async function load() {
  clearTimeout(timer);
  try {
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load task results");
    const state = await response.json();
    render(state);
    if (state.status === "running") timer = setTimeout(load, 5000);
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}
button.addEventListener("click", async () => {
  clearTimeout(timer);
  button.disabled = true;
  try {
    const response = await fetch(endpoint, { method: "POST" });
    if (!response.ok) throw new Error("Could not request task benchmark");
    render(await response.json());
    await load();
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
void load();
