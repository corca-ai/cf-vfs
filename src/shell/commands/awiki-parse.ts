import {
  containsLetterOrDigit,
  FenceState,
  maskInlineCode,
  normalizeCounting,
  normalizePreviewLine,
  scanLines,
  startsIndented,
  stripLineOnlyMarkdown,
  trim,
  trimLine,
  trimStart,
} from "./awiki-text.js";

/**
 * Everything `awiki` derives from one page's text alone: front matter, links,
 * link-only lines, the preview line and length statistics. Names and graph
 * edges depend on the rest of the wiki and are computed when it loads, so
 * this is what a cache can keep per file.
 */

export type LinkKind = "wiki" | "markdown";

interface ParsedLink {
  readonly kind: LinkKind;
  readonly displayTarget: string;
  readonly targetKey: string;
  readonly rawTarget: string;
  readonly context: string;
}

export interface FrontMatter {
  readonly present: boolean;
  readonly bodyOffset: number;
  readonly title: string;
  readonly aliases: readonly string[];
}

interface LinkOnlyLine {
  readonly line: number;
  readonly text: string;
}

export interface ParsedPage {
  readonly frontMatter: FrontMatter;
  readonly links: readonly ParsedLink[];
  readonly linkOnly: readonly LinkOnlyLine[];
  readonly excerpt: string;
  /** Keys a rename rewrite would match in this page, images included. */
  readonly rewriteKeys: ReadonlySet<string>;
  readonly visibleLines: number;
  readonly words: number;
}

// --- paths -------------------------------------------------------------------

export function cleanPath(path: string): string {
  const parts: string[] = [];
  const segments = path.split("/");
  segments.forEach((segment, index) => {
    if (segment === "" && index === 0) {
      parts.length = 0;
      return;
    }
    if (segment === "" || segment === ".") return;
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
      return;
    }
    parts.push(segment);
  });
  return parts.length === 0 ? "." : parts.join("/");
}

export function cleanRelPath(path: string): string {
  const trimmed = trim(path);
  const cleaned = cleanPath(trimmed.startsWith("./") ? trimmed.slice(2) : trimmed);
  return cleaned === "." || cleaned === "/" ? "" : cleaned;
}

function trimAngles(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === "<" || value[start] === ">")) start += 1;
  while (end > start && (value[end - 1] === "<" || value[end - 1] === ">")) end -= 1;
  return value.slice(start, end);
}

/** Rust's `to_ascii_lowercase().ends_with(".md")`. */
function endsWithMd(value: string): boolean {
  return /\.[mM][dD]$/u.test(value);
}

export function trimMdExtension(value: string): string {
  return endsWithMd(value) ? value.slice(0, -3) : value;
}

export function splitTargetSuffix(target: string): readonly [string, string] {
  const index = target.indexOf("#");
  return index < 0 ? [target, ""] : [target.slice(0, index), target.slice(index)];
}

export function normalizeDocumentName(value: string): string {
  const stripped = trimAngles(trim(value));
  if (stripped === "") return "";
  const [base] = splitTargetSuffix(stripped);
  const clean = cleanPath(base.startsWith("./") ? base.slice(2) : base);
  const last = clean.slice(clean.lastIndexOf("/") + 1);
  return trim(trimMdExtension(last)).normalize("NFC");
}

export function documentKey(value: string): string {
  return normalizeDocumentName(value).toLowerCase();
}

export function documentPathKey(relPath: string): string {
  return trimMdExtension(cleanRelPath(relPath)).normalize("NFC").toLowerCase();
}

export function joinSlash(a: string, b: string): string {
  return a === "" ? b : `${a}/${b}`;
}

export function resolveTargetRel(sourceDir: string, rawTarget: string): string {
  return sourceDir === "" || sourceDir === "."
    ? cleanRelPath(rawTarget)
    : cleanRelPath(joinSlash(sourceDir, rawTarget));
}

export function lastSegment(relPath: string): string {
  const cleaned = cleanRelPath(relPath);
  return cleaned.slice(cleaned.lastIndexOf("/") + 1);
}

export function dirSegment(relPath: string): string {
  const cleaned = cleanRelPath(relPath);
  const slash = cleaned.lastIndexOf("/");
  return slash < 0 ? "" : cleaned.slice(0, slash);
}

// --- front matter -----------------------------------------------------------

