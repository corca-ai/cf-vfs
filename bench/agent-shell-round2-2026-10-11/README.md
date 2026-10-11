# Non-interactive sorting evaluation

Baseline: `49c2c46`, same library as deployed `98cab91`. The original ten agent
workflows remain a separate comparable cohort; supplementary and long-prefix
sorts are two additional stress controls, not additions to the public FS/Git
score. The public 190-row plan and sparkline cohort remain unchanged.

`local-{equal,bmp,points}.json` are exploratory ten-workload comparisons.
`local-bmp-stress.json` is the rejected BMP-only twelve-workload comparison;
`local-hybrid.json` and `cf-hybrid.json` measure the final twelve-workload graph.
`cf-bmp-partial.txt` retains an aborted preliminary CF run, not a full result.
Only `src/core/path.js` differs in the baseline/final compiled library.

Local timings use ten warmup pairs, twenty alternating measured pairs and ten
executions per sample. Exact stdout/status and edited file bodies are verified
outside local timing. CF uses three warmup pairs, twenty measured pairs and
fifty executions per RPC, UID/GID 1000 and default shell limits. Timing is
caller Worker RPC wall time per execution, not CPU time or browser RTT; output
validation is in the measured RPC and file validation is separate. Every target
sample must have equal native SQL counters for both versions.

Complete local controls use the existing `three-hour-2026-10-10/local-pairs.mjs`
driver, ten pairs, one warmup and fixed Git author time, both demo credentials
and unbound VFS. The complete CF driver measures the unchanged 190-row plan,
retains native SQL counters and includes its SQL meter on both versions.
All flags and follow-up evidence are retained; subsets do not replace totals.

Host `oracle.mjs` records Bash/jq versions and compares all twelve workflows
against native Bash/jq/sed in the C locale. The two large sorts are stress
fixtures. Native uniq/wc field padding alone is normalized for this oracle;
VFS benchmark stdout is exact.

The three private evaluation Workers have no public product API and were
removed after evaluation.
Authentication comes from an ignored local secrets file; no token is archived.

Reproduce the final graph and exploratory comparators in a new directory:

```sh
node bench/agent-shell-round2-2026-10-11/restore.mjs /tmp/agent2-replay
node bench/agent-shell-round2-2026-10-11/local.mjs /tmp/agent2-replay/baseline /tmp/agent2-replay/candidate /tmp/agent2-local.json
node bench/agent-shell-round2-2026-10-11/compare-micro.mjs /tmp/agent2-replay
```

`graphs.json` hashes all 200 JS modules with path/NUL/source/NUL framing; only
`src/core/path.js` differs. The baseline hash exactly matches the preceding
round's adopted candidate. Type declarations are retained with the JS archive.
`hybrid` is the final candidate; `hybrid-before-refactor` preserves the same
algorithm before extracting the surrogate normalization helper to satisfy the
existing cognitive-complexity gate. Results labelled `before-refactor` are
intermediate evidence; final target and full-suite comparisons were rerun.
`full-cf-before-refactor-partial.json.gz` is an aborted incomplete screen.

`cost-replay-summary.json` retains final fixed-clock A/B and byte-identical A/A
Git replays. Both reproduce existing timer-based write-batch count variation;
this does not turn Node returned rows into native CF billed rows.

Large archived JSON results use gzip; replay drivers still write ordinary JSON.

Attribution controls retain the unchanged full score. `cf-groups-repeat.json`
and `cf-groups-swapped.json` repeat the same complete four-group subset with
reversed dual-library import slots. `crossover-groups.mjs` uses their different
semantic labels (forward new/old, swapped old/new), so its conditional code
ratio is the square root of their quotient. Escaped-JSON A/A and reversed
import samples are summarized separately by `pool-escaped.mjs` and
`crossover.mjs`. A/A recovery trials retain native counter variability rather
than silently dropping unequal fault-injection samples.

`remote-mono.mjs` tests a different attribution protocol: two private services,
each importing only one library graph. Their fixed namespaces and room name
persist while code is exchanged across the services in phase two. Both phases
label baseline/candidate semantically, so `crossover-mono.mjs` takes the square
root of the product of the two new/old ratios. This conditional estimate
assumes a stable multiplicative service/placement effect. Separate actors and
subset fixture sizes differ from the complete dual-library comparison; their
results neither replace that full score nor prove 5% noninferiority. Worker
source templates and private configs retain the exact graphs and build IDs.

`remote-mono-target.mjs` repeats escaped JSON on the same fixed services with a
separate fixed room. Its two twenty-pair phases use the same semantic new/old
labels. `crossover-mono-escaped.mjs` retains their conditional product estimate
and uncertainty, separate from both the ten-workflow headline and full FS/Git
score. These controls diagnose placement/import effects; they cannot establish
universal noninferiority.


Public verification keeps the historical baseline, two initial candidate runs,
a fresh previous-production-version control, and the restored candidate's
final run. `summarize-public.mjs` validates all 190-row/60,648-check results and
retains descriptive flags without replacing the full paired approval evidence.
Its readers accept both replay JSON and archived `.json.gz`. See
`public-verification.json` for the final source/build/deployment/run identity,
`public-propagation.json` for the guarded restore/redeploy, and
`public-smoke.json` for the final live shell output.

To replay private Worker measurements, restore the graphs, then recreate the
ignored `agent2-baseline` and `agent2-candidate` symlinks under
`bench/three-hour-2026-10-10/compiled/` to the restored graph roots. A/A also
requires a separate byte-identical baseline copy linked as `agent2-baseline-copy`.
Use the archived source templates for each phase and configure the private
secret locally; remove those services and symlinks after replay. Library graphs
and private service configurations remain separate from the production API.
