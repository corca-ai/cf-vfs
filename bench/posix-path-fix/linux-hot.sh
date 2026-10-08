set -eu
cd /tmp/cf-vfs-semantics.CNmOiS
export PATH=/tmp/cf-vfs-semantics.CNmOiS/node-v24.18.0-linux-x64/bin:$PATH
POSIX_LIBRARY=dist POSIX_COMPARE_LIBRARY=baseline/dist POSIX_TRIALS=7 POSIX_REPEAT_FACTOR=10 POSIX_CASES=read-small,create,overwrite,rename,range POSIX_OUTPUT=hot-final-profile.json node bench/posix-profile.mjs
POSIX_LIBRARY=baseline-twin POSIX_COMPARE_LIBRARY=baseline/dist POSIX_TRIALS=7 POSIX_REPEAT_FACTOR=10 POSIX_CASES=create,overwrite,rename,range POSIX_OUTPUT=hot-control-profile.json node bench/posix-profile.mjs
