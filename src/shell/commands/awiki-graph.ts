import { normalizeDocumentName } from "./awiki-parse.js";
import { sampleComponentPairs } from "./awiki-random.js";
import { compareLower, fixed, ratio, trim, truncateRunes } from "./awiki-text.js";
import { AwikiError, type Document, type Vault } from "./awiki-vault.js";

const PREVIEW_LIMIT = 140;

export function documentLine(vault: Vault, index: number): string {
  const document = vault.doc(index);
  const preview = trim(truncateRunes(trim(document.page.excerpt), PREVIEW_LIMIT));
  return `[[${document.name}]]: ${preview === "" ? "(empty)" : preview}`;
}

export function guidance(why: string, fix: string, example: string): string {
  return `\n// why: ${why}\n// fix: ${fix}\n// example: ${example}`;
}

// --- components and paths ---------------------------------------------------

function collectComponent(vault: Vault, start: number, visited: boolean[]): number[] {
  const queue = [start];
  visited[start] = true;
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of vault.neighborsOf(queue[head] ?? start)) {
      if (!visited[next]) {
        visited[next] = true;
        queue.push(next);
      }
    }
  }
  return queue;
}

function tracePath(previous: Int32Array, from: number, to: number): number[] {
  const path = [to];
  for (let at = to; at !== from; ) {
    at = previous[at] ?? from;
    path.push(at);
  }
  return path.reverse();
}

export function shortestPath(vault: Vault, from: number, to: number): number[] | undefined {
  if (from === to) return [from];
  const previous = new Int32Array(vault.documents.length).fill(-1);
  previous[from] = from;
  const queue = [from];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] ?? from;
    for (const next of vault.neighborsOf(current)) {
      if (previous[next] !== -1) continue;
      previous[next] = current;
      if (next === to) return tracePath(previous, from, to);
      queue.push(next);
    }
  }
  return undefined;
}

export function largestComponent(vault: Vault): number[] {
  const visited: boolean[] = new Array(vault.documents.length).fill(false);
  let best: number[] = [];
  for (let index = 0; index < vault.documents.length; index += 1) {
    if (visited[index]) continue;
    if (vault.neighborsOf(index).length === 0) {
      visited[index] = true;
      continue;
    }
    const component = vault.sortDocuments(collectComponent(vault, index, visited));
    if (
      component.length > best.length ||
      (component.length === best.length &&
        component.length > 0 &&
        compareLower(vault.doc(component[0] ?? 0).name, vault.doc(best[0] ?? 0).name) < 0)
    ) {
      best = component;
    }
  }
  return best;
}

/** Shortest paths between sampled pairs of the largest component. */
export function samplePaths(
  vault: Vault,
  component: readonly number[],
  samples: number,
  seed: bigint,
): { pairs: number; paths: number[][] } {
  const pairs = sampleComponentPairs(component.length, samples, seed);
  const paths: number[][] = [];
  for (const [a, b] of pairs) {
    paths.push(shortestPath(vault, component[a] ?? 0, component[b] ?? 0) ?? []);
  }
  return { pairs: pairs.length, paths };
}

// --- lint -------------------------------------------------------------------

export interface LintReport {
  readonly text: string;
  readonly failed: boolean;
}

