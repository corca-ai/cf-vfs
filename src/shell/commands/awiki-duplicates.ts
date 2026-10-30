import type { ShellCommandContext } from "../types.js";
import {
  countSharedWinnows,
  fingerprint,
  partitionEntries,
  relation,
  setSize,
  shingles,
} from "./awiki-fingerprint.js";

/**
 * `suggest`'s near-duplicate pass: character n-gram shingles compared by
 * Jaccard and containment, with candidate pairs found through winnowed
 * 5-gram fingerprints shared at least three times.
 *
 * The native tool keeps every page's fingerprints in memory at once. Here
 * kept fingerprints, kept shingle sets and the fingerprint index (built in
 * hash partitions) each take a quarter of the buffered-bytes budget; a page
 * that does not fit is fingerprinted again where it is needed. The result is
 * the same and memory stays bounded however large the wiki is.
 */

export interface DuplicateOptions {
  readonly shortWords: number;
  readonly threshold: number;
  readonly limit: number;
}

export interface DuplicateCandidate {
  readonly doc: number;
  readonly words: number;
}

export interface NearDuplicatePair {
  readonly a: number;
  readonly b: number;
  readonly score: number;
  readonly containment: number;
  readonly jaccard: number;
  readonly shared: number;
}

type ReadNorm = (doc: number) => Promise<string>;

const MIN_SHARED_WINNOWS = 3;
const MIN_SHINGLES = 24;
/** Bytes held per fingerprint entry while a partition is indexed. */
const ENTRY_BYTES = 24;

/**
 * Shingle sets held within a byte budget. The order the pairs need them in is
 * known before the first comparison, so eviction drops the set needed
 * furthest in the future (Belady's rule) and a page is rehashed only when
 * that order forces it.
 */
class ShingleCache {
  private readonly sets = new Map<number, { set: Uint32Array; next: number }>();
  private bytes = 0;
  private release: () => void = () => undefined;
  private nextUse: Int32Array = new Int32Array(0);
  private position = 0;

  constructor(
    private readonly context: ShellCommandContext,
    private readonly limit: number,
  ) {}

  /** Keeps a set computed anyway while room remains, before the order is known. */
  offer(owner: number, set: Uint32Array): void {
    if (this.bytes + set.byteLength > this.limit) return;
    this.sets.set(owner, { set, next: Number.POSITIVE_INFINITY });
    this.resize(this.bytes + set.byteLength);
  }

  /** Records the access order and drops kept sets nothing will ask for. */
  plan(sequence: readonly number[]): void {
    this.nextUse = new Int32Array(sequence.length);
    const seen = new Map<number, number>();
    for (let index = sequence.length - 1; index >= 0; index -= 1) {
      const owner = sequence[index] ?? 0;
      this.nextUse[index] = seen.get(owner) ?? -1;
      seen.set(owner, index);
    }
    for (const [owner, entry] of this.sets) {
      const first = seen.get(owner);
      if (first === undefined) this.drop(owner);
      else entry.next = first;
    }
  }

  async take(owner: number, load: (owner: number) => Promise<Uint32Array>): Promise<Uint32Array> {
    const next = this.nextUse[this.position] ?? -1;
    this.position += 1;
    const upcoming = next < 0 ? Number.POSITIVE_INFINITY : next;
    const cached = this.sets.get(owner);
    if (cached !== undefined) {
      cached.next = upcoming;
      return cached.set;
    }
    this.context.budget.checkDeadline();
    const set = await load(owner);
    if (upcoming !== Number.POSITIVE_INFINITY) this.admit(owner, set, upcoming);
    return set;
  }

  clear(): void {
    this.sets.clear();
    this.resize(0);
  }

  /** Adds a set, then evicts whatever is needed furthest ahead until it fits. */
  private admit(owner: number, set: Uint32Array, upcoming: number): void {
    this.sets.set(owner, { set, next: upcoming });
    let bytes = this.bytes + set.byteLength;
    while (bytes > this.limit) {
      const furthest = this.furthest();
      bytes -= this.sets.get(furthest)?.set.byteLength ?? 0;
      this.sets.delete(furthest);
      if (furthest === owner) break;
    }
    this.resize(bytes);
  }

  private furthest(): number {
    let furthest = -1;
    let furthestNext = Number.NEGATIVE_INFINITY;
    for (const [owner, entry] of this.sets) {
      if (entry.next > furthestNext) {
        furthest = owner;
        furthestNext = entry.next;
      }
    }
    return furthest;
  }

  private drop(owner: number): void {
    const entry = this.sets.get(owner);
    if (entry === undefined) return;
    this.sets.delete(owner);
    this.resize(this.bytes - entry.set.byteLength);
  }

