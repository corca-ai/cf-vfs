# Raw measurement inventory

Ratios are candidate/baseline. Lower is faster. A confidence interval containing1 does not prove a latency improvement. These rows are evidence, not automatic approvals. Older protocols and changed credentials must not be pooled. SHA-256 hashes in inventory.json refer to decompressed original bytes.

| Evidence | Credentials | Full plan | Pairs | Overall ratio [95% CI] | >5% flags | Confirmed flags | Cost increases |
|---|---|---|---|---|---|---|---|
| [cf-batch-parents.json.gz](cf-batch-parents.json.gz) | none | true | 10 | 1.0112 [0.9726, 1.0204] | 36 | 5 | 4 |
| [cf-copy-path-demo.json.gz](cf-copy-path-demo.json.gz) | demo | true | 10 | 0.9966 [0.9860, 1.0171] | 30 | 2 | 0 |
| [cf-final-fixed.json.gz](cf-final-fixed.json.gz) | none | true | 10 | 0.9951 [0.9883, 1.0075] | 27 | 8 | 0 |
| [cf-four-root-fixed.json.gz](cf-four-root-fixed.json.gz) | root | true | 10 | 0.9981 [0.9900, 1.0060] | 13 | 2 | 0 |
| [cf-traversal-v2-confirmation.json.gz](cf-traversal-v2-confirmation.json.gz) | demo | false | 10 | 0.9265 [0.8764, 0.9436] | 3 | 1 | 0 |
| [cf-traversal-v2-demo-followup.json.gz](cf-traversal-v2-demo-followup.json.gz) | demo | false | 10 | 0.9211 [0.8538, 0.9448] | 6 | 3 | 0 |
| [cf-traversal-v2-demo.json.gz](cf-traversal-v2-demo.json.gz) | demo | true | 5 | 0.8896 [0.8756, 0.9265] | 9 | 2 | 0 |
| [local-aa-stage-order.json.gz](local-aa-stage-order.json.gz) | none | true | 10 | 1.0019 [0.9929, 1.0126] | 11 | 0 | 1 |
| [local-aa.json.gz](local-aa.json.gz) | none | true | 10 | 1.0009 [0.9556, 1.0456] | 7 | 0 | 1 |
| [local-ancestor-slices.json.gz](local-ancestor-slices.json.gz) | none | true | 10 | 0.9982 [0.9645, 1.0388] | 12 | 1 | 0 |
| [local-ascii-compare.json.gz](local-ascii-compare.json.gz) | none | true | 10 | 0.9939 [0.9568, 1.0357] | 12 | 0 | 0 |
| [local-batch-parents.json.gz](local-batch-parents.json.gz) | none | true | 20 | 0.9975 [0.9671, 1.0251] | 5 | 0 | 0 |
| [local-combined-stage-order.json.gz](local-combined-stage-order.json.gz) | none | true | 40 | 0.9963 [0.9904, 1.0002] | 3 | 0 | 0 |
| [local-copy-only-demo.json.gz](local-copy-only-demo.json.gz) | {"uid":1000,"gid":1000} | true | 20 | 0.9949 [0.9904, 1.0057] | 5 | 0 | 0 |
| [local-copy-only-unbound.json.gz](local-copy-only-unbound.json.gz) | none | true | 20 | 0.9984 [0.9886, 1.0047] | 5 | 0 | 0 |
| [local-copy-path-demo.json.gz](local-copy-path-demo.json.gz) | {"uid":1000,"gid":1000} | true | 20 | 0.9897 [0.9841, 0.9926] | 4 | 0 | 0 |
| [local-copy-path-unbound.json.gz](local-copy-path-unbound.json.gz) | none | true | 20 | 0.9984 [0.9920, 1.0047] | 4 | 0 | 0 |
| [local-empty-tombstones.json.gz](local-empty-tombstones.json.gz) | none | true | 20 | 0.9955 [0.9661, 1.0343] | 6 | 0 | 6 |
| [local-entry-assign.json.gz](local-entry-assign.json.gz) | none | true | 10 | 0.9997 [0.9744, 1.0502] | 19 | 0 | 1 |
| [local-final-fixed.json.gz](local-final-fixed.json.gz) | none | true | 20 | 0.9976 [0.9918, 1.0053] | 2 | 1 | 0 |
| [local-final-root-fixed.json.gz](local-final-root-fixed.json.gz) | {"uid":0,"gid":0} | true | 20 | 0.9787 [0.9758, 0.9829] | 3 | 1 | 0 |
| [local-final-v5.json.gz](local-final-v5.json.gz) | none | true | 20 | 0.9927 [0.9886, 1.0004] | 5 | 0 | 0 |
| [local-four-fixed.json.gz](local-four-fixed.json.gz) | none | true | 20 | 0.9976 [0.9843, 1.0015] | 5 | 1 | 0 |
| [local-four-root-confirmation.json.gz](local-four-root-confirmation.json.gz) | {"uid":0,"gid":0} | true | 40 | 0.9706 [0.9685, 0.9766] | 4 | 2 | 0 |
| [local-four-root-fixed.json.gz](local-four-root-fixed.json.gz) | {"uid":0,"gid":0} | true | 20 | 0.9713 [0.9684, 0.9744] | 3 | 0 | 0 |
| [local-four-unbound-confirmation.json.gz](local-four-unbound-confirmation.json.gz) | none | true | 40 | 0.9872 [0.9804, 0.9909] | 3 | 0 | 0 |
| [local-fused-posix-read-root.json.gz](local-fused-posix-read-root.json.gz) | {"uid":0,"gid":0} | true | 20 | 0.9870 [0.9841, 0.9890] | 5 | 3 | 0 |
| [local-known-absence.json.gz](local-known-absence.json.gz) | none | true | 20 | 1.0047 [0.9728, 1.0332] | 8 | 0 | 0 |
| [local-last-path-fixed.json.gz](local-last-path-fixed.json.gz) | none | true | 20 | 0.9911 [0.9789, 0.9973] | 3 | 0 | 0 |
| [local-one-chunk-collect.json.gz](local-one-chunk-collect.json.gz) | none | true | 20 | 0.9897 [0.9587, 1.0260] | 6 | 0 | 0 |
| [local-path-incremental.json.gz](local-path-incremental.json.gz) | none | true | 20 | 0.9909 [0.9786, 0.9970] | 4 | 0 | 0 |
| [local-root-followup.json.gz](local-root-followup.json.gz) | {"uid":0,"gid":0} | false | 30 | 0.9837 [0.9742, 0.9882] | 0 | 0 | 0 |
| [local-sync-bytes.json.gz](local-sync-bytes.json.gz) | none | true | 10 | 1.0061 [0.9600, 1.0365] | 10 | 0 | 0 |
| [local-traversal-cache-demo.json.gz](local-traversal-cache-demo.json.gz) | {"uid":1000,"gid":1000} | true | 20 | 0.8263 [0.8238, 0.8297] | 1 | 0 | 0 |
| [local-traversal-cache-unbound.json.gz](local-traversal-cache-unbound.json.gz) | none | true | 10 | 0.9942 [0.9877, 1.0091] | 7 | 0 | 0 |
| [local-traversal-v2-demo-followup.json.gz](local-traversal-v2-demo-followup.json.gz) | {"uid":1000,"gid":1000} | false | 30 | 0.7991 [0.7832, 0.8135] | 1 | 0 | 0 |
| [local-traversal-v2-demo.json.gz](local-traversal-v2-demo.json.gz) | {"uid":1000,"gid":1000} | true | 10 | 0.8294 [0.8252, 0.8366] | 4 | 0 | 0 |
| [local-traversal-v2-unbound-followup.json.gz](local-traversal-v2-unbound-followup.json.gz) | none | false | 30 | 1.0021 [0.9941, 1.0098] | 2 | 0 | 0 |
| [local-traversal-v2-unbound.json.gz](local-traversal-v2-unbound.json.gz) | none | true | 10 | 0.9999 [0.9926, 1.0080] | 8 | 0 | 0 |
| [local-unbound-followup.json.gz](local-unbound-followup.json.gz) | none | false | 30 | 0.9957 [0.9833, 1.0063] | 0 | 0 | 0 |
