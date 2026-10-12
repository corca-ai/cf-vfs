export function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
export const stateLabel = {
  collecting: "More runs needed",
  faster: "Faster than reference",
  slower: "Slower than reference",
  uncertain: "No clear difference",
  unresolved: "Unresolved samples",
};
export function sparkline(points, label, format, paired = false) {
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
