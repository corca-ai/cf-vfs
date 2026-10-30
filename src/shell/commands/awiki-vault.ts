import { isVfsError, VfsError } from "../../core/errors.js";
import type { VfsStat } from "../../vfs/types.js";
import { shellModeAllows } from "../access.js";
import { openContent } from "../content.js";
import { fileSystemOrigin } from "../fs-origin.js";
import type { ShellCommandContext } from "../types.js";
import {
  cleanRelPath,
  dirSegment,
  documentKey,
  documentPathKey,
  lastSegment,
  type ParsedPage,
  parsePage,
  resolveTargetRel,
  trimMdExtension,
} from "./awiki-parse.js";
import { compareText, debugQuote, lower } from "./awiki-text.js";
import { collectStream } from "./helpers.js";

/** An `awiki` failure, printed as `awiki: MESSAGE` with status 1. */
export class AwikiError extends Error {}

export interface Document {
  readonly name: string;
  readonly key: string;
  readonly path: string;
  readonly relPath: string;
  /** The entry identity and token the page was parsed at. */
  readonly ino: number;
  readonly token: string;
  readonly sizeBytes: number;
  readonly page: ParsedPage;
  /** The document each of `page.links` resolves to, by index. */
  readonly resolved: (number | undefined)[];
}

// --- the per-file cache -----------------------------------------------------

interface CachedPage {
  readonly ino: number;
  readonly token: string;
  readonly sizeBytes: number;
  readonly page: ParsedPage;
}

/**
 * Parsed pages keyed by path for one filesystem owner, valid while the entry
 * keeps its identity and mutation token. Only what a page's own text decides
 * is kept, so a hit is exactly what parsing again would produce.
 */
const CACHE_CAPACITY = 16_384;
const caches = new WeakMap<object, Map<string, CachedPage>>();

function cacheFor(context: ShellCommandContext): Map<string, CachedPage> {
  const origin = fileSystemOrigin(context.fileSystem);
  let cache = caches.get(origin);
  if (cache === undefined) {
    cache = new Map();
    caches.set(origin, cache);
  }
  return cache;
}

/** The OS error text Rust prints for the filesystem failures a load can meet. */
export function osError(error: unknown): AwikiError | unknown {
  if (!isVfsError(error)) return error;
  const text: Record<string, string> = {
    ENOENT: "No such file or directory (os error 2)",
    ENOTDIR: "Not a directory (os error 20)",
    EACCES: "Permission denied (os error 13)",
    EPERM: "Operation not permitted (os error 1)",
    EISDIR: "Is a directory (os error 21)",
    ELOOP: "Too many levels of symbolic links (os error 40)",
  };
  const message = text[error.code];
  return message === undefined ? error : new AwikiError(message);
}

const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A page's text as Rust's `read_to_string` gives it: strict UTF-8, BOM kept. */
export async function readContent(
  context: ShellCommandContext,
  path: string,
): Promise<{ stat: VfsStat; content: string }> {
  let body: Awaited<ReturnType<typeof openContent>>;
  try {
    body = await openContent(context.fileSystem, path, {
      reader: context.content,
      access: context.policy.opaqueContent,
      signal: context.signal,
    });
  } catch (error) {
    throw osError(error);
  }
  const bytes = await collectStream(context, body.stream);
  try {
    return { stat: body.stat, content: DECODER.decode(bytes.value) };
  } catch {
    throw new AwikiError(`${path}: stream did not contain valid UTF-8`);
  } finally {
    bytes.release();
  }
}

/** Reads and parses a page, caching what an inline body yields. */
async function parseFresh(context: ShellCommandContext, path: string): Promise<CachedPage> {
  const cache = cacheFor(context);
  const { stat, content } = await readContent(context, path);
  const read: CachedPage = {
    ino: stat.ino,
    token: stat.mutationToken,
    sizeBytes: stat.sizeBytes,
    page: parsePage(content),
  };
  if (stat.contentClass === "inline" && (cache.size < CACHE_CAPACITY || cache.has(path))) {
    cache.set(path, read);
  }
  return read;
}

/**
 * A page through the cache, trusting the listing's identity and token.
 *
 * Only where no collaborative overlay can stand between the listing and a
 * read, and only when the execution's credentials could read the page: any
 * doubt reads it, so a miss reports exactly what a cold run would.
 */
async function listedPage(context: ShellCommandContext, file: Found): Promise<CachedPage> {
  const cached = cacheFor(context).get(file.path);
  const { stat } = file;
  if (
    cached?.ino === stat.ino &&
    cached.token === stat.mutationToken &&
    stat.contentClass === "inline" &&
    file.searchable &&
    shellModeAllows(stat, context.session.credentials, READ)
  ) {
    // Charge what a cold read would, so limits never depend on the cache.
    context.budget.read(stat.sizeBytes);
    return cached;
  }
  return await parseFresh(context, file.path);
}

