import type { ShellCommandContext } from "../types.js";
import { nearDuplicates } from "./awiki-duplicates.js";
import { normalizeDuplicateText } from "./awiki-fingerprint.js";
import {
  documentLine,
  guidance,
  largestComponent,
  samplePaths,
  wantedPages,
} from "./awiki-graph.js";
import { visibleMarkdownText } from "./awiki-parse.js";
import { fixed, ratio } from "./awiki-text.js";
import { readContent, type Vault } from "./awiki-vault.js";

export const SUGGEST_FILTERS = [
  "sampled-diameter",
  "wanted-pressure",
  "long-pages",
  "short-stubs",
  "near-duplicates",
] as const;

export type SuggestFilter = (typeof SUGGEST_FILTERS)[number];

export interface SuggestOptions {
  filters: SuggestFilter[];
  samples: number;
  paths: number;
  limit: number;
  seed: bigint;
  longLines: number;
  longWords: number;
  shortWords: number;
  duplicateThreshold: number;
}

export function defaultSuggestOptions(): SuggestOptions {
  return {
    filters: [...SUGGEST_FILTERS],
    samples: 2000,
    paths: 5,
    limit: 10,
    seed: 1n,
    longLines: 120,
    longWords: 1200,
    shortWords: 40,
    duplicateThreshold: 0.82,
  };
}

function sampledDiameter(vault: Vault, options: SuggestOptions): string {
  const component = largestComponent(vault);
  const sampled =
    component.length < 2 || options.samples === 0
      ? { pairs: 0, paths: [] }
      : samplePaths(vault, component, options.samples, options.seed);
  const paths = sampled.paths
    .filter((path) => path.length > 0)
    .sort((a, b) => vault.comparePaths(a, b))
    .slice(0, options.paths);
  const diameter = paths[0] === undefined ? 0 : Math.max(paths[0].length - 1, 0);
  let out = `\n// sampled_diameter samples=${sampled.pairs} sampled_diameter=${diameter} paths=${paths.length}`;
  out += guidance(
    "these sampled paths are long, so related topics may only connect through many weak hops.",
    "inspect the endpoints and middle bridge pages; add contextual links or a bridge note where the relationship is real.",
    "if two endpoints are clearly related, add a sentence-level link from the stronger overview page.",
  );
  for (const path of paths) {
    out += `\n// path distance=${Math.max(path.length - 1, 0)}`;
    for (const index of path) out += `\n${documentLine(vault, index)}`;
  }
  return out;
}

function wantedPressure(vault: Vault, options: SuggestOptions): string {
  const pages = wantedPages(vault).slice(0, options.limit);
  let out = `\n// wanted_pressure pages=${pages.length}`;
  out += guidance(
    "many notes point at these missing pages, so the wiki already depends on absent concepts.",
    "create the page, correct misspelled links, or consolidate equivalent names with a rename/redirect note.",
    "if [[Vector database]] is linked from many pages, create it as a hub or correct links to an existing page.",
  );
  if (pages.length === 0) return `${out}\n_ none`;
  for (const page of pages) {
    out += `\n[[${page.name}]] mentions=${page.mentions} source_documents=${page.documents.size}`;
    for (const source of page.sources.slice(0, 3)) {
      out += `\n- [[${source.document}]]: ${source.context}`;
    }
  }
  return out;
}

interface LengthHit {
  readonly doc: number;
  readonly lines: number;
  readonly words: number;
}

function pageLength(
  vault: Vault,
  label: "long_pages" | "short_stubs",
  options: SuggestOptions,
): string {
  const stats = vault.documents.map((document, doc) => ({
    doc,
    lines: document.page.visibleLines,
    words: document.page.words,
  }));
  const long = label === "long_pages";
  const hits: LengthHit[] = stats.filter((s) =>
    long
      ? s.lines >= options.longLines || s.words >= options.longWords
      : s.words > 0 && s.words <= options.shortWords,
  );
  const rate = fixed(ratio(hits.length, stats.length), 4);
  hits.sort(
    long
      ? (a, b) => b.words - a.words || b.lines - a.lines
      : (a, b) => a.words - b.words || a.lines - b.lines,
  );
  const shown = hits.slice(0, options.limit);
  let out = long
    ? `\n// ${label} threshold_lines=${options.longLines} threshold_words=${options.longWords} rate=${rate} pages=${shown.length}`
    : `\n// ${label} threshold_words=${options.shortWords} rate=${rate} pages=${shown.length}`;
  out += long
    ? guidance(
        "long pages often mix several concepts, making them harder to scan, link to, and maintain.",
        "split stable subtopics into separate pages, then leave a short summary with links.",
        'split "Machine learning" into "Supervised learning", "Evaluation metrics", and a short overview page.',
      )
    : guidance(
        "very short pages may add navigation cost without enough context to justify a separate note.",
        "expand the note, merge it into a stronger related page, or delete it if it is only a placeholder.",
        'merge "Backpropagation note" into [[Backpropagation]] unless it has a distinct role.',
      );
  if (shown.length === 0) return `${out}\n_ none`;
  for (const hit of shown) {
    out += `\n${documentLine(vault, hit.doc)} lines=${hit.lines} words=${hit.words}`;
  }
  return out;
}

async function duplicates(
  context: ShellCommandContext,
  vault: Vault,
  options: SuggestOptions,
): Promise<string> {
  const result = await nearDuplicates(
    context,
    vault.documents.map((document, doc) => ({
      doc,
      words: document.page.words,
    })),
    async (doc) => {
      const document = vault.doc(doc);
      const { content } = await readContent(context, document.path);
      return normalizeDuplicateText(
        visibleMarkdownText(content, document.page.frontMatter.bodyOffset),
      );
    },
    {
      shortWords: options.shortWords,
      threshold: options.duplicateThreshold,
      limit: options.limit,
    },
  );
  let out = `\n// near_duplicates threshold=${fixed(options.duplicateThreshold, 2)} candidates=${result.candidates} pairs=${result.pairs.length}`;
  out += guidance(
    "these pages share unusually similar text, which can split links and let two versions drift apart.",
    "compare both pages, merge the weaker one into the stronger one, then rename or update links as needed.",
    "keep the clearer page, move any unique detail into it, then update links from the weaker page.",
  );
  if (result.pairs.length === 0) return `${out}\n_ none`;
  for (const pair of result.pairs) {
    out += `\n[[${vault.doc(pair.a).name}]] <-> [[${vault.doc(pair.b).name}]] score=${fixed(pair.score, 3)} containment=${fixed(pair.containment, 3)} jaccard=${fixed(pair.jaccard, 3)} shared_grams=${pair.shared}`;
    out += `\n- ${documentLine(vault, pair.a)}`;
    out += `\n- ${documentLine(vault, pair.b)}`;
  }
  return out;
}

export async function suggestReport(
  context: ShellCommandContext,
  vault: Vault,
  options: SuggestOptions,
): Promise<string> {
  let out = `// suggest documents=${vault.documents.length} filters=${options.filters.join(",")}`;
  const has = (filter: SuggestFilter) => options.filters.includes(filter);
  if (has("sampled-diameter")) out += sampledDiameter(vault, options);
  if (has("wanted-pressure")) out += wantedPressure(vault, options);
  if (has("long-pages")) out += pageLength(vault, "long_pages", options);
  if (has("short-stubs")) out += pageLength(vault, "short_stubs", options);
  if (has("near-duplicates")) out += await duplicates(context, vault, options);
  return out;
}
