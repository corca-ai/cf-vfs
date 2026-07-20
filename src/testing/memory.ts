import {
  countNewlines,
  decodeUtf8,
  headBytes,
  headLines,
  tailBytes,
  tailLines,
} from "../core/bytes.js";
import { VfsError } from "../core/errors.js";
import { matchesGlob } from "../core/glob.js";
import {
  matchesFindPage,
  resolveFindCursor,
  resolveListCursor,
  resolvePageLimit,
  scanPage,
} from "../core/pagination.js";
import {
  basename,
  compareUtf8,
  dirname,
  isDescendant,
  normalizePath,
  pathRequiresDirectory,
} from "../core/path.js";
import { replaceContent, searchContent } from "../core/search.js";
import type {
  AppendTextOptions,
  EntryPage,
  FindOptions,
  FindPageOptions,
  MetadataUpdateOptions,
  MoveOptions,
  MoveResult,
  PageOptions,
  RegexEngine,
  RemoveOptions,
  RemoveResult,
  ReplaceTextOptions,
  ReplaceTextResult,
  TextReadResult,
  TextSearchOptions,
  TextSearchResult,
  TextSliceOptions,
  TouchOptions,
  VfsStat,
  VirtualFileSystem,
  WriteResult,
  WriteTextOptions,
} from "../core/types.js";

interface MemoryEntry {
  stat: VfsStat;
  text?: string;
}

export class MemoryFileSystem implements VirtualFileSystem {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly regexEngine: RegexEngine | undefined;
  private readonly maxTextFileBytes: number;
  private clock = 1;

  constructor(options: { regexEngine?: RegexEngine; maxTextFileBytes?: number } = {}) {
    this.regexEngine = options.regexEngine;
    this.maxTextFileBytes = options.maxTextFileBytes ?? Number.POSITIVE_INFINITY;
    this.entries.set("/", {
      stat: {
        path: "/",
        parentPath: "/",
        name: "/",
        kind: "directory",
        contentKind: null,
        sizeBytes: 0,
        lineCount: 0,
        mode: 0o040755,
        createdAtMs: 0,
        modifiedAtMs: 0,
        revision: 1,
      },
    });
  }

  private now(): number {
    return this.clock++;
  }

  private entry(path: string): MemoryEntry {
    const normalized = normalizePath(path);
    const entry = this.entries.get(normalized);
    if (!entry) throw new VfsError("ENOENT", "no such file or directory", normalized);
    return entry;
  }