/** A page through the cache, asking the page itself for its current token. */
async function probedPage(context: ShellCommandContext, path: string): Promise<CachedPage> {
  let probe: VfsStat | undefined;
  try {
    // A read at EOF authorizes access and reports current overlay metadata
    // without moving the body; statting would bypass read permission.
    const read = context.fileSystem.readFile(path, { range: { offset: Number.MAX_SAFE_INTEGER } });
    await read.stream.cancel();
    probe = read.stat;
  } catch (error) {
    if (!isVfsError(error) || error.code !== "ENOTSUP") throw osError(error);
  }
  const cached = cacheFor(context).get(path);
  if (probe !== undefined && cached?.ino === probe.ino && cached.token === probe.mutationToken) {
    context.budget.read(probe.sizeBytes);
    return cached;
  }
  return await parseFresh(context, path);
}

// --- discovery --------------------------------------------------------------

function isMarkdown(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && /^[mM][dD]$/u.test(name.slice(dot + 1));
}

function isIgnoredDirectory(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "target" || name === "vendor";
}

function listAll(context: ShellCommandContext, directory: string): VfsStat[] {
  const entries: VfsStat[] = [];
  let cursor: string | null = null;
  try {
    do {
      context.budget.step();
      const page = context.fileSystem.listPage(directory, cursor === null ? {} : { cursor });
      context.budget.expansionWork(page.scanned);
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor !== null);
  } catch (error) {
    throw osError(error);
  }
  return entries;
}

const READ = 4;
const SEARCH = 1;

interface Found {
  readonly path: string;
  readonly relFile: string;
  /** The page's metadata as the listing reported it. */
  readonly stat: VfsStat;
  /** Whether every directory from the root down to the page may be searched. */
  readonly searchable: boolean;
}

function discover(context: ShellCommandContext, root: VfsStat, recursive: boolean): Found[] {
  const found: Found[] = [];
  const credentials = context.session.credentials;
  const stack = [{ stat: root, searchable: shellModeAllows(root, credentials, SEARCH) }];
  const prefix = root.path === "/" ? 1 : root.path.length + 1;
  for (let directory = stack.pop(); directory !== undefined; directory = stack.pop()) {
    const { searchable } = directory;
    for (const entry of listAll(context, directory.stat.path)) {
      if (entry.kind === "file" && isMarkdown(entry.name)) {
        found.push({
          path: entry.path,
          relFile: entry.path.slice(prefix),
          stat: entry,
          searchable,
        });
      }
      if (recursive && entry.kind === "directory" && !isIgnoredDirectory(entry.name)) {
        stack.push({
          stat: entry,
          searchable: searchable && shellModeAllows(entry, credentials, SEARCH),
        });
      }
    }
  }
  return found;
}

/** `items` stably ordered by the lowercase of `key`, lowercasing each once. */
function sortByLower<T>(items: readonly T[], key: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, sortKey: lower(key(item)) }))
    .sort((a, b) => compareText(a.sortKey, b.sortKey))
    .map(({ item }) => item);
}

// --- the vault --------------------------------------------------------------

export class Vault {
  readonly identifiers = new Map<string, number[]>();
  readonly basenames = new Map<string, number[]>();
  readonly directed: Set<number>[];
  readonly inbound: Set<number>[];
  readonly neighbors: number[][];
  private readonly docsByKey = new Map<string, number>();
  /** Lowercased names and paths, computed once: sorting compares them often. */
  private readonly lowerNames: string[];
  private readonly lowerPaths: string[];

  private constructor(
    readonly root: string,
    readonly recursive: boolean,
    readonly documents: Document[],
  ) {
    for (const [index, document] of documents.entries()) {
      if (this.docsByKey.has(document.key)) {
        throw new AwikiError(`duplicate document names ${debugQuote(document.relPath)}`);
      }
      this.docsByKey.set(document.key, index);
    }
    const count = documents.length;
    this.lowerNames = documents.map((document) => lower(document.name));
    this.lowerPaths = documents.map((document) => lower(document.relPath));
    this.directed = Array.from({ length: count }, () => new Set());
    this.inbound = Array.from({ length: count }, () => new Set());
    const undirected: Set<number>[] = Array.from({ length: count }, () => new Set());
    this.buildIdentifiers();
    this.buildBasenames();
    for (let source = 0; source < count; source += 1) {
      const document = this.doc(source);
      const directed = this.directed[source] ?? new Set<number>();
      const sourceDir = dirSegment(document.relPath);
      document.page.links.forEach((link, index) => {
        const target = this.resolveLink(sourceDir, link.kind, link.rawTarget, link.targetKey);
        document.resolved[index] = target;
        if (target === undefined || target === source || directed.has(target)) return;
        directed.add(target);
        this.inboundOf(target).add(source);
        undirected[source]?.add(target);
        undirected[target]?.add(source);
      });
    }
    this.neighbors = undirected.map((set) => this.sortDocuments([...set]));
  }

