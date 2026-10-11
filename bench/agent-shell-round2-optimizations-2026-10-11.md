# Agent shell sorting follow-up, 2026-10-11

Baseline source commit `49c2c46` (deployed runtime `98cab91`). This follow-up
uses the preceding ten non-interactive agent workloads unchanged, with two
separate stress controls for supplementary Unicode and long shared prefixes.
No filesystem API, schema, permissions, command registration or dependencies
are changed. Raw evidence is in [the evaluation directory](agent-shell-round2-2026-10-11/README.md).

## Bottleneck and candidates

A fresh Node inspector profile of the ten-workload baseline identified repeated
TextEncoder calls underneath `compareUtf8`, particularly sort record ordering
and JSON-key comparisons. The shared comparator encoded both strings on every
comparison, including equal records and ordinary ASCII keys.

The equal-only experiment reduced duplicate-record work. A BMP lexical fast
path improved ordinary sorting further, but the supplementary-string stress
control slowed by 23.4% locally (CI 1.0696–1.5016). Its CF run was terminated
after partial preliminary measurements once this regression was established;
`cf-bmp-partial.txt` is not a complete comparison or adoption evidence.
A pure scalar loop was also explored: it improved short comparisons, but the
8 KiB shared ASCII-prefix microcase slowed to 1.95x. Neither candidate was
adopted unchanged.

The final candidate returns immediately for identical strings, uses native
lexical order when neither string contains surrogate code units, and compares
short supplementary text by scalar value. Unpaired surrogates map to U+FFFD,
just as TextEncoder does. Strings containing surrogates longer than 128 UTF-16
code units retain the native encoding fallback, avoiding a long JS prefix scan.
UTF-8 byte order, equality and prefix behavior are preserved; comparator
magnitudes are not meaningful. A native encoded-byte oracle checks both sides
of the short-string boundary, including malformed surrogates.

## Evidence and adoption

Adopted the final hybrid comparator after the complete local/CF controls,
per-workload follow-ups, byte-identical A/A, reversed-import and single-library
service crossovers below. The supported improvement is in the original agent
shell cohort; the complete public FS/Git suite remains statistically neutral.
No filesystem API was added. Public deployment verification follows below.

## Final target measurements

The unchanged ten-workload geometric time ratio is **0.8242 locally**
(95% CI 0.8158–0.8333) and **0.8047 on CF** (0.7798–0.8357):
17.6% and 19.5% less time respectively. The two stress controls are reported
separately and do not inflate that original-ten figure.

| CF workload | Before median ms | After median ms | Paired ratio | 95% CI |
| --- | ---: | ---: | ---: | --- |
| dependency-inspection | 5.51 | 3.66 | 0.679 | 0.595–0.747 |
| dependency-roundtrip | 11.82 | 10.04 | 0.852 | 0.820–0.927 |
| small-manifest | 1.39 | 1.37 | 0.961 | 0.838–1.169 |
| many-small-commands | 17.50 | 16.64 | 0.975 | 0.889–1.106 |
| escaped-json | 6.60 | 7.06 | 1.077 | 1.018–1.135 |
| manifest-inspection | 2.18 | 2.05 | 0.942 | 0.901–0.995 |
| manifest-update | 6.23 | 6.32 | 1.003 | 0.972–1.105 |
| source-edit | 8.07 | 7.98 | 1.005 | 0.921–1.080 |
| pipeline-summary | 17.71 | 3.55 | 0.208 | 0.192–0.231 |
| bash-file-workflow | 14.42 | 14.58 | 0.986 | 0.937–1.100 |
| supplementary-sort | 8.95 | 2.53 | 0.279 | 0.257–0.308 |
| long-prefix-sort | 79.85 | 22.60 | 0.272 | 0.250–0.298 |

These ratios are medians of matched pairs, not quotients of independent
medians. Timing is caller Worker RPC wall time per script, including output
validation, not isolated CPU time. Each CF target sample had identical native
SQL counters between versions; exact rewritten bodies were checked separately.
The escaped-JSON +7.7% raw flag is retained; independent attribution controls
below investigate it before adoption.

## Complete local controls and size

Both complete 190-row local comparisons used ten alternating pairs and one
warmup, with fixed Git author time. Demo credentials: uncached 0.9929
(0.9580–1.0315), cache 1.0082 (0.9417–1.0706). Unbound: uncached 0.9995
(0.9662–1.0321), cache 1.0060 (0.9340–1.0408). Nine >5% point flags in
each comparison, zero confirmed material latency flags. These controls do not
establish a general FS/Git acceleration.

