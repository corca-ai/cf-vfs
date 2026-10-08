set -eu
cd /tmp/cf-vfs-semantics.CNmOiS
export PATH=/tmp/cf-vfs-semantics.CNmOiS/node-v24.18.0-linux-x64/bin:$PATH
POSIX_LIBRARY=baseline-twin POSIX_COMPARE_LIBRARY=baseline/dist POSIX_TRIALS=9 POSIX_CASES=read-small,append POSIX_OUTPUT=isolated-control-profile.json node bench/posix-profile.mjs
POSIX_LIBRARY=dist POSIX_COMPARE_LIBRARY=baseline/dist POSIX_TRIALS=9 POSIX_OUTPUT=isolated-final-profile.json node bench/posix-profile.mjs
POSIX_LIBRARY=dist POSIX_OUTPUT=after-final-linux-semantics.json node bench/posix-semantics.mjs