export function splitKeyValue(line: string): readonly [string, string] | undefined {
  const index = line.indexOf(":");
  return index < 0 ? undefined : [trim(line.slice(0, index)), trim(line.slice(index + 1))];
}

export function trimYamlScalar(value: string): string {
  const trimmed = trim(value);
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Index of the closing `---` line when `lines` open with front matter. */
export function frontMatterEnd(lines: readonly { text: string }[]): number | undefined {
  if (lines[0] === undefined || trimLine(lines[0].text) !== "---") return undefined;
  for (let index = 1; index < lines.length; index += 1) {
    if (trimLine(lines[index]?.text ?? "") === "---") return index;
  }
  return undefined;
}

const NO_FRONT_MATTER: FrontMatter = { present: false, bodyOffset: 0, title: "", aliases: [] };

function addAliases(aliases: string[], parsed: readonly string[]): void {
  for (const alias of parsed) {
    if (alias !== "" && !aliases.includes(alias)) aliases.push(alias);
  }
}

export function parseFrontMatter(content: string): FrontMatter {
  const lines = scanLines(content);
  const end = frontMatterEnd(lines);
  if (end === undefined) return NO_FRONT_MATTER;
  let title = "";
  const aliases: string[] = [];
  for (let index = 1; index < end; index += 1) {
    const line = trimLine(lines[index]?.text ?? "");
    if (line === "" || startsIndented(line)) continue;
    const pair = splitKeyValue(line);
    if (pair === undefined) continue;
    if (pair[0] === "title") title = trimYamlScalar(pair[1]);
    if (pair[0] !== "aliases") continue;
    const parsed = parseAliases(lines, index, end, pair[1]);
    addAliases(aliases, parsed.aliases);
    index = parsed.next;
  }
  return { present: true, bodyOffset: lines[end]?.end ?? content.length, title, aliases };
}

function parseAliases(
  lines: readonly { text: string }[],
  start: number,
  end: number,
  value: string,
): { aliases: string[]; next: number } {
  const trimmed = trim(value);
  if (trimmed === "") {
    const aliases: string[] = [];
    let next = start;
    for (let index = start + 1; index < end; index += 1) {
      const text = trimLine(lines[index]?.text ?? "");
      if (text === "") {
        next = index;
        continue;
      }
      if (!startsIndented(text)) break;
      const item = trim(text);
      if (item.startsWith("- ")) aliases.push(trimYamlScalar(trim(item.slice(2))));
      next = index;
    }
    return { aliases, next };
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { aliases: parseInlineList(trimmed), next: start };
  }
  return { aliases: [trimYamlScalar(trimmed)], next: start };
}

function parseInlineList(value: string): string[] {
  const inner = trim(value.slice(1, -1));
  if (inner === "") return [];
  const items: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const character of inner) {
    if (quote === undefined && (character === "'" || character === '"')) {
      quote = character;
      current += character;
    } else if (quote === character) {
      quote = undefined;
      current += character;
    } else if (quote === undefined && character === ",") {
      items.push(trimYamlScalar(trim(current)));
      current = "";
    } else {
      current += character;
    }
  }
  if (current !== "") items.push(trimYamlScalar(trim(current)));
  return items;
}

function firstPreviewLine(content: string, frontMatter: FrontMatter): string {
  const fences = new FenceState();
  for (const line of scanLines(content.slice(frontMatter.bodyOffset))) {
    const trimmed = trim(trimLine(line.text));
    if (fences.fence(trimmed)) continue;
    if (fences.inside || trimmed === "" || trimmed.startsWith("#")) continue;
    return normalizePreviewLine(trimmed);
  }
  return "";
}

// --- links ------------------------------------------------------------------

export interface WikiLinkParts {
  readonly target: string;
  readonly label: string;
  readonly hasLabel: boolean;
  readonly escaped: boolean;
}

export function splitWikiLinkParts(inner: string): WikiLinkParts {
  const pipe = inner.indexOf("|");
  if (pipe < 0) return { target: inner, label: "", hasLabel: false, escaped: false };
  let slashes = 0;
  while (pipe - slashes > 0 && inner[pipe - slashes - 1] === "\\") slashes += 1;
  if (slashes % 2 === 1) {
    return {
      target: inner.slice(0, pipe - 1),
      label: inner.slice(pipe + 1),
      hasLabel: true,
      escaped: true,
    };
  }
  return {
    target: inner.slice(0, pipe),
    label: inner.slice(pipe + 1),
    hasLabel: true,
    escaped: false,
  };
}