The demo cost profile had no flags. The unbound clone-worktree profile retained
a +5 statement/+2 returned-row flag. Fixed-clock final A/B and byte-identical
A/A replays both showed seven differences in add-changed and clone-worktree,
consistent with the existing timer-based bounded write batching investigated
in the preceding round. Raw differences are retained in `cost-replay-summary.json`;
Node returned rows are not native CF billed rows. Native CF full-plan counters
are evaluated separately.

All twelve tree-shaking budgets pass unchanged. Non-interactive shell bytes
rose from 238,970 to 239,863 (+893); the small two-applet registry is
19,113/19,200 bytes, with 87 bytes of remaining budget. VFS-only remains
216,991 bytes. The shared comparator stays independent of applets and imports
no interactive code. This size increase is an explicit tradeoff.


## Complete CF control

The complete unbound 190-row comparison used ten alternating pairs and one
warmup. Uncached overall: **0.9931** (95% CI **0.9704–1.0226**), files:
1.0113 (0.9505–1.0706), Git/coding: 0.9936 (0.9712–1.0258), cache:
0.9967 (0.9659–1.0055). This does not establish a general FS/Git speedup.
Timing includes the SQL meter for both implementations.

Sixteen workload point estimates exceeded +5%; three initially confirmed:
100-file Git shell init (+5.9%), uncached 1,000-file Git checkout-old (+13.6%),
and 1,000-file coding-small add-partial (+11.9%). Complete matching groups were
repeated with attribution controls below; subsets do not replace the full aggregate.

Native profile counters were identical per workload, with uncached totals
275,092 statements, 861,055 rows read and 171,617 writes for each version;
cache totals 57,408 statements, 132,294 reads and 44,844 writes. Scanning every
matched timing sample also retained one difference: pair 7's injected
checkout-failure had candidate +31 statements/+93 reads, with identical writes.
This failure-path difference is investigated separately rather than declaring
that every full-plan counter was equal.

An independent twenty-pair escaped-JSON repeat recorded 1.0754
(0.9474–1.1228). Pooling the two twenty-pair phases retained ratio 1.0772
(1.0302–1.1249), so this flag is not dismissed merely because the second CI
includes one. Byte-identical A/A, reversed-import and separate-service controls are recorded
below; raw forward results remain visible.

### Attribution controls

The complete matching four-group repeat did not reproduce the original three
confirmed full-plan slowdowns. Other flags appeared, so neither one favorable
repeat nor pooling across different ambient fixture sizes approves the change.
`group-followup-summary.json` preserves those results. A reversed-import
comparison of the same groups (`group-crossover.json`) still left conditional
slowdowns for 100-file Git-shell add-changed (1.1026, CI 1.0048–1.1897)
and 1,000-file populate (1.0837, CI 1.0432–1.1559). The latter does not
execute the changed comparator. These are unresolved by that dual-library
harness alone; a separate, single-library-per-Worker crossover follows.

For escaped JSON, byte-identical A/A itself measured 1.0565
(1.0164–1.1282), establishing an import-slot bias. Fifty reversed-import pairs
measured old/new 0.9978 (0.9748–1.0279). Under a stable multiplicative slot
model, the conditional code estimate is 1.0390 (1.0072–1.0643).
This is a possible small slowdown, not proof of zero regression or 5%
noninferiority. The raw forward +7.7% flag and all forty paired forward
observations remain in `escaped-pooled.json`; the conditional diagnostic is
in `escaped-crossover.json`. It does not replace the original ten-case score.

The checkout-failure SQL difference also occurs with byte-identical code:
thirty A/A pairs retained nine differences of ±31 statements/±93 reads,
with equal writes. `native-cost-followup.json` lists every differing matched
sample in the full comparison, group repeat and A/A control. This identifies
pre-existing failure-path variability; it does not establish its exact cause.
Normal profile counters match. The separate Node fixed-clock A/A reproduces
its timer-batched Git-write cost variation as well.

### Single-library Worker crossover

Two additional private services each imported **one** graph (both source aliases
point to the same module root). Each service kept its namespace and room name
while exchanging baseline/candidate code, then repeated the identical complete
54-row four-group subset with ten pairs and one warmup. This removes the
two-library class-family shape from each Worker, but introduces separate-actor
placement. Both phase labels stay semantic new/old; the diagnostic estimate is
`sqrt(forward ratio * reversed ratio)` under stable multiplicative service
and actor-placement effects. It is neither the original full-plan score nor a
proof of 5% noninferiority.