export function lint(vault: Vault): LintReport {
  const count = vault.documents.length;
  const visited: boolean[] = new Array(count).fill(false);
  const components: number[][] = [];
  const orphans: number[] = [];
  const linkOnly: { index: number; line: number; text: string }[] = [];
  let covered = 0;
  vault.documents.forEach((document, index) => {
    if (trim(document.page.excerpt) !== "") covered += 1;
    for (const issue of document.page.linkOnly) linkOnly.push({ index, ...issue });
    if (vault.neighborsOf(index).length === 0) {
      orphans.push(index);
      visited[index] = true;
      return;
    }
    if (visited[index]) return;
    components.push(vault.sortDocuments(collectComponent(vault, index, visited)));
  });
  vault.sortDocuments(orphans);
  linkOnly.sort(
    (a, b) => compareLower(vault.doc(a.index).name, vault.doc(b.index).name) || a.line - b.line,
  );
  components.sort(
    (a, b) =>
      b.length - a.length || compareLower(vault.doc(a[0] ?? 0).name, vault.doc(b[0] ?? 0).name),
  );
  const islands = components.slice(1);
  const largest = components[0]?.length ?? (orphans.length > 0 ? 1 : 0);
  const rates = `largest_component_ratio=${fixed(ratio(largest, count), 4)} orphan_rate=${fixed(ratio(orphans.length, count), 4)} content_coverage=${fixed(ratio(covered, count), 4)}`;
  if (orphans.length === 0 && islands.length === 0 && linkOnly.length === 0) {
    return { failed: false, text: `// ok connected_graph documents=${count} ${rates}` };
  }
  let out = `// lint_failed documents=${count} orphans=${orphans.length} islands=${islands.length} link_only_lines=${linkOnly.length} ${rates}`;
  if (orphans.length > 0) {
    out += "\n// orphan";
    out += guidance(
      "no resolved links connect these pages to the wiki graph, so readers and agents are unlikely to discover them.",
      "add a contextual link to or from a related page, or merge/delete the note if it has no durable role.",
      'add "Compare with [[Related page]] ..." from the orphan, or link to it from a relevant index page.',
    );
    for (const index of orphans) out += `\n${documentLine(vault, index)}`;
  }
  islands.forEach((island, position) => {
    out += `\n// island=${position + 1}`;
    if (position === 0) {
      out += guidance(
        "this component links internally but is disconnected from the main wiki, so related knowledge is hard to reach.",
        "add one or two bridge links between a page below and a relevant page in the main component.",
        "connect the island's strongest overview page to one main-component page with a real relationship.",
      );
    }
    for (const index of island) out += `\n${documentLine(vault, index)}`;
  });
  if (linkOnly.length > 0) {
    out += "\n// link_only_line";
    out += guidance(
      "a line with only one link gives no local context, and grep results become hard to interpret.",
      "add a short phrase explaining the relationship, or rewrite the link into a sentence.",
      "- [[Bayes theorem]] -> - See [[Bayes theorem]] for updating beliefs with evidence.",
    );
    for (const issue of linkOnly) {
      out += `\n[[${vault.doc(issue.index).name}]]:${issue.line}: ${issue.text}`;
    }
  }
  return { failed: true, text: out };
}

// --- links ------------------------------------------------------------------

export function linksReport(vault: Vault, index: number): string {
  const lines = ["// this page", documentLine(vault, index), "// incoming links"];
  const incoming = vault.sortDocuments([...vault.inboundOf(index)]);
  if (incoming.length === 0) lines.push("// none");
  for (const source of incoming) lines.push(documentLine(vault, source));
  lines.push("// outgoing links");
  const seen = new Map<string, { name: string; missing: boolean; target?: number }>();
  const document = vault.doc(index);
  document.page.links.forEach((link, position) => {
    const target = document.resolved[position];
    if (target !== undefined) {
      const name = vault.doc(target).name;
      seen.set(`doc:${name.toLowerCase()}`, { name, missing: false, target });
    } else {
      seen.set(`missing:${link.displayTarget.toLowerCase()}`, {
        name: link.displayTarget,
        missing: true,
      });
    }
  });
  const outgoing = [...seen.values()].sort(
    (a, b) => Number(a.missing) - Number(b.missing) || compareLower(a.name, b.name),
  );
  if (outgoing.length === 0) lines.push("// none");
  for (const entry of outgoing) {
    lines.push(
      entry.target === undefined
        ? `[[${entry.name}]]: (missing)`
        : documentLine(vault, entry.target),
    );
  }
  return lines.join("\n");
}