export function wrapWikiLink(target: string, parts: WikiLinkParts): string {
  if (!parts.hasLabel) return `[[${target}]]`;
  return parts.escaped ? `[[${target}\\|${parts.label}]]` : `[[${target}|${parts.label}]]`;
}

function trimTabsAndSpacesStart(value: string): string {
  let start = 0;
  while (value[start] === " " || value[start] === "\t") start += 1;
  return value.slice(start);
}

/** A Markdown destination's document target and where it starts within the destination. */
export function markdownTargetSpan(
  destination: string,
): { readonly target: string; readonly offset: number } | undefined {
  const dest = trimTabsAndSpacesStart(destination);
  if (dest === "") return undefined;
  let start = destination.length - dest.length;
  let inner: string;
  if (dest.startsWith("<")) {
    const close = dest.indexOf(">", 1);
    if (close < 0) return undefined;
    inner = dest.slice(1, close);
    start += 1;
  } else {
    inner = dest.split(/[ \t]/u)[0] ?? "";
  }
  const target = trim(inner);
  if (
    target === "" ||
    target.startsWith("#") ||
    target.includes("://") ||
    target.startsWith("mailto:")
  ) {
    return undefined;
  }
  return { target, offset: start + inner.length - trimStart(inner).length };
}

function parseMarkdownTarget(destination: string): string | undefined {
  return markdownTargetSpan(destination)?.target;
}

function displayTarget(base: string): string {
  const name = normalizeDocumentName(base);
  return name === "" ? trim(base) : name;
}

export function rawLinkTarget(base: string): string {
  return trim(splitTargetSuffix(trim(trimAngles(trim(base))))[0]);
}

