const button = document.querySelector("#run-benchmark");
const status = document.querySelector("#benchmark-status");
const resultPanel = document.querySelector("#results");
const metadata = document.querySelector("#result-meta");
const tables = document.querySelector("#benchmark-tables");
const workload = document.querySelector("#file-count");
const labels = {
  "concurrent-two-adds": "Concurrent adds from two shells",
  prepare: "Prepare and commit source", clone: "Clone source and configure identity", edit: "Modify, add and delete one file", "status-dirty": "Status after three changes", "add-partial": "Stage modification and addition", "diff-staged": "Diff staged changes", "commit-partial": "Commit selected changes", "add-rest": "Stage remaining deletion", "commit-rest": "Commit remaining deletion", "checkout-base": "Checkout base", "status-final": "Final clean status", "batch-capacity": "Object batch capacity failure and retry", "batch-missing-parent": "Object batch missing parent and retry", "index-capacity": "Index capacity failure and retry", "cancel-mid-add": "Cancel add and retry", "serialized-two-shells": "Two shells with host serialization", "partial-add-retry": "Second batch failure and retry", "checkout-failure": "Partial checkout and forced recovery",
  write: "Write files", stat: "Stat files", "stat-after-overwrite": "Stat after one overwrite", read: "Read files", readdir: "List directory (10×)", append: "Append to files", rename: "Rename files", "copy-tree": "Copy subtree", "remove-tree": "Remove subtree",
  init: "Init repository", populate: "Populate worktree", "add-all": "Add all", commit: "Initial commit", "status-clean": "Clean status", "status-change": "Status after edit", diff: "Diff one file", "add-one": "Add one file", "commit-one": "Commit one change", log: "Log (2 commits)", branch: "Create branch", "checkout-old": "Checkout initial branch", "checkout-main": "Checkout main",
  "add-unchanged": "Add unchanged worktree", "change-one": "Edit one file", "change-all": "Edit all tracked files", "add-changed": "Stage all tracked changes", "remove-files": "Delete worktree files", "add-removals": "Stage all deletions", "add-removals-repeat": "Stage deletions (20 rounds, incl. index resets)",
  "clone-bare": "Clone local bare remote", "clone-worktree": "Clone local worktree", "fetch-unchanged": "Fetch unchanged remote", "push-one": "Push one commit", "pull-one": "Pull one commit", "pull-unchanged": "Pull unchanged remote",
};
let snapshot;
let polling;
let pending = false;
const time = (value) => `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)} ms`;
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function render() {
  if (!snapshot) return;
  const result = snapshot.result;
  button.disabled = pending || snapshot.status === "running";
  if (pending || snapshot.status === "running") status.textContent = `Benchmark running${snapshot.progress == null ? "" : ` (${snapshot.progress}% complete)`}. Everyone shares this run; the previous saved result stays visible.`;
  else if (snapshot.status === "failed") status.textContent = snapshot.error;
  else if (!result) status.textContent = "No saved result yet. Request the first benchmark.";
  else if (snapshot.nextRunAt > Date.now()) status.textContent = `Saved result available. A new run becomes eligible at ${new Date(snapshot.nextRunAt).toLocaleTimeString()}. Requests before then reuse this result.`;
  else status.textContent = "The saved result is more than 10 minutes old. Request a benchmark to refresh it.";
  resultPanel.hidden = !result;
  if (!result) return;
  metadata.textContent = `Saved ${new Date(snapshot.modifiedAt).toLocaleString()} · Deployment ${result.deploymentId?.slice(0, 8) ?? "legacy"} · Request location ${result.colo ?? "local"} · 3 samples + warmup · ${result.verified.toLocaleString()} checks passed`;
  tables.replaceChildren();
  for (const group of ["files", "git", "git-shell", "coding-small", "coding-mixed", "git-recovery"]) {
    const rows = result.rows.filter((row) => row.group === group && row.files === Number(workload.value));
    if (rows.length === 0) continue;
    const shell = !["files", "git"].includes(group);
    const wrap = element("div"); wrap.className = "benchmark-table-wrap";
    const table = element("table"); table.className = "benchmark-table";
    table.append(element("caption", ({"git-shell": "Shell Git commands", "coding-small": "Coding session · 768-byte files", "coding-mixed": "Coding session · includes four 256 KiB files", "git-recovery": "Failure and recovery checks · includes setup and validation"})[group] ?? (group === "files" ? "File operations" : "Git engine operations")));
    const head = element("thead"); const headings = element("tr");
    for (const title of shell ? ["Operation", "Time"] : ["Operation", "VFS", "Metadata cache", "Cache / VFS"]) { const th = element("th", title); th.scope = "col"; headings.append(th); }
    head.append(headings); table.append(head);
    const body = element("tbody");
    for (const plain of rows.filter((row) => !row.cache)) {
      const cached = rows.find((row) => row.cache && row.operation === plain.operation);
      const tr = element("tr"); const name = element("td", labels[plain.operation] ?? plain.operation);
      if (plain.iterations > 1) name.append(element("small", `${plain.iterations.toLocaleString()} operations / call`));
      tr.append(name);
      for (const row of shell ? [plain] : [plain, cached]) {
        const cell = element("td", row ? time(row.medianMs) : "—");
        if (row) cell.append(element("small", `${time(row.minMs)} – ${time(row.maxMs)}`));
        tr.append(cell);
      }
      if (shell) { body.append(tr); continue; }
      const ratio = cached && cached.medianMs > 0 && plain.medianMs > 0 ? cached.medianMs / plain.medianMs : null;
      const cell = element("td", ratio === null ? "—" : `${ratio.toFixed(2)}×`);
      if (ratio !== null) cell.className = ratio < 1 ? "faster" : "slower";
      tr.append(cell); body.append(tr);
    }
    table.append(body); wrap.append(table); tables.append(wrap);
  }
}
function schedulePoll() {
  clearTimeout(polling);
  if (snapshot?.status === "running") polling = setTimeout(() => { void refresh(); }, 2000);
}
async function refresh() {
  try {
    const response = await fetch("/api/benchmarks", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the saved result.");
    snapshot = await response.json(); render(); schedulePoll();
  } catch (error) { status.textContent = error.message; }
}
button.addEventListener("click", async () => {
  pending = true; button.disabled = true; status.textContent = "Requesting benchmark… It runs in the background.";
  polling = setTimeout(() => { void refresh(); }, 2000);
  let requestError;
  try {
    const response = await fetch("/api/benchmarks", { method: "POST", signal: AbortSignal.timeout(180000) });
    const data = await response.json();
    if (!response.ok && !data.status) throw new Error(data.error ?? "Benchmark request failed.");
    snapshot = data;
  } catch (error) { requestError = error.message; }
  finally { pending = false; render(); if (requestError) status.textContent = requestError; schedulePoll(); }
});
workload.addEventListener("change", render);
void refresh();
