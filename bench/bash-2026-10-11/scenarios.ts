/** No filesystem mutation; each script verifies its final result outside timing. */
export const scenarios = [
  {
    name: "literal-arguments",
    script: `for i in {1..300}; do : ${"workspace/path/without/braces ".repeat(20)}; done; printf done`,
    stdout: "done",
  },
  {
    name: "long-literal",
    script: `for i in {1..150}; do : ${"x".repeat(4096)}; done; printf done`,
    stdout: "done",
  },
  {
    name: "quoted-and-parameter",
    script:
      'value="two words"; for i in {1..500}; do : "$value" "literal text" "${value:-fallback}"; done; printf done',
    stdout: "done",
  },
  {
    name: "functions-and-arithmetic",
    script:
      'f() { local text="$1"; : "$text" path/to/file; ((sum+=1)); }; sum=0; for i in {1..500}; do f argument; done; printf "%s" "$sum"',
    stdout: "500",
  },
  {
    name: "brace-expansion",
    script: "for i in {1..200}; do : pre{a,b,c}{1..10}post; done; printf done",
    stdout: "done",
  },
] as const;
