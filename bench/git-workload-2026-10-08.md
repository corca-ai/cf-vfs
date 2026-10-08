# Real Git workload probe — 2026-10-08

## Method

Node v24.18.0, isomorphic-git 1.43.1, git version 2.50.1 (Apple Git-155). The same Git engine runs on native local files and a thin promise-FS adapter over the existing NodeSqlFileSystem. No library implementation changes. The dependency lives outside the project; package.json and package-lock.json are unchanged.

100 and 1,000 tracked text files, 100 files per directory, approximately 0.8 KiB per file. Three fresh repositories per backend and size. Each run initializes, stages all files, commits, checks clean status three times, changes one file, computes a working-tree diff using statusMatrix + readBlob + createLineDiff, stages/commits, creates a branch, checks out the earlier commit and main, pushes to a local smart-HTTP native Git bare repository, and clones back. Every push gets a fresh remote object database. Remote ref OIDs and clone HEAD are asserted; checkout file contents and status results are checked.

This is a Node in-memory SQLite experiment, not a deployed Durable Object/R2 benchmark. SQL counts include explicit BEGIN/COMMIT and represent statements plus returned rows, not Cloudflare billed rows. FS calls include failed attempts and retries. fsCallMs sums overlapping async spans and must not be interpreted as CPU time or a share of elapsed latency. Read/write bytes count successful reads and attempted writes, including failed retries. No RPC latency is simulated. Native filesystem results include OS caching.

## Results: 1,000 files

Medians of three runs. Clean status below is the third scan in each repository.

| Operation | Native FS ms | VFS ms | VFS SQL statements |
| --- | ---: | ---: | ---: |
| add-all | 141.65 | 273.27 | 20,819 |
| commit-initial | 4.88 | 4.85 | 165 |
| status-clean-2 | 20.37 | 32.04 | 2,074 |
| diff-one-change | 21.24 | 38.10 | 2,087 |
| add-one | 1.55 | 1.64 | 27 |
| commit-one | 3.68 | 3.45 | 67 |
| branch-create | 0.49 | 0.42 | 25 |
| checkout-main | 19.11 | 48.28 | 2,911 |
| push | 186.52 | 158.21 | 2,124 |
| clone | 146.67 | 245.05 | 15,466 |
| add-20-individually-existing | 26.54 | 26.02 | 340 |
| add-20-bulk-existing | 2.16 | 2.60 | 93 |

## Findings and priorities

1. **Correctness before performance: stat-cache invalidation.** With a controlled clock, stage/commit `old\n`, advance 100 ms within the same second, replace with equal-sized `new\n`: statusMatrix reports `[a,1,1,1]` (clean). The bytes were correctly updated. isomorphic-git 1.43.1 compareStats compares whole-second mtime/ctime, size and identity, omitting nanoseconds and VFS revision. This is an engine/adapter integration issue, not lost VFS writes. A Git integration must use revision-aware invalidation or an engine-supported way to force content verification; mapping milliseconds alone does not solve whole-second comparisons.

2. **Hard capacity blocker: pack files.** Six independent random 2 MiB files can be staged, committed and pushed successfully. Clone writes a roughly 12 MiB pack and fails with EFBIG at the existing 8 MiB inline-file ceiling. Each working file is under the ceiling. The engine retries the failing pack write, so attempted bytes are roughly twice the pack size. An additional direct 9 MiB working-file write also fails. Need a large-object/pack path; R2 opaque storage alone does not provide the promise-FS readFile/writeFile contract used here. This experiment does not measure R2 performance.

3. **Repeated full-tree metadata scans dominate common small edits.** Clean status on 1,000 files makes 2,013 lstat calls and 2,074 SQL statements. One-file diff makes the same 2,013 lstat calls and 2,087 statements. Checkout from the earlier commit to main changes only one file but makes 2,299 lstat calls and 2,911 statements. Steady-state clean status still scales with repository cardinality. Use existing recordChanges/changesSince plus revision/OID caches in a Git-aware layer, or share metadata from list/find across a consistent operation. Do not memoize through writes without invalidation. Running each FS call through RPC would add an unmeasured network penalty; prefer operation-level orchestration.

4. **API-level batching already offers a substantial gain.** Adding 20 already tracked, unchanged paths individually rewrites the entire 79,952-byte index 20 times: 1,599,040 index bytes read and written in each direction. Passing the same 20 paths to one git.add call writes it once. This is an approximately 10x latency gain without changing VFS, and avoids 247 SQL statements (340 versus 93). This particular case restages unchanged files; it measures index overhead rather than new blob writes.

5. **Object creation and clone are write-heavy, but commit itself is cheap here.** Initial add costs 20,819 statements and clone 15,466, versus 67 for the subsequent one-file commit and 25 for branch creation. Optimize loose-object writes/namespace bookkeeping only after tracing this path in the intended runtime; the benchmark does not prove that a new object table is the best design. Small text push is not slower on VFS than on native FS in this run. Large random push spends hundreds of milliseconds while its FS call spans total only a few milliseconds; this suggests pack computation/transport rather than SQLite dominates that case, but is not a CPU profile.

6. **Existing line diff has a separate bounded-algorithm limit.** Comparing 1,200 all-a lines with 1,200 all-b lines through createLineDiff fails with E2BIG (1,442,401 LCS cells; ceiling 1,000,000). This is the project diff helper, not an isomorphic-git/native Git diff failure. If intended for Git-sized diffs, use a bounded alternative or a fallback. A one-line edit with a long common prefix/suffix can avoid this limit, so line count alone is not sufficient to predict failure.

Recommended order: repair Git stat-cache semantics; define supported pack/large-file handling; exploit bulk git.add; then reduce repeated metadata scans. Keep Git optional and outside the VFS core. No production optimization was applied in this probe.

## Reproduce

```sh
npm run build
npm install --prefix /tmp/cf-vfs-git-probe-deps --no-audit --no-fund isomorphic-git@1.43.1
GIT_PROBE_DEPS=/tmp/cf-vfs-git-probe-deps node bench/git-workload.mjs
```

Requires Node 24, native Git with http-backend, and a free localhost port. Uses temporary local repositories and deletes them when done. No credentials or external repository writes. Large-input expected error codes and the controlled stat-cache failure are assertions. Raw results: [git-workload-results.json](git-workload-results.json). Harness: [git-workload.mjs](git-workload.mjs).