The raw subset geometric ratios were 0.8015 and 1.1549, demonstrating why one
separate-service phase alone cannot establish a code win. After the crossover,
none of 54 conditional estimates had both ratio >1.05 and CI lower bound >1.
The previously unexplained add-changed estimate became 0.9572
(0.8454–1.0395), and 1,000-file populate became 0.9498
(0.8539–1.0425). Original full-plan flags likewise did not reproduce as
material code effects: init 0.9491, checkout-old 1.0249, add-partial 0.9618.
Two conditional point estimates still exceed +5% without confirmation: Git
log 1.0809 (0.9787–1.1721) and coding diff-staged 1.0516
(0.9216–1.1286). All raw flags remain retained in the two service runs,
`mono-followup-summary.json` and `mono-crossover.json`.

Both monomorphic phases have zero profile cost flags. All forward matched
native counters are equal; the reversed phase retains four timing differences
on checkout-failure only, with the same ±31 statements/±93 reads already
reproduced by A/A, and identical writes. They are preserved, not discarded.


Escaped JSON also used twenty matched pairs per single-library service phase,
with the same fixed service namespaces and separate fixed room across code
exchange. Raw forward/reversed new/old ratios were 1.5291 and 0.6117; the
conditional estimate is **0.9671 (0.9100–1.0229)**. Its slowdown did not
reproduce as a material code effect in this production-shaped control.
`escaped-mono-crossover.json` retains the estimator, assumptions and samples.
This does not erase the original +7.7% raw dual-import flag or establish zero
regression everywhere; the dual-import diagnostic's possible +3.9% remains
visible as well. Native costs and exact output/body checks match in both phases.

### Adoption decision

Adopt the API-free hybrid comparator: the unchanged ten-case agent cohort has
a supported CF improvement, complete local/CF controls remain neutral, and no
material **unexplained confirmed** latency or SQL-cost regression remains after
the attribution controls. Service/placement crossover models are conditional,
not universal noninferiority proofs. Keep the raw flags, failure-path SQL
variability and +893-byte bundle tradeoff; no thresholds, public cohorts or
resource limits were relaxed. Node (2,002), Workers (158), POSIX (46), execution
limits (14), all twelve bundle budgets, package exports, docs, types, lint,
quality, comparison protocol and full benchmark gates passed. Existing lint
advisories and quality suppressions remain unchanged. See `verification.json`.

## Public deployment and historical-drift control

Committed/pushed runtime source **`a0cc061`**, fingerprint
`a81d4ac4d4655aa3683b53c69b7a9564ef79bdb1ea06b235624537ee527e3c50`.
The first public deployment was `0b7550bd-ce80-4ea7-8392-9c5f8c0e9f78`.
Its complete 190-row run passed all 60,648 checks but screened 1.1459 overall
against the saved historical public baseline. A fresh repeat screened 1.1626;
these flags were investigated rather than ignored after a favorable target.

Temporarily restoring the **previous production version** and running the same
complete public plan now also screened approximately **1.163** against its own
historical result. That identical-code historical drift accounts for the
apparent overall slowdown; the exact platform/storage-state cause is not
established. These time-adjacent three-sample controls diagnose drift and do
not replace the ten-pair private CF comparison or prove causal equivalence.
All historical and fresh flags are retained in `public-followup.json.gz`.

After restoring the candidate, the outer Worker advertised the new build while
the DO still advertised the old build for several minutes. The expected-build
guard collected no mixed-build samples. That guarded wait was stopped and the
identical committed runtime and unchanged build/source stamp were redeployed;
no library change, migration or binding change was made. See
`public-propagation.json`. This preserves the measured source identity while
forcing a fresh deployment; the final outer Worker and DO builds matched.
Cloudflare documents eventual code propagation between Workers and DOs in its
[known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).

Final deployed version **`21577e2c-d3a8-4378-b73a-ef8a5d277af8`**, run
**`f1f7be22-2242-4188-a9cd-1d611e45e390`**, completed
2026-10-11 13:17:04 UTC: **190 rows, 60,648 checks**, expected source/build
verified. Compared with the freshly remeasured previous version, descriptive
geometric ratios are overall **0.9861**, files **0.9778**, Git/coding **0.9872**,
and metadata cache **1.0214**. Fifty-seven per-workload point estimates exceed
+5%, with zero unresolved zeros; all are retained. These three-sample ratios
are not a new general FS/Git speedup claim, nor a claim that every row improves.
The matching full ten-pair comparison and attribution controls above remain
the adoption evidence. Public records have **no native SQL coverage**; native
cost gates come from the separate paired CF measurements.

The final live public WebSocket smoke passed its exact stdout, stderr and
status checks for a named Bash script, jq rewrite, sed editing, and Unicode
`sort | uniq`; its UUID-owned workspace was removed. Repeated public runs
reuse the same commit identity, leaving the existing history deduplication and
190-row sparkline cohort intact. All three owned private evaluation services
and their temporary compiled graphs were removed after verification. No npm
package was published.