  private normalizeAccessPath(path: string, allowMissingDirectory = false): string {
    const normalized = normalizePath(path);
    if (!pathRequiresDirectory(path) || normalized === "/") return normalized;
    const entry = this.entries.get(normalized);
    if (!entry) {
      if (allowMissingDirectory) return normalized;
      throw new VfsError("ENOENT", "no such directory", normalized);
    }
    if (entry.stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", normalized);
    return normalized;
  }

  stat(path: string): VfsStat {
    return { ...this.entry(this.normalizeAccessPath(path)).stat };
  }

  list(path: string): VfsStat[] {
    const normalized = this.normalizeAccessPath(path);
    if (this.entry(normalized).stat.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", normalized);
    }
    return [...this.entries.values()]
      .filter((entry) => entry.stat.path !== "/" && entry.stat.parentPath === normalized)
      .map((entry) => ({ ...entry.stat }))
      .sort((left, right) => compareUtf8(left.name, right.name));
  }

  listPage(path: string, options: PageOptions = {}): EntryPage {
    const normalized = this.normalizeAccessPath(path);
    const limit = resolvePageLimit(options.limit);
    const cursor = resolveListCursor(normalized, options.cursor);
    const candidates = this.list(normalized)
      .filter((entry) => cursor === null || compareUtf8(entry.path, cursor) > 0);
    const page = scanPage(candidates, limit);
    return {
      entries: page.candidates,
      nextCursor: page.nextCursor,
      scanned: page.scanned,
    };
  }

  find(options: FindOptions): VfsStat[] {
    const limit = options.limit ?? 10_000;
    const result: VfsStat[] = [];
    let cursor: string | undefined;
    do {
      const page = this.findPage({
        ...options,
        limit: Math.min(limit, 1000),
        ...(cursor === undefined ? {} : { cursor }),
      });
      result.push(...page.entries.slice(0, limit - result.length));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && result.length < limit);
    return result;
  }

  findPage(options: FindPageOptions): EntryPage {
    const root = this.normalizeAccessPath(options.path);
    const rootEntry = this.entry(root);
    const limit = resolvePageLimit(options.limit);
    const cursor = resolveFindCursor(root, options.cursor);
    const raw = [...this.entries.values()]
      .map((entry) => entry.stat)
      .filter((stat) => stat.path === root
        ? cursor === null && (rootEntry.stat.kind === "file" || (options.includeRoot ?? false))
        : isDescendant(root, stat.path))
      .filter((stat) => cursor === null || compareUtf8(stat.path, cursor) > 0)
      .sort((left, right) => compareUtf8(left.path, right.path));
    const page = scanPage(raw, limit);
    return {
      entries: page.candidates
        .filter((stat) => matchesFindPage(root, stat, options))
        .map((stat) => ({ ...stat })),
      nextCursor: page.nextCursor,
      scanned: page.scanned,
    };
  }

  readText(path: string): TextReadResult {
    const entry = this.entry(this.normalizeAccessPath(path));
    if (entry.stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", entry.stat.path);
    if (entry.stat.contentKind !== "text" || entry.text === undefined) {
      throw new VfsError("ENOTTEXT", "file is not a text file", entry.stat.path);
    }
    return { stat: { ...entry.stat }, text: entry.text, bytesRead: entry.stat.sizeBytes };
  }

  readTextHead(path: string, options: TextSliceOptions): TextReadResult {
    const result = this.readText(path);
    const encoded = new TextEncoder().encode(result.text);
    const sliced = options.bytes !== undefined
      ? headBytes(encoded, options.bytes)
      : headLines(encoded, options.lines ?? 10);
    return { ...result, text: decodeUtf8(sliced, result.stat.path), bytesRead: sliced.byteLength };
  }

  readTextTail(path: string, options: TextSliceOptions): TextReadResult {
    const result = this.readText(path);
    const encoded = new TextEncoder().encode(result.text);
    const sliced = options.bytes !== undefined
      ? tailBytes(encoded, options.bytes)
      : tailLines(encoded, options.lines ?? 10);
    return { ...result, text: decodeUtf8(sliced, result.stat.path), bytesRead: sliced.byteLength };
  }

  searchText(options: TextSearchOptions): TextSearchResult {
    const maximum = options.maxResults ?? 1000;
    const matches: TextSearchResult["matches"] = [];
    let filesScanned = 0;
    let bytesScanned = 0;
    const seen = new Set<string>();
    for (const root of options.roots) {
      const normalized = this.normalizeAccessPath(root);
      const candidates = this.entry(normalized).stat.kind === "file"
        ? [this.stat(normalized)]
        : this.find({ path: normalized, type: "file" });
      for (const stat of candidates) {
        if (seen.has(stat.path) || stat.contentKind !== "text") continue;
        seen.add(stat.path);
        if (!matchesGlob(stat.path, options.include)) continue;
        const read = this.readText(stat.path);
        filesScanned += 1;
        bytesScanned += read.bytesRead;
        matches.push(
          ...searchContent(
            stat.path,
            read.text,
            options.pattern,
            options.fixed ?? false,
            options.ignoreCase ?? false,
            this.regexEngine,
            maximum - matches.length,
          ),
        );
        if (matches.length >= maximum) {
          return { matches, filesScanned, bytesScanned, truncated: true };
        }
      }
    }
    return { matches, filesScanned, bytesScanned, truncated: false };
  }

  writeText(path: string, text: string, options: WriteTextOptions = {}): WriteResult {
    const normalized = this.normalizeAccessPath(path);
    const existing = this.entries.get(normalized);
    const disposition = options.disposition ?? "upsert";
    if (disposition === "create" && existing) {
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    if (disposition === "replace" && !existing) {
      throw new VfsError("ENOENT", "no such file", normalized);
    }
    if (existing?.stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (options.ifRevision !== undefined && existing?.stat.revision !== options.ifRevision) {
      throw new VfsError("EREVISION", "file revision does not match", normalized);
    }
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength > this.maxTextFileBytes) {
      throw new VfsError(
        "EFBIG",
        `text exceeds configured ${this.maxTextFileBytes}-byte write limit`,
        normalized,
      );
    }
    if (options.createParents) this.mkdir(dirname(normalized), true);
    const parent = this.entry(dirname(normalized));
    if (parent.stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent.stat.path);
    const now = this.now();
    const stat: VfsStat = {
      path: normalized,
      parentPath: dirname(normalized),
      name: basename(normalized),
      kind: "file",
      contentKind: "text",
      sizeBytes: encoded.byteLength,
      lineCount: countNewlines(encoded),
      mode: options.mode ?? existing?.stat.mode ?? 0o100644,
      createdAtMs: existing?.stat.createdAtMs ?? now,
      modifiedAtMs: now,
      revision: existing ? existing.stat.revision + 1 : 1,
    };
    this.entries.set(normalized, { stat, text });
    return { path: normalized, revision: stat.revision, sizeBytes: stat.sizeBytes, created: !existing };
  }

  appendText(path: string, text: string, options: AppendTextOptions = {}): WriteResult {
    const current = this.readText(path);
    if (options.ifRevision !== undefined && options.ifRevision !== current.stat.revision) {
      throw new VfsError("EREVISION", "file revision does not match", current.stat.path);
    }
    if (text.length === 0) {
      return {
        path: current.stat.path,
        revision: current.stat.revision,
        sizeBytes: current.stat.sizeBytes,
        created: false,
      };
    }
    return this.writeText(current.stat.path, `${current.text}${text}`, {
      ifRevision: current.stat.revision,
      mode: current.stat.mode,
      disposition: "replace",
    });
  }

  setMetadata(path: string, options: MetadataUpdateOptions): VfsStat {
    const entry = this.entry(this.normalizeAccessPath(path));
    if (options.ifRevision !== undefined && options.ifRevision !== entry.stat.revision) {
      throw new VfsError("EREVISION", "file revision does not match", entry.stat.path);
    }
    entry.stat = {
      ...entry.stat,
      mode: options.mode ?? entry.stat.mode,
      modifiedAtMs: options.modifiedAtMs ?? this.now(),
      revision: entry.stat.revision + 1,
    };
    return { ...entry.stat };
  }

  touch(path: string, options: TouchOptions = {}): VfsStat {
    const normalized = this.normalizeAccessPath(path);
    if (this.entries.has(normalized)) return this.setMetadata(normalized, options);
    if (options.create === false) {
      throw new VfsError("ENOENT", "no such file or directory", normalized);
    }
    if (options.ifRevision !== undefined) {
      throw new VfsError("EREVISION", "file revision does not match", normalized);
    }
    this.writeText(normalized, "", {
      createParents: options.createParents ?? false,
      disposition: "create",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    const created = this.entry(normalized);
    if (options.modifiedAtMs !== undefined) created.stat.modifiedAtMs = options.modifiedAtMs;
    return { ...created.stat };
  }

  replaceText(options: ReplaceTextOptions): ReplaceTextResult {
    const current = this.readText(options.path);
    if (options.ifRevision !== undefined && options.ifRevision !== current.stat.revision) {
      throw new VfsError("EREVISION", "file revision does not match", current.stat.path);
    }
    const replaced = replaceContent(
      current.text,
      options.pattern,
      options.replacement,
      options.fixed ?? false,
      options.ignoreCase ?? false,
      options.global ?? false,
      this.regexEngine,
    );
    if (replaced.replacements === 0) {
      return {
        path: current.stat.path,
        revision: current.stat.revision,
        sizeBytes: current.stat.sizeBytes,
        created: false,
        replacements: 0,
        changed: false,
      };
    }
    const written = this.writeText(current.stat.path, replaced.value, {
      ifRevision: current.stat.revision,
      mode: current.stat.mode,
    });
    return { ...written, replacements: replaced.replacements, changed: true };
  }

  mkdir(path: string, recursive = false, mode?: number): VfsStat {
    const normalized = this.normalizeAccessPath(path, true);
    const existing = this.entries.get(normalized);
    if (existing) {
      if (existing.stat.kind === "directory" && recursive) return { ...existing.stat };
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    const parentPath = dirname(normalized);
    if (!this.entries.has(parentPath)) {
      if (!recursive) throw new VfsError("ENOENT", "parent directory does not exist", parentPath);
      this.mkdir(parentPath, true);
    }
    const now = this.now();
    const stat: VfsStat = {
      path: normalized,
      parentPath,
      name: basename(normalized),
      kind: "directory",
      contentKind: null,
      sizeBytes: 0,
      lineCount: 0,
      mode: mode ?? 0o040755,
      createdAtMs: now,
      modifiedAtMs: now,
      revision: 1,
    };
    this.entries.set(normalized, { stat });
    return { ...stat };
  }

  remove(path: string, options: RemoveOptions = {}): RemoveResult {
    const normalized = this.normalizeAccessPath(path);
    if (normalized === "/") throw new VfsError("EINVAL", "cannot remove root");
    const target = this.entry(normalized);
    const descendants = [...this.entries.keys()].filter((candidate) => isDescendant(normalized, candidate));
    if (target.stat.kind === "directory" && descendants.length > 0 && !options.recursive) {
      throw new VfsError("ENOTEMPTY", "directory is not empty", normalized);
    }
    for (const candidate of descendants) this.entries.delete(candidate);
    this.entries.delete(normalized);
    return { removed: descendants.length + 1, binaryObjectsQueuedForDeletion: 0 };
  }

  move(from: string, to: string, options: MoveOptions = {}): MoveResult {
    const source = this.normalizeAccessPath(from);
    const target = this.normalizeAccessPath(to);
    if (source === "/" || target === "/") {
      throw new VfsError("EINVAL", "cannot move from or to the root directory");
    }
    if (source === target) return { from: source, to: target, moved: 0, replaced: false };
    const sourceEntry = this.entry(source);
    if (sourceEntry.stat.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory inside itself", target);
    }
    const destinationParent = this.entry(dirname(target));
    if (destinationParent.stat.kind !== "directory") {
      throw new VfsError("ENOTDIR", "destination parent is not a directory", destinationParent.stat.path);
    }
    const targetEntry = this.entries.get(target);
    if (targetEntry && !options.replace) throw new VfsError("EEXIST", "destination exists", target);
    if (targetEntry) {
      if (sourceEntry.stat.kind === "directory" && targetEntry.stat.kind !== "directory") {
        throw new VfsError("ENOTDIR", "cannot replace a file with a directory", target);
      }
      if (sourceEntry.stat.kind !== "directory" && targetEntry.stat.kind === "directory") {
        throw new VfsError("EISDIR", "cannot replace a directory with a file", target);
      }
      if (
        targetEntry.stat.kind === "directory" &&
        [...this.entries.keys()].some((candidate) => isDescendant(target, candidate))
      ) {
        throw new VfsError("ENOTEMPTY", "destination directory is not empty", target);
      }
      this.entries.delete(target);
    }
    const moving = [...this.entries.entries()]
      .filter(([path]) => path === source || isDescendant(source, path))
      .sort(([left], [right]) => left.length - right.length);
    for (const [path] of moving) this.entries.delete(path);
    for (const [path, entry] of moving) {
      const newPath = path === source ? target : `${target}${path.slice(source.length)}`;
      const stat = {
        ...entry.stat,
        path: newPath,
        parentPath: path === source ? dirname(target) : `${target}${entry.stat.parentPath.slice(source.length)}`,
        name: path === source ? basename(target) : entry.stat.name,
        modifiedAtMs: path === source ? this.now() : entry.stat.modifiedAtMs,
        revision: path === source ? entry.stat.revision + 1 : entry.stat.revision,
      };
      this.entries.set(newPath, { ...entry, stat });
    }
    return { from: source, to: target, moved: moving.length, replaced: targetEntry !== undefined };
  }
}