// --- wanted -----------------------------------------------------------------

interface WantedSource {
  readonly document: string;
  readonly context: string;
  mentions: number;
}

export interface WantedPage {
  readonly name: string;
  mentions: number;
  readonly documents: Set<number>;
  readonly sources: WantedSource[];
  readonly sourceIndex: Map<string, number>;
}

/** Counts one unresolved link, grouping sources by page and context line. */
function mention(page: WantedPage, document: Document, index: number, context: string): void {
  page.mentions += 1;
  page.documents.add(index);
  const key = `${document.key}\0${context}`;
  const existing = page.sourceIndex.get(key);
  const source = existing === undefined ? undefined : page.sources[existing];
  if (source !== undefined) {
    source.mentions += 1;
    return;
  }
  page.sourceIndex.set(key, page.sources.length);
  page.sources.push({ document: document.name, context, mentions: 1 });
}

export function wantedPages(vault: Vault): WantedPage[] {
  const pages = new Map<string, WantedPage>();
  vault.documents.forEach((document, index) => {
    document.page.links.forEach((link, position) => {
      if (document.resolved[position] !== undefined) return;
      const name = normalizeDocumentName(link.displayTarget) || trim(link.displayTarget);
      if (link.targetKey === "" || name === "") return;
      let page = pages.get(link.targetKey);
      if (page === undefined) {
        page = { name, mentions: 0, documents: new Set(), sources: [], sourceIndex: new Map() };
        pages.set(link.targetKey, page);
      }
      mention(
        page,
        document,
        index,
        trim(link.context) || trim(document.page.excerpt) || "(empty)",
      );
    });
  });
  const result = [...pages.values()];
  for (const page of result) {
    page.sources.sort(
      (x, y) =>
        y.mentions - x.mentions ||
        compareLower(x.document, y.document) ||
        compareLower(x.context, y.context),
    );
  }
  return result.sort(
    (a, b) =>
      b.mentions - a.mentions ||
      b.documents.size - a.documents.size ||
      compareLower(a.name, b.name),
  );
}

export function wantedReport(vault: Vault, limit: number, sources: number): string {
  const pages = wantedPages(vault).slice(0, limit);
  if (pages.length === 0) return "_ none";
  const lines: string[] = [];
  pages.forEach((page, position) => {
    if (position > 0) lines.push("");
    lines.push(`[[${page.name}]] (${page.mentions} ${page.mentions === 1 ? "link" : "links"})`, "");
    const shown = sources > 0 ? Math.min(sources, page.sources.length) : page.sources.length;
    for (const source of page.sources.slice(0, shown)) {
      lines.push(`- [[${source.document}]]: ${source.context}`);
    }
    if (page.sources.length > shown) lines.push("_ ...");
  });
  return lines.join("\n");
}

// --- average shortest path --------------------------------------------------

export function averageShortestPath(
  vault: Vault,
  samples: number,
  examples: number,
  seed: bigint,
): string {
  const component = largestComponent(vault);
  if (component.length < 2) {
    throw new AwikiError("largest connected component must contain at least two documents");
  }
  if (samples === 0) throw new AwikiError("sample count must be positive");
  const sampled = samplePaths(vault, component, samples, seed);
  const total = sampled.paths.reduce((sum, path) => sum + Math.max(path.length - 1, 0), 0);
  const average = total / sampled.paths.length;
  const longer = sampled.paths
    .filter((path) => Math.max(path.length - 1, 0) > average)
    .sort((a, b) => vault.comparePaths(a, b))
    .slice(0, examples);
  const lines = [
    `// largest_component_size=${component.length} samples=${sampled.pairs} average_shortest_path=${fixed(average, 4)}`,
  ];
  longer.forEach((path, position) => {
    if (position > 0) lines.push("");
    for (const index of path) lines.push(documentLine(vault, index));
  });
  return lines.join("\n");
}
