import { bashSuite } from "./helpers/bash.js";

bashSuite("IFS field splitting and read", [
  {
    name: "keeps boundaries at the ends of an expansion",
    script: `a="x "; b=pre; c=" y"; printf '<%s>' $a"z" $b$c; echo`,
    stdout: "<x><z><pre><y>\n",
  },
  {
    name: "delimits empty fields with non-whitespace separators",
    script: `IFS=,; a="a,,b, c,"; printf '<%s>' $a; echo; IFS=', '; a=" ,b , c"; printf '<%s>' $a; echo`,
    stdout: "<a><><b>< c>\n<><b><c>\n",
  },
  {
    name: "does not split when IFS is empty and splits each $* parameter",
    script: `IFS=; a="a b"; set -- "p q" r; printf '<%s>' $a $*; echo`,
    stdout: "<a b><p q><r>\n",
  },
  {
    name: "splits command substitution on a newline IFS",
    script: `IFS=$'\\n'; for l in $(printf 'a b\\nc d\\n'); do printf '<%s>' "$l"; done; echo`,
    stdout: "<a b><c d>\n",
  },
  {
    name: "joins quoted $* with the first IFS character",
    script: `set -- a "b c" ""; IFS=-; echo "$*"; IFS=; echo "$*"; unset IFS; echo "$*"`,
    stdout: "a-b c-\nab c\na b c \n",
  },
  {
    name: "restores IFS after a function's local assignment",
    script: `f() { local IFS=:; set -- $1; echo $#; }; f a:b:c; v="p q"; printf '<%s>' $v; echo`,
    stdout: "3\n<p><q>\n",
  },
  {
    name: "keeps leading blanks with IFS= read",
    script: `while IFS= read -r l; do printf '<%s>' "$l"; done; echo`,
    stdin: "  lead\ttab  \n\tx\n",
    stdout: "<  lead\ttab  ><\tx>\n",
  },
  {
    name: "trims and splits read on the active IFS",
    script: `read -r l; printf '<%s>' "$l"; IFS=: read -r a b c; printf '<%s>' "$a" "$b" "$c"; IFS=, read -r d e; printf '<%s>' "$d" "$e"; echo`,
    stdin: "  lead  \nx:y:z:w\n,x\n",
    stdout: "<lead><x><y><z:w><><x>\n",
  },
]);

bashSuite("directory-only pathname expansion", [
  {
    name: "matches only directories with a trailing slash and keeps it",
    files: { "/d/a/x": "", "/d/b/y": "", "/d/f": "" },
    script: `cd /d; echo */; echo /d/*/; for d in */; do printf '[%s]' "$d"; done; echo; echo none*/`,
    stdout: "a/ b/\n/d/a/ /d/b/\n[a/][b/]\nnone*/\n",
  },
]);

bashSuite("case modification and dotted mkdir -p", [
  {
    name: "changes the case of the first or every letter",
    script: "x=Hello; y=hello; echo ${x,,} ${x^^} ${x,} ${y^}",
    stdout: "hello HELLO hello Hello\n",
  },
  {
    name: "creates directories through . and .. components",
    script: "cd /; mkdir -p ./a/./b && mkdir -p /w/./c/../d && ls -d /a/b /w/c /w/d",
    stdout: "/a/b\n/w/c\n/w/d\n",
  },
]);
