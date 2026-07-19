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
import { basename, depthFrom, dirname, isDescendant, normalizePath } from "../core/path.js";
import { replaceContent, searchContent } from "../core/search.js";
import type {
  FindOptions,
  MoveResult,
  RegexEngine,
  RemoveOptions,
  RemoveResult,
  ReplaceTextOptions,
  ReplaceTextResult,
  TextReadResult,
  TextSearchOptions,
  TextSearchResult,
  TextSliceOptions,
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
  private readonly regexEngine?: RegexEngine;
  private clock = 1;

  constructor(options: { regexEngine?: RegexEngine } = {}) {
    this.regexEngine = options.regexEngine;
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

  stat(path: string): VfsStat {
    return { ...this.entry(path).stat };
  }

  list(path: string): VfsStat[] {
    const normalized = normalizePath(path);
    if (this.entry(normalized).stat.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", normalized);
    }
    return [...this.entries.values()]
      .filter((entry) => entry.stat.path !== "/" && entry.stat.parentPath === normalized)
      .map((entry) => ({ ...entry.stat }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  find(options: FindOptions): VfsStat[] {
    const root = normalizePath(options.path);
    const rootEntry = this.entry(root);
    const limit = options.limit ?? 10_000;
    return [...this.entries.values()]
      .map((entry) => entry.stat)
      .filter((stat) => stat.path === root
        ? rootEntry.stat.kind === "file" || (options.includeRoot ?? false)
        : isDescendant(root, stat.path))
      .filter((stat) => options.type === undefined || stat.kind === options.type)
      .filter((stat) => options.maxDepth === undefined || depthFrom(root, stat.path) <= options.maxDepth)
      .filter((stat) => matchesGlob(stat.name, options.name))
      .filter((stat) => matchesGlob(stat.path, options.pathGlob))
      .sort((left, right) => left.path.localeCompare(right.path))
      .slice(0, limit)
      .map((stat) => ({ ...stat }));
  }

  readText(path: string): TextReadResult {
    const entry = this.entry(path);
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
      const normalized = normalizePath(root);
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
    const normalized = normalizePath(path);
    if (options.createParents) this.mkdir(dirname(normalized), true);
    const parent = this.entry(dirname(normalized));
    if (parent.stat.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent.stat.path);
    const existing = this.entries.get(normalized);
    if (existing?.stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (options.ifRevision !== undefined && existing?.stat.revision !== options.ifRevision) {
      throw new VfsError("EREVISION", "file revision does not match", normalized);
    }
    const now = this.now();
    const encoded = new TextEncoder().encode(text);
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

  mkdir(path: string, recursive = false): VfsStat {
    const normalized = normalizePath(path);
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
      mode: 0o040755,
      createdAtMs: now,
      modifiedAtMs: now,
      revision: 1,
    };
    this.entries.set(normalized, { stat });
    return { ...stat };
  }

  remove(path: string, options: RemoveOptions = {}): RemoveResult {
    const normalized = normalizePath(path);
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

  move(from: string, to: string): MoveResult {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === "/" || target === "/") {
      throw new VfsError("EINVAL", "cannot move from or to the root directory");
    }
    if (source === target) return { from: source, to: target, moved: 0 };
    const sourceEntry = this.entry(source);
    if (this.entries.has(target)) throw new VfsError("EEXIST", "destination exists", target);
    if (sourceEntry.stat.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory inside itself", target);
    }
    const destinationParent = this.entry(dirname(target));
    if (destinationParent.stat.kind !== "directory") {
      throw new VfsError("ENOTDIR", "destination parent is not a directory", destinationParent.stat.path);
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
    return { from: source, to: target, moved: moving.length };
  }
}
