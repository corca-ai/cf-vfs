import { describe } from "vitest";
import { bashCases } from "./helpers/bash.js";

// What agents ran first or most often in recorded sessions and found missing:
// identifying the system, grep -P for control and non-ASCII characters,
// rereading a large tree, and a handful of options. Digests and jq results
// are GNU coreutils' and jq 1.7.1's.

describe("system identity", () => {
  bashCases([
    {
      name: "reports a Linux kernel name and this shell for the rest",
      files: { "/etc/hostname": "wiki-box\n" },
      script: "uname; uname -a; uname -sn; uname -m",
      stdout: "Linux\nLinux wiki-box cf-vfs #1 unknown cf-vfs\nLinux wiki-box\nunknown\n",
    },
    {
      name: "names localhost without /etc/hostname and refuses an operand",
      script: "uname -n; uname x",
      exitCode: 2,
      stdout: "localhost\n",
      stderrIncludes: "uname: extra operand x",
    },
    {
      name: "says what the shell is under --version",
      script: "bash --version; sh --version",
      stdout: "cf-vfs shell: a bounded Bash 5 language profile, not GNU Bash\n".repeat(2),
    },
  ]);
});

const TEXT = "plain\nwin\r\ncafé\ntab\there\n12-34\nfoo_bar baz\nx]y\na-b\n";

describe("grep -P", () => {
  bashCases(
    [
      {
        name: "finds carriage returns, tabs and non-ASCII text",
        script:
          "grep -cP '\\r' /t; grep -nP '[^\\x00-\\x7f]' /t; grep -P '\\t' /t; grep -P '\\x{e9}' /t",
        stdout: "1\n3:café\ntab\there\ncafé\n",
      },
      {
        name: "translates shorthand classes, escapes in brackets and (?:) groups",
        script:
          "grep -oP '\\d+' /t; grep -oP '\\w+_\\w+' /t; grep -P '[\\]]' /t; grep -cP '[\\w-]+-\\w' /t; grep -cP '^(?:win|tab)' /t; grep -P '(?i)PLAIN' /t",
        stdout: "12\n34\nfoo_bar\nx]y\n2\n2\nplain\n",
      },
      {
        name: "keeps a lone escaped caret and dash literal in brackets",
        script: "printf 'a^b\\nab\\n' | grep -P '[\\^]'; printf 'x-y\\nxy\\n' | grep -P 'x[\\-]y'",
        stdout: "a^b\nx-y\n",
      },
      {
        name: "refuses what only PCRE can express",
        script:
          "grep -P '(?<=x)y' /t; echo $?; grep -P 'a.*?b' /t; echo $?; grep -P '\\bwin' /t; echo $?; grep -oP 'a|b' /t; echo $?; grep -EP x /t; echo $?",
        stdout: "2\n2\n2\n2\n2\n",
        stderrIncludes: [
          "grep: -P does not support lookaround",
          "grep: -P does not support lazy quantifiers",
          "grep: -P does not support \\b",
          "grep: -P does not support | with -o",
          "grep: specify at most one of -F, -E and -P",
        ],
      },
    ].map((test) => ({ ...test, files: { "/t": TEXT } })),
  );
});

describe("file reads and pipes count against separate limits", () => {
  const tree = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`/w/p${index}.md`, `${"x".repeat(990)} key\n`]),
  );
  bashCases(
    [
      {
        name: "rereads a tree more times than total I/O would allow",
        files: tree,
        script: "for i in 1 2 3 4 5 6 7 8 9 10; do grep -rl key /w | wc -l; done | sort -u",
        stdout: "10\n",
      },
      {
        name: "still bounds data piped between commands",
        files: tree,
        script: "cat /w/*.md /w/*.md | wc -c",
        exitCode: 1,
        stderrIncludes: "shell total I/O byte limit exceeded",
      },
    ],
    { limits: { maxTotalIoBytes: 16_000, maxReadBytes: 1_000_000 } },
  );
  bashCases(
    [
      {
        name: "bounds file reads by their own limit",
        files: tree,
        script: "grep -rl key /w >/dev/null; grep -rl key /w",
        exitCode: 1,
        stderrIncludes: "shell file read byte limit exceeded",
      },
    ],
    { limits: { maxReadBytes: 15_000 } },
  );
});

describe("cp -a, md5sum, sha256sum from standard input, and jq string builtins", () => {
  bashCases([
    {
      name: "copies a tree with cp -a",
      script: "mkdir -p /d/s && echo x > /d/s/f && cp -a /d /e && cat /e/s/f",
      stdout: "x\n",
    },
    {
      name: "prints MD5 checksums of files and standard input",
      files: { "/a": "abc" },
      script:
        "printf '' | md5sum; md5sum /a /missing; echo $?; printf 'The quick brown fox jumps over the lazy dog' | md5sum -",
      stdout:
        "d41d8cd98f00b204e9800998ecf8427e  -\n900150983cd24fb0d6963f7d28e17f72  /a\n1\n9e107d9d372bb6826bd81d3542a419d6  -\n",
      stderr: "md5sum: /missing: no such file or directory\n",
    },
    {
      name: "hashes standard input with sha256sum",
      script: "printf abc | sha256sum",
      stdout: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n",
    },
    {
      name: "tests and trims affixes and changes ASCII case in jq",
      script: `echo '"Tags: Foo"' | jq -c '[startswith("Tags"), endswith("o"), ltrimstr("Tags: "), rtrimstr("oo"), ascii_downcase, ascii_upcase, (1 | ltrimstr("a"))]'`,
      stdout: '[true,true,"Foo","Tags: F","tags: foo","TAGS: FOO",1]\n',
    },
    {
      name: "reads a jq filter from a file with -f",
      files: { "/f.jq": ".a\n", "/i.json": '{"a":4}\n' },
      script: `echo '{"a":3}' | jq -f /f.jq; jq -f /f.jq /i.json`,
      stdout: "3\n4\n",
    },
    {
      name: "points regular-expression builtins at grep, sed and awk",
      script: `echo '"x"' | jq 'gsub("a"; "b")'`,
      exitCode: 3,
      stderr:
        "jq: gsub uses regular expressions, which this profile leaves out; use grep, sed or awk\n",
    },
  ]);
});
