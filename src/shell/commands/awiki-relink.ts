import {
  dirSegment,
  documentKey,
  type LinkKind,
  lastSegment,
  markdownSpans,
  markdownTargetSpan,
  parseFrontMatter,
  rawLinkTarget,
  splitTargetSuffix,
  splitWikiLinkParts,
  wikiSpans,
  wrapWikiLink,
} from "./awiki-parse.js";
import {
  compareText,
  FenceState,
  lower,
  maskInlineCode,
  scanLines,
  trim,
  trimLine,
} from "./awiki-text.js";
import type { Vault } from "./awiki-vault.js";

/**
 * Rewrites the links that point at a renamed document, as awiki 0.5.1 does.
 * In a flat vault a link matches by name. In a recursive vault it matches only
 * when it resolves to the document; relative links are recomputed from their
 * source, path links stay paths, and a bare link stays bare while the new name
 * still resolves to the document. Images and fenced code are left alone.
 */

export interface RenameTarget {
  readonly doc: number;
  readonly oldKey: string;
  readonly newBase: string;
  readonly newRel: string;
}

type TargetForm = "bare" | "absolute" | "relative";

function endsWithMd(value: string): boolean {
  return /\.[mM][dD]$/u.test(value);
}

/** `to`, a repo-relative path, written relative to the directory `fromDir`. */
function relativePath(fromDir: string, to: string): string {
  const from = fromDir.split("/").filter((part) => part !== "");
  const target = to.split("/").filter((part) => part !== "");
  let common = 0;
  while (
    common < from.length &&
    common < target.length - 1 &&
    lower(from[common] ?? "") === lower(target[common] ?? "")
  ) {
    common += 1;
  }
  return [...Array<string>(from.length - common).fill(".."), ...target.slice(common)].join("/");
}

function replacePathBase(base: string, newName: string): string {
  const slash = base.lastIndexOf("/");
  const directory = slash < 0 ? "" : base.slice(0, slash + 1);
  const file = slash < 0 ? base : base.slice(slash + 1);
  return `${directory}${newName}${endsWithMd(file) ? ".md" : ""}`;
}

function targetForm(raw: string): TargetForm {
  if (raw.startsWith("./") || raw.startsWith("../")) return "relative";
  return raw.includes("/") || raw.includes("\\") ? "absolute" : "bare";
}

export class Relinker {
  private readonly bareResolves: boolean;

  constructor(
    private readonly vault: Vault,
    private readonly target: RenameTarget,
  ) {
    this.bareResolves = this.bareNameResolves();
  }

  /** Whether, once renamed, the document wins a bare-name lookup: shortest path, then first path. */
  private bareNameResolves(): boolean {
    const { newRel, doc } = this.target;
    const key = documentKey(lastSegment(newRel));
    const depth = (rel: string) => rel.split("/").length - 1;
    return this.vault.documents.every(
      (document, index) =>
        index === doc ||
        documentKey(lastSegment(document.relPath)) !== key ||
        depth(document.relPath) > depth(newRel) ||
        (depth(document.relPath) === depth(newRel) &&
          compareText(lower(document.relPath), lower(newRel)) > 0),
    );
  }

  private sourceDir(source: number): string {
    return dirSegment(this.vault.doc(source).relPath);
  }

  private linksTo(source: number, kind: LinkKind, raw: string): boolean {
    const key = documentKey(raw);
    if (!this.vault.recursive) return key === this.target.oldKey;
    return this.vault.resolveLink(this.sourceDir(source), kind, raw, key) === this.target.doc;
  }

  private newWikiTarget(source: number, form: TargetForm): string {
    const { newBase, newRel } = this.target;
    if (!this.vault.recursive) return newBase;
    if (form === "relative") {
      const path = relativePath(this.sourceDir(source), newRel);
      return path.startsWith("../") ? path : `./${path}`;
    }
    return form === "bare" && this.bareResolves ? newBase : newRel;
  }

  private newMarkdownTarget(source: number, base: string): string {
    if (!this.vault.recursive) return replacePathBase(base, this.target.newBase);
    const path = relativePath(this.sourceDir(source), this.target.newRel);
    const prefixed = base.startsWith("./") && !path.startsWith("../") ? `./${path}` : path;
    return `${prefixed}${endsWithMd(base) ? ".md" : ""}`;
  }

  private rewriteWikiLine(line: string, source: number): [string, number] {
    let out = "";
    let last = 0;
    let changes = 0;
    for (const span of wikiSpans(maskInlineCode(line))) {
      const parts = splitWikiLinkParts(line.slice(span.start + 2, span.end - 2));
      const [base, suffix] = splitTargetSuffix(trim(parts.target));
      const raw = rawLinkTarget(base);
      if (!this.linksTo(source, "wiki", raw)) continue;
      const target = `${this.newWikiTarget(source, targetForm(raw))}${endsWithMd(trim(base)) ? ".md" : ""}${suffix}`;
      out += line.slice(last, span.start) + wrapWikiLink(target, parts);
      last = span.end;
      changes += 1;
    }
    return changes === 0 ? [line, 0] : [out + line.slice(last), changes];
  }

  private rewriteMarkdownLine(line: string, source: number): [string, number] {
    let out = "";
    let last = 0;
    let changes = 0;
    for (const span of markdownSpans(maskInlineCode(line), true)) {
      const destinationStart = span.labelEnd + 2;
      const found = span.image
        ? undefined
        : markdownTargetSpan(line.slice(destinationStart, span.end - 1));
      if (found === undefined) continue;
      const [base, suffix] = splitTargetSuffix(found.target);
      if (!this.linksTo(source, "markdown", trim(base))) continue;
      const start = destinationStart + found.offset;
      out +=
        line.slice(last, start) +
        this.newMarkdownTarget(source, base) +
        suffix +
        line.slice(start + found.target.length, span.end);
      last = span.end;
      changes += 1;
    }
    return changes === 0 ? [line, 0] : [out + line.slice(last), changes];
  }

  /** Rewrites one page's links to the renamed document, outside fenced code. */
  rewrite(content: string, source: number): [string, number] {
    const bodyOffset = parseFrontMatter(content).bodyOffset;
    const fences = new FenceState();
    let out = "";
    let changes = 0;
    for (const scanned of scanLines(content)) {
      const inBody = scanned.end > bodyOffset;
      if (inBody && (fences.fence(trim(trimLine(scanned.text))) || fences.inside)) {
        out += scanned.text;
        continue;
      }
      const [wiki, wikiChanges] = this.rewriteWikiLine(scanned.text, source);
      const [line, markdownChanges] = this.rewriteMarkdownLine(wiki, source);
      changes += wikiChanges + markdownChanges;
      out += line;
    }
    return [out, changes];
  }
}
