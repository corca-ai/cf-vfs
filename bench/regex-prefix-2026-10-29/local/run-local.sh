#!/bin/zsh
set -e
cd /Users/ak/prjs/cc/cf-vfs
export FIXED_GIT_TIME=1 CREDENTIALS=demo
for i in 1 2 3 4; do
  off=$(( (i + 1) % 2 ))
  ORDER_OFFSET=$off npm run -s bench:local:paired -- $PERF/graph-base $PERF/graph-cand $PERF/local-ab-$i.json > $PERF/local-ab-$i.log 2>&1
  echo "ab $i done (offset $off)"
done
ORDER_OFFSET=0 npm run -s bench:local:paired -- $PERF/graph-base $PERF/graph-base2 $PERF/local-aa-1.json > $PERF/local-aa-1.log 2>&1
echo "aa done"