  static async load(
    context: ShellCommandContext,
    root: string,
    recursive: boolean,
  ): Promise<Vault> {
    let rootStat: VfsStat;
    try {
      rootStat = context.fileSystem.stat(context.fileSystem.realpath(root));
      if (rootStat.kind !== "directory") {
        throw new VfsError("ENOTDIR", "not a directory", rootStat.path);
      }
    } catch (error) {
      throw osError(error);
    }
    const resolvedRoot = rootStat.path;
    // Without a collaborative overlay below the root, a listing reports what a
    // read would, and its tokens can validate the cache without a read per page.
    const trustListing =
      context.fileSystem.canUseBulkOperation?.("copy-source", resolvedRoot) === true;
    const files = sortByLower(discover(context, rootStat, recursive), (file) => file.relFile);
    const documents: Document[] = [];
    for (const file of files) {
      context.budget.checkDeadline();
      const relPath = trimMdExtension(file.relFile);
      const { page, ino, token, sizeBytes } = trustListing
        ? await listedPage(context, file)
        : await probedPage(context, file.path);
      documents.push({
        ino,
        token,
        sizeBytes,
        name: recursive ? relPath : lastSegment(relPath),
        key: recursive ? documentPathKey(relPath) : documentKey(relPath),
        path: file.path,
        relPath,
        page,
        resolved: [],
      });
    }
    return new Vault(
      resolvedRoot,
      recursive,
      sortByLower(documents, (document) => document.relPath),
    );
  }

  doc(index: number): Document {
    const document = this.documents[index];
    if (document === undefined) throw new RangeError(`no document ${index}`);
    return document;
  }

  neighborsOf(index: number): readonly number[] {
    return this.neighbors[index] ?? [];
  }

  inboundOf(index: number): Set<number> {
    const inbound = this.inbound[index];
    if (inbound === undefined) throw new RangeError(`no document ${index}`);
    return inbound;
  }

  /** Orders documents by lowercase name, as every listing does. */
  compareDocuments(a: number, b: number): number {
    return compareText(this.lowerNames[a] ?? "", this.lowerNames[b] ?? "");
  }

  sortDocuments(indices: number[]): number[] {
    return indices.sort((a, b) => this.compareDocuments(a, b));
  }

  private buildIdentifiers(): void {
    this.documents.forEach((document, index) => {
      const { title, aliases } = document.page.frontMatter;
      for (const id of [document.name, ...(title === "" ? [] : [title]), ...aliases]) {
        const key = documentKey(id);
        if (key === "") continue;
        const list = this.identifiers.get(key);
        if (list === undefined) this.identifiers.set(key, [index]);
        else list.push(index);
      }
    });
  }

  private buildBasenames(): void {
    this.documents.forEach((document, index) => {
      const key = documentKey(lastSegment(document.relPath));
      if (key === "") return;
      const list = this.basenames.get(key);
      if (list === undefined) this.basenames.set(key, [index]);
      else list.push(index);
    });
    const depth = (index: number) => this.doc(index).relPath.split("/").length - 1;
    for (const list of this.basenames.values()) {
      list.sort(
        (a, b) =>
          depth(a) - depth(b) || compareText(this.lowerPaths[a] ?? "", this.lowerPaths[b] ?? ""),
      );
    }
  }

  private byPath(relPath: string): number | undefined {
    return this.docsByKey.get(documentPathKey(relPath));
  }

  resolveLink(
    sourceDir: string,
    kind: "wiki" | "markdown",
    rawTarget: string,
    baseKey: string,
  ): number | undefined {
    if (!this.recursive) return this.docsByKey.get(baseKey);
    if (kind === "markdown" || rawTarget.startsWith("./") || rawTarget.startsWith("../")) {
      return this.byPath(resolveTargetRel(sourceDir, rawTarget));
    }
    if (rawTarget.includes("/") || rawTarget.includes("\\")) {
      return (
        this.byPath(cleanRelPath(rawTarget)) ?? this.byPath(resolveTargetRel(sourceDir, rawTarget))
      );
    }
    return this.basenames.get(baseKey)?.[0];
  }

  resolveDocument(identifier: string): number {
    const direct = this.docsByKey.get(
      this.recursive ? documentPathKey(identifier) : documentKey(identifier),
    );
    if (direct !== undefined) return direct;
    const key = documentKey(identifier);
    if (key === "") throw new AwikiError(`document ${debugQuote(identifier)} not found`);
    if (!this.recursive) {
      const flat = this.docsByKey.get(key);
      if (flat !== undefined) return flat;
    }
    const [first, second] = new Set(this.identifiers.get(key) ?? []);
    if (first === undefined) throw new AwikiError(`document ${debugQuote(identifier)} not found`);
    if (second !== undefined) {
      throw new AwikiError(`document identifier ${debugQuote(identifier)} is ambiguous`);
    }
    return first;
  }

  /** Documents ordered by lowercase name joined with NUL, for path tie-breaks. */
  pathSortKey(path: readonly number[]): string {
    return path.map((index) => lower(this.doc(index).name)).join("\0");
  }

  comparePaths(a: readonly number[], b: readonly number[]): number {
    return b.length - a.length || compareText(this.pathSortKey(a), this.pathSortKey(b));
  }
}