  private resize(bytes: number): void {
    this.release();
    this.bytes = bytes;
    this.release = bytes > 0 ? this.context.budget.buffered(bytes) : () => undefined;
  }
}

/** Pages with enough shingles to compare, with what of their fingerprints fit. */
interface Fingerprinted {
  readonly docs: number[];
  readonly winnows: (Uint32Array | undefined)[];
  winnowEntries: number;
}

class Fingerprints {
  readonly pages: Fingerprinted = { docs: [], winnows: [], winnowEntries: 0 };
  private keptBytes = 0;
  private readonly releases: (() => void)[] = [];

  constructor(
    private readonly context: ShellCommandContext,
    private readonly limit: number,
    readonly shingleSets: ShingleCache,
  ) {}

  /** Fingerprints a page once; keeps its winnowed set while it fits. */
  add(doc: number, norm: string): void {
    const print = fingerprint(norm);
    if (setSize(print.shingles) < MIN_SHINGLES) return;
    const owner = this.pages.docs.push(doc) - 1;
    this.pages.winnowEntries += setSize(print.winnow);
    this.shingleSets.offer(owner, print.shingles);
    if (this.keptBytes + print.winnow.byteLength > this.limit) {
      this.pages.winnows.push(undefined);
      return;
    }
    this.keptBytes += print.winnow.byteLength;
    this.releases.push(this.context.budget.buffered(print.winnow.byteLength));
    this.pages.winnows.push(print.winnow);
  }

  release(): void {
    for (const release of this.releases.splice(0)) release();
  }
}

/** Pairs of pages sharing at least three winnowed values, in page order. */
async function candidatePairs(
  context: ShellCommandContext,
  pages: Fingerprinted,
  readNorm: ReadNorm,
  limit: number,
): Promise<(readonly [number, number])[]> {
  let partitions = 1;
  while (partitions < 1 << 16 && (pages.winnowEntries * ENTRY_BYTES) / partitions > limit) {
    partitions *= 2;
  }
  const counts = new Map<number, number>();
  for (let partition = 0; partition < partitions; partition += 1) {
    const entries: number[] = [];
    const owners: number[] = [];
    for (const [owner, doc] of pages.docs.entries()) {
      context.budget.checkDeadline();
      const set = pages.winnows[owner] ?? fingerprint(await readNorm(doc)).winnow;
      partitionEntries(set, owner, partitions, partition, entries, owners);
    }
    const release = context.budget.buffered(owners.length * ENTRY_BYTES);
    try {
      countSharedWinnows(Uint32Array.from(entries), owners, pages.docs.length, counts);
    } finally {
      release();
    }
  }
  const count = pages.docs.length;
  return [...counts]
    .filter(([, shared]) => shared >= MIN_SHARED_WINNOWS)
    .map(([key]) => [Math.floor(key / count), key % count] as const)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

export async function nearDuplicates(
  context: ShellCommandContext,
  candidates: readonly DuplicateCandidate[],
  readNorm: ReadNorm,
  options: DuplicateOptions,
): Promise<{ candidates: number; pairs: NearDuplicatePair[] }> {
  // A quarter of the buffered budget each for kept winnow sets, kept shingle
  // sets and one index partition; the rest stays free for reading pages.
  const quarter = Math.max(
    (context.budget.remainingBufferedBytes?.() ?? context.budget.limits.maxBufferedBytes) / 4,
    1,
  );
  const shingleSets = new ShingleCache(context, quarter);
  const prints = new Fingerprints(context, quarter, shingleSets);
  try {
    for (const page of candidates) {
      if (page.words < Math.max(options.shortWords, 20)) continue;
      context.budget.checkDeadline();
      prints.add(page.doc, await readNorm(page.doc));
    }
    const { docs } = prints.pages;
    const pairs = await candidatePairs(context, prints.pages, readNorm, quarter);
    prints.release();
    shingleSets.plan(pairs.flat());
    const load = async (owner: number) => shingles(await readNorm(docs[owner] ?? 0));
    const found: NearDuplicatePair[] = [];
    for (const [x, y] of pairs) {
      const related = relation(await shingleSets.take(x, load), await shingleSets.take(y, load));
      const score =
        related.sizeRatio >= 0.6
          ? Math.max(related.jaccard, related.containment * 0.95)
          : related.jaccard;
      if (score >= options.threshold && related.shared >= MIN_SHINGLES) {
        found.push({ a: docs[x] ?? 0, b: docs[y] ?? 0, score, ...related });
      }
    }
    found.sort((p, q) => q.score - p.score || q.shared - p.shared);
    return { candidates: pairs.length, pairs: found.slice(0, options.limit) };
  } finally {
    prints.release();
    shingleSets.clear();
  }
}
