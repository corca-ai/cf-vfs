// Scripted solutions to the S1 and S3 agent tasks, one string per execution
// (`POST /exec`), as an agent would send them. `shell` uses only the utilities
// the agents had; `awiki` hands every part awiki can do to awiki.

const S1_TAGS = String.raw`cd /workspace/wiki
mkdir -p tags /tmp
find . -name '*.md' ! -path './reports/*' ! -path './tags/*' | sort > /tmp/pages
awk 'FNR == 1 { name = FILENAME; sub(/.*\//, "", name); sub(/\.md$/, "", name); fm = 0 }
     /^---$/ { fm++; next }
     fm == 1 && /^tags:/ { line = $0; sub(/^tags: *\[/, "", line); sub(/\] *$/, "", line)
       n = split(line, parts, ","); for (i = 1; i <= n; i++) { t = parts[i]; gsub(/^ +| +$/, "", t); if (t != "") print t "\t" name } }' $(cat /tmp/pages) |
  sort -t "$(printf '\t')" -k1,1 -k2,2 |
  awk -F '\t' 'BEGIN { print "# Tags" } $1 != last { printf "\n## %s\n\n", $1; last = $1 } { print "- [[" $2 "]]" }' > tags/index.md
cat tags/index.md | head -5`;

const S1_SHELL = [
  String.raw`cd /workspace/wiki
mv engineering/deploy-guide.md engineering/release-process.md
sed -i -e 's/^title: Deploy Guide$/title: Release Process/' -e 's/^# Deploy Guide$/# Release Process/' engineering/release-process.md
grep -rlE '\[\[deploy-guide[]|#]' . | while read -r f; do sed -i -E 's/\[\[deploy-guide([]|#])/[[release-process\1/g' "$f"; done
grep -rn 'release-process' . | wc -l`,
  String.raw`cd /workspace/wiki
mkdir -p reports /tmp
find . -name '*.md' ! -path './reports/*' ! -path './tags/*' | sed 's|^\./||' | sort > /tmp/pages
sed -e 's|.*/||' -e 's|\.md$||' /tmp/pages | sort -u > /tmp/names
{ printf '# Broken links\n\n'
  while read -r p; do
    grep -oE '\[\[[^]|#]+' "$p" | sed 's/^\[\[//' | sort -u | while read -r t; do
      grep -qxF "$t" /tmp/names || echo "- $p: $t"
    done
  done < /tmp/pages | sort; } > reports/broken-links.md
cat reports/broken-links.md`,
  S1_TAGS,
];

const S1_AWIKI = [
  String.raw`cd /workspace/wiki
awiki rename -r engineering/deploy-guide release-process
sed -i -e 's/^title: Deploy Guide$/title: Release Process/' -e 's/^# Deploy Guide$/# Release Process/' engineering/release-process.md`,
  String.raw`cd /workspace/wiki
mkdir -p reports
{ printf '# Broken links\n\n'
  awiki wanted -r -n 100000 -sources 0 |
    awk '/^\[\[.*\]\] \([0-9]+ links?\)$/ { t = $0; sub(/^\[\[/, "", t); sub(/\]\] \(.*$/, "", t) }
         /^- \[\[/ { p = $0; sub(/^- \[\[/, "", p); sub(/\]\]: .*$/, "", p); print "- " p ".md: " t }' |
    sort -u; } > reports/broken-links.md
cat reports/broken-links.md`,
  S1_TAGS,
];

const S3_MISSING_OWNER = String.raw`awk 'FNR == 1 { fm = 0; owner = 0 }
     /^---$/ { fm++; if (fm == 2 && !owner) { p = FILENAME; sub(/^\.\//, "", p); print p }; next }
     fm == 1 && /^owner:/ { owner = 1 }' $(find . -name '*.md' ! -path './reports/*') | sort`;

const S3_SHELL = [
  String.raw`cd /workspace/wiki
mkdir -p reports /tmp
find . -name '*.md' ! -path './reports/*' | sed 's|^\./||' | sort > /tmp/paths
grep -roE '\[\[[^]|#]+' --include='*.md' . |
  sed -e 's|^\./||' -e 's|\.md:\[\[| |' | awk '{ n = $1; sub(/.*\//, "", n); if (n != $2) print n, $2 }' | sort -u |
  awk '{ print $2 }' | sort | uniq -c | awk '{ print $2, $1 }' > /tmp/inbound
wc -l < /tmp/inbound`,
  String.raw`cd /workspace/wiki
{ printf '# Audit\n\n## Orphans\n\n'
  awk 'NR == FNR { seen[$1] = 1; next } { n = $0; sub(/.*\//, "", n); sub(/\.md$/, "", n); if (!(n in seen)) print "- " $0 }' /tmp/inbound /tmp/paths
  printf '\n## Most linked\n\n'
  awk 'NR == FNR { n = $0; sub(/.*\//, "", n); sub(/\.md$/, "", n); ok[n] = 1; next } ($1 in ok) { print $1, $2 }' /tmp/paths /tmp/inbound |
    sort -k2,2nr -k1,1 | head -10 | awk '{ print "- " $1 ": " $2 }'
  printf '\n## Missing owner\n\n'
  ${S3_MISSING_OWNER} | sed 's/^/- /'
} > reports/audit.md
head -20 reports/audit.md`,
];

/** awiki answers one page's inbound links per run; a run rereads the whole wiki's tokens. */
function s3AwikiBatch(first, count) {
  return String.raw`cd /workspace/wiki
mkdir -p /tmp
find . -name '*.md' ! -path './reports/*' | sed -e 's|^\./||' -e 's|\.md$||' | sort | sed -n '${first + 1},${first + count}p' |
while read -r p; do
  n=$(awiki links -r "$p" | awk '/^\/\/ incoming links/ { on = 1; next } /^\/\/ outgoing links/ { on = 0 } on && /^\[\[/ { c++ } END { print c + 0 }')
  echo "$p $n"
done >> /tmp/inbound-awiki
wc -l < /tmp/inbound-awiki`;
}

export const SOLUTIONS = {
  s1: { shell: S1_SHELL, awiki: S1_AWIKI },
  s3: {
    shell: S3_SHELL,
    // Only the first 100 pages: enough to show the per-page cost, not a full answer.
    "awiki (links per page, first 100 pages)": [s3AwikiBatch(0, 100)],
  },
};
