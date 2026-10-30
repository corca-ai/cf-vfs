import { describe } from "vitest";
import { bashCases } from "./helpers/bash.js";

// String interpolation and @formats, recorded from jq 1.8.2. For these
// formats its `f_format` renders exactly what jq 1.7.1's does (the sources
// differ only in how `@uri` builds its result and in 1.8's new `@urid`).
// A failing filter is held to its status and to producing no output.

const CASES: readonly { input: string; filter: string; stdout: string; fails: boolean }[] = [
  {
    input: "null",
    filter: '"\\(1,2)-\\(3,4)"',
    stdout: '"1-3"\n"2-3"\n"1-4"\n"2-4"\n',
    fails: false,
  },
  {
    input: "null",
    filter: '"a\\("x")b\\(null)c\\([1,{"k":"v"}])d\\(1.5)e\\(true)"',
    stdout: '"axbnullc[1,{\\"k\\":\\"v\\"}]d1.5etrue"\n',
    fails: false,
  },
  {
    input: "null",
    filter: '{"\\("a","b")": 1}',
    stdout: '{"a":1}\n{"b":1}\n',
    fails: false,
  },
  {
    input: '{"k":"z","z":3}',
    filter: '."\\(.k)"',
    stdout: "3\n",
    fails: false,
  },
  {
    input: '{"k":"z"}',
    filter: '{"\\(.k)"}',
    stdout: '{"z":null}\n',
    fails: false,
  },
  {
    input: '[1,"a,b","q\\"x",null,true,2.5]',
    filter: "@csv, @tsv",
    stdout: '"1,\\"a,b\\",\\"q\\"\\"x\\",,true,2.5"\n"1\\ta,b\\tq\\"x\\t\\ttrue\\t2.5"\n',
    fails: false,
  },
  {
    input: '["a\\tb","c\\\\d\\ne",null,false]',
    filter: "@tsv",
    stdout: '"a\\\\tb\\tc\\\\\\\\d\\\\ne\\t\\tfalse"\n',
    fails: false,
  },
  {
    input: '"<&>\'\\""',
    filter: "@html",
    stdout: '"&lt;&amp;&gt;&apos;&quot;"\n',
    fails: false,
  },
  {
    input: '"a b/é?&=~-_."',
    filter: "@uri",
    stdout: '"a%20b%2F%C3%A9%3F%26%3D~-_."\n',
    fails: false,
  },
  {
    input: '["a b", 1, "c\'d", null, true]',
    filter: "@sh",
    stdout: "\"'a b' 1 'c'\\\\''d' null true\"\n",
    fails: false,
  },
  {
    input: '"it\'s"',
    filter: "@sh",
    stdout: "\"'it'\\\\''s'\"\n",
    fails: false,
  },
  {
    input: '"héllo"',
    filter: "@base64",
    stdout: '"aMOpbGxv"\n',
    fails: false,
  },
  {
    input: '"ab"',
    filter: "@base64",
    stdout: '"YWI="\n',
    fails: false,
  },
  {
    input: '"a"',
    filter: "@base64",
    stdout: '"YQ=="\n',
    fails: false,
  },
  {
    input: '""',
    filter: "@base64",
    stdout: '""\n',
    fails: false,
  },
  {
    input: '{"a":[1,"x"]}',
    filter: "@json, @text",
    stdout: '"{\\"a\\":[1,\\"x\\"]}"\n"{\\"a\\":[1,\\"x\\"]}"\n',
    fails: false,
  },
  {
    input: "[1,2]",
    filter: '@base64 "v=\\(.)", @json "j=\\(.)", @csv "c=\\(.)", @base64 "plain"',
    stdout: '"v=WzEsMl0="\n"j=[1,2]"\n"c=1,2"\n"plain"\n',
    fails: false,
  },
  {
    input: "null",
    filter: '"\\(1+2)\\(")")"',
    stdout: '"3)"\n',
    fails: false,
  },
  {
    input: "null",
    filter: '"\\u00e9\\("\\u00e9")"',
    stdout: '"éé"\n',
    fails: false,
  },
  {
    input: "1",
    filter: '@text "x\\(.)", @html "<\\(.)>"',
    stdout: '"x1"\n"<1>"\n',
    fails: false,
  },
  {
    input: '"<"',
    filter: '@html "\\(.)<"',
    stdout: '"&lt;<"\n',
    fails: false,
  },
  {
    input: "null",
    filter: '["\\(empty)x"]',
    stdout: "[]\n",
    fails: false,
  },
  {
    input: '{"a":"b"}',
    filter: '"\\(.a | ascii_upcase)-\\(.a | length)"',
    stdout: '"B-1"\n',
    fails: false,
  },
  {
    input: '[{"n":"x","c":2},{"n":"y","c":3}]',
    filter: '.[] | "\\(.n): \\(.c)"',
    stdout: '"x: 2"\n"y: 3"\n',
    fails: false,
  },
  {
    input: "null",
    filter: '"\\("nested \\("deep")")"',
    stdout: '"nested deep"\n',
    fails: false,
  },
  {
    input: "null",
    filter: '"tab\\t\\(1)"',
    stdout: '"tab\\t1"\n',
    fails: false,
  },
  {
    input: "[1,[2]]",
    filter: "@sh",
    stdout: "",
    fails: true,
  },
  {
    input: '{"a":1}',
    filter: "@csv",
    stdout: "",
    fails: true,
  },
  {
    input: "[[1]]",
    filter: "@tsv",
    stdout: "",
    fails: true,
  },
  {
    input: "1",
    filter: "@foo",
    stdout: "",
    fails: true,
  },
];

describe("jq string interpolation and formats", () => {
  bashCases(
    CASES.map(({ input, filter, stdout, fails }) => ({
      name: `${filter} on ${input}`,
      files: { "/in.json": input, "/f.jq": filter },
      script: "jq -c -f /f.jq /in.json",
      stdout,
      ...(fails ? { exitCode: 5, stderrIncludes: "jq: " } : {}),
    })),
  );
  bashCases([
    {
      name: "refuses the formats the profile leaves out before reading input",
      script: "echo '\"x\"' | jq '@base64d'",
      exitCode: 3,
      stderr: "jq: @base64d is not supported by this profile\n",
    },
    {
      name: "renders interpolated text raw with -r",
      script: 'echo \'{"n":"a b","c":2}\' | jq -r \'"\\(.n)\\t\\(.c)"\'',
      stdout: "a b\t2\n",
    },
  ]);
});