function link(kind: LinkKind, target: string): ParsedLink | undefined {
  const [base, suffix] = splitTargetSuffix(target);
  const targetKey = documentKey(base);
  if (targetKey === "") return undefined;
  return {
    kind,
    displayTarget: `${displayTarget(base)}${suffix}`,
    targetKey,
    rawTarget: rawLinkTarget(base),
    context: "",
  };
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

/** `[[…]]` spans of a masked line, with their inner text. */
export function* wikiSpans(masked: string): Generator<Span & { readonly inner: string }> {
  for (let start = masked.indexOf("[["); start >= 0 && start + 3 < masked.length; ) {
    const end = masked.indexOf("]]", start + 2);
    if (end < 0) {
      start = masked.indexOf("[[", start + 1);
      continue;
    }
    yield { start, end: end + 2, inner: masked.slice(start + 2, end) };
    start = masked.indexOf("[[", end + 2);
  }
}

/**
 * `[label](destination)` spans; `skipImages` decides whether `![…](…)` is
 * skipped whole (flagged as an image) or its `!` is simply passed over.
 * Equivalent to scanning character by character, jumping between `[`s.
 */
export function* markdownSpans(
  masked: string,
  skipImages: boolean,
): Generator<Span & { readonly labelEnd: number; readonly image: boolean }> {
  let index = 0;
  for (let open = masked.indexOf("["); open >= 0; open = masked.indexOf("[", index)) {
    const span = linkSpanAt(masked, open);
    if (span === undefined) {
      index = open + 1;
      continue;
    }
    // A `!` the scan has not passed yet opens an image here.
    const image = skipImages && open - 1 >= index && masked[open - 1] === "!";
    yield { ...span, image };
    index = span.end;
  }
}

/** The `[label](destination)` starting at `start`, if one does. */
function linkSpanAt(masked: string, start: number): (Span & { labelEnd: number }) | undefined {
  if (masked[start] !== "[") return undefined;
  const labelEnd = masked.indexOf("]", start + 1);
  if (labelEnd < 0 || masked[labelEnd + 1] !== "(") return undefined;
  const destinationEnd = masked.indexOf(")", labelEnd + 2);
  return destinationEnd < 0 ? undefined : { start, end: destinationEnd + 1, labelEnd };
}

function parseLinksInLine(line: string, context: string): ParsedLink[] {
  const masked = maskInlineCode(line);
  const links: ParsedLink[] = [];
  for (const span of wikiSpans(masked)) {
    const parsed = link("wiki", trim(splitWikiLinkParts(span.inner).target));
    if (parsed !== undefined) links.push({ ...parsed, context });
  }
  for (const span of markdownSpans(masked, true)) {
    if (span.image) continue;
    const target = parseMarkdownTarget(masked.slice(span.labelEnd + 2, span.end - 1));
    const parsed = target === undefined ? undefined : link("markdown", target);
    if (parsed !== undefined) links.push({ ...parsed, context });
  }
  return links;
}

function documentLinkSpans(line: string): Span[] {
  const masked = maskInlineCode(line);
  const spans: Span[] = [];
  for (const span of wikiSpans(masked)) {
    const [base] = splitTargetSuffix(trim(splitWikiLinkParts(span.inner).target));
    if (documentKey(base) !== "") spans.push(span);
  }
  for (const span of markdownSpans(masked, false)) {
    const target = parseMarkdownTarget(masked.slice(span.labelEnd + 2, span.end - 1));
    if (target !== undefined && documentKey(splitTargetSuffix(target)[0]) !== "") spans.push(span);
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

function isLinkOnlyLine(line: string): boolean {
  const spans = documentLinkSpans(line);
  const [span] = spans;
  if (span === undefined || spans.length !== 1) return false;
  const { start, end } = span;
  const rest = line.slice(0, start) + " ".repeat(end - start) + line.slice(end);
  return !containsLetterOrDigit(stripLineOnlyMarkdown(rest));
}

/** The keys `awiki rename` compares in one line, before it decides to rewrite. */
function rewriteKeysInLine(line: string, keys: Set<string>): void {
  const masked = maskInlineCode(line);
  for (const span of wikiSpans(masked)) {
    keys.add(
      documentKey(
        splitTargetSuffix(
          trim(splitWikiLinkParts(line.slice(span.start + 2, span.end - 2)).target),
        )[0],
      ),
    );
  }
  for (const span of markdownSpans(masked, false)) {
    const target = parseMarkdownTarget(line.slice(span.labelEnd + 2, span.end - 1));
    if (target !== undefined) keys.add(documentKey(target));
  }
}

function countNewlines(value: string): number {
  let count = 0;
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

export function parsePage(content: string): ParsedPage {
  const frontMatter = parseFrontMatter(content);
  const links: ParsedLink[] = [];
  const linkOnly: LinkOnlyLine[] = [];
  const rewriteKeys = new Set<string>();
  const head = content.slice(0, frontMatter.bodyOffset);
  if (frontMatter.present) {
    for (const line of scanLines(head)) {
      links.push(...parseLinksInLine(line.text, normalizePreviewLine(trimLine(line.text))));
      rewriteKeysInLine(line.text, rewriteKeys);
    }
  }
  const bodyStartLine = countNewlines(head);
  const fences = new FenceState();
  let visibleLines = 0;
  let words = 0;
  scanLines(content.slice(frontMatter.bodyOffset)).forEach((line, index) => {
    const trimmed = trim(trimLine(line.text));
    if (fences.fence(trimmed) || fences.inside) return;
    rewriteKeysInLine(line.text, rewriteKeys);
    if (trimmed === "") return;
    const { text: context, words: lineWords } = normalizeCounting(trimmed);
    visibleLines += 1;
    words += lineWords;
    const parsed = parseLinksInLine(line.text, context);
    if (parsed.length === 1 && isLinkOnlyLine(trimmed)) {
      linkOnly.push({ line: bodyStartLine + index + 1, text: trimmed });
    }
    links.push(...parsed);
  });
  rewriteKeys.delete("");
  return {
    frontMatter,
    links,
    linkOnly,
    excerpt: firstPreviewLine(content, frontMatter),
    rewriteKeys,
    visibleLines,
    words,
  };
}

/** The visible body text `suggest` measures, one normalized line per line. */
export function visibleMarkdownText(content: string, bodyOffset: number): string {
  let out = "";
  const fences = new FenceState();
  for (const line of scanLines(content.slice(bodyOffset))) {
    const trimmed = trim(trimLine(line.text));
    if (fences.fence(trimmed) || fences.inside || trimmed === "") continue;
    out += `${normalizePreviewLine(trimmed)}\n`;
  }
  return out;
}
