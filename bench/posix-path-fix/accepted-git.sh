set -eu
cd /tmp/cf-vfs-semantics.CNmOiS
export PATH=/tmp/cf-vfs-semantics.CNmOiS/node-v24.18.0-linux-x64/bin:$PATH
export GIT_PROBE_DEPS=/tmp/cf-vfs-semantics.CNmOiS/git-deps
export GIT_PROBE_VARIANT=fs GIT_PROBE_COUNTS=1000 GIT_PROBE_TRIALS=3
POSIX_LIBRARY=dist POSIX_OUTPUT=accepted-linux-semantics.json node bench/posix-semantics.mjs
GIT_PROBE_LIBRARY=baseline/dist GIT_PROBE_OUTPUT=before-accepted-git.json node bench/git-workload.mjs
GIT_PROBE_LIBRARY=dist GIT_PROBE_OUTPUT=after-accepted-git.json node bench/git-workload.mjs
GIT_PROBE_LIBRARY=dist GIT_PROBE_OUTPUT=after-accepted-repeat-git.json node bench/git-workload.mjs
GIT_PROBE_LIBRARY=baseline/dist GIT_PROBE_OUTPUT=before-accepted-repeat-git.json node bench/git-workload.mjs
