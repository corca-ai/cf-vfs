import { expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { createBashHarness } from "./helpers/bash.js";

function awkHarness(options: Parameters<typeof createBashHarness>[0] = {}) {
  return createBashHarness({ ...options, commands: [awkCommand] });
}

it("streams default whitespace fields and record counters", async () => {
  const result = await awkHarness().run(`/bin/awk '{ print NR, NF, $1, $3 }'`, {
    stdin: " alpha  beta 3\nsecond row 4\n",
  });

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "1 3 alpha 3\n2 3 second 4\n",
    stderr: "",
  });
});

it("combines BEGIN configuration, patterns, expressions, accumulation, and END", async () => {
  const result = await awkHarness().run(
    `/bin/awk 'BEGIN { FS=":"; OFS="|" } $3 >= 10 && $1 ~ /^a/ { total += $3; print toupper($1), substr($2, 2) } END { printf "sum=%.1f\\n", total }'`,
    { stdin: "alpha:code:12\nbeta:doc:20\napricot:text:8\naxis:test:10\n" },
  );

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "ALPHA|ode\nAXIS|est\nsum=22.0\n",
    stderr: "",
  });
});

it("supports next, conditionals, updates, field assignment, and the default action", async () => {
  const result = await awkHarness().run(
    `/bin/awk '/skip/ { next } { seen++; if ($2 > max) max=$2; $1=toupper($1); print } END { print seen, max }'`,
    { stdin: "one 2\nskip 99\nthree 7\n" },
  );

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "ONE 2\nTHREE 7\n2 7\n",
    stderr: "",
  });
});

it("applies -F and repeated -v assignments", async () => {
  const result = await awkHarness().run(
    `/bin/awk -F: -v prefix=X -v n=2 'BEGIN { OFS="|" } { print prefix, $n }'`,
    { stdin: "a:b:c\n" },
  );

  expect(result).toMatchObject({ exitCode: 0, stdout: "X|b\n", stderr: "" });
});

it("tracks FNR and FILENAME independently across files", async () => {
  const harness = awkHarness();
  await harness.fileSystem.writeFile("/a", "a1\na2\n");
  await harness.fileSystem.writeFile("/b", "b1\n");

  const result = await harness.run(`/bin/awk '{ print FILENAME, FNR, NR, $1 }' /a /b`);

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "/a 1 1 a1\n/a 2 2 a2\n/b 1 3 b1\n",
    stderr: "",
  });
});

it("uses expression-only patterns as the default print action", async () => {
  const result = await awkHarness().run(`/bin/awk '$2 ~ /error|warn/'`, {
    stdin: "a ok\nb error\nc warn\n",
  });

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "b error\nc warn\n",
    stderr: "",
  });
});

it("keeps the separator from record-read time when BEGIN or an action changes FS", async () => {
  const result = await awkHarness().run(`/bin/awk 'BEGIN { FS=":" } { FS=","; print $2 }'`, {
    stdin: "a:b\nc,d\n",
  });

  expect(result).toMatchObject({ exitCode: 0, stdout: "b\nd\n", stderr: "" });
});

it("validates a regular-expression FS before consuming records", async () => {
  const result = await awkHarness().run(`/bin/awk 'BEGIN { FS="(x" } { print NF }'`, {
    stdin: "value\n",
  });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("awk: unmatched (");
});

it("allows parenthesized comparison output but rejects AWK output redirection", async () => {
  const comparison = await awkHarness().run(`/bin/awk '{ print ($1 > 1) }'`, {
    stdin: "2\n",
  });
  expect(comparison).toMatchObject({
    exitCode: 0,
    stdout: "1\n",
    stderr: "",
  });

  const redirection = await awkHarness().run(`/bin/awk '{ print $1 > "out" }'`, {
    stdin: "value\n",
  });
  expect(redirection.exitCode).toBe(2);
  expect(redirection.stderr).toContain("output redirection inside AWK is not supported");
});

it("bounds printf fields before allocating their padding", async () => {
  const result = await awkHarness({ limits: { maxStdoutBytes: 32 } }).run(
    `/bin/awk 'BEGIN { printf "%1000000s", "x" }'`,
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("awk: printf field exceeds the execution limit");

  const precision = await awkHarness().run(`/bin/awk 'BEGIN { printf "%.1000f", 1 }'`);
  expect(precision.exitCode).toBe(1);
  expect(precision.stderr).toContain("floating-point precision exceeds the execution limit");
});

it("refuses unsupported record-separator changes instead of ignoring them", async () => {
  const result = await awkHarness().run(`/bin/awk 'BEGIN { RS=":" } { print }'`, {
    stdin: "a:b",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("record separators other than newline are unsupported");
});

it("does not open stdin for a BEGIN-only program", async () => {
  let pulls = 0;
  const stdin = new ReadableStream<Uint8Array>({
    type: "bytes",
    pull() {
      pulls += 1;
      throw new Error("stdin must stay unread");
    },
  });

  const result = await awkHarness().run(`/bin/awk 'BEGIN { print "ready" }'`, { stdin });

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "ready\n",
    stderr: "",
  });
  expect(pulls).toBe(0);
});

it("preserves statement separation after an if without else", async () => {
  const result = await awkHarness().run(
    `/bin/awk '{ if ($1) { print "first" }
print "second" }'`,
    { stdin: "1\n" },
  );

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "first\nsecond\n",
    stderr: "",
  });
});

it("runs END after exit and returns the requested status", async () => {
  const result = await awkHarness().run(
    `/bin/awk '{ if (NR == 2) exit 7; print $1 } END { print "end", NR }'`,
    { stdin: "one\ntwo\nthree\n" },
  );

  expect(result).toMatchObject({
    exitCode: 7,
    stdout: "one\nend 2\n",
    stderr: "",
  });
});

it("supports bounded associative arrays, composite keys, membership, deletion, and for-in", async () => {
  const result = await awkHarness().run(
    `/bin/awk '{ count[$1]++; pair[$1,$2]=$3 } END { print count["a"], count["b"], pair["a",2]; print (("a",2) in pair), length(count); missing=count["z"]; print ("z" in count); delete count["b"]; print ("b" in count); for (key in count) total += count[key]; print total }'`,
    { stdin: "a 1 first\na 2 second\nb 1 third\n" },
  );

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "2 1 second\n1 2\n1\n0\n2\n",
    stderr: "",
  });
});

it("returns array entry and byte budget after deletion and split replacement", async () => {
  const deleted = await awkHarness({
    limits: { maxBufferedBytes: 6, maxBufferedRecords: 1 },
  }).run(
    `/bin/awk 'BEGIN { value["가"]="나"; delete value["가"]; value["다"]="라"; saved=value["다"]; delete value["다"]; print saved }'`,
  );
  expect(deleted).toMatchObject({ exitCode: 0, stdout: "라\n", stderr: "" });

  const replaced = await awkHarness({ limits: { maxBufferedRecords: 3 } }).run(
    `/bin/awk 'BEGIN { split("a:b:c", part, /:/); split("d:e", part, /:/); print length(part), part[1], part[2] }'`,
  );
  expect(replaced).toMatchObject({ exitCode: 0, stdout: "2 d e\n", stderr: "" });
});

it("supports split, match, sub, and gsub with writable targets", async () => {
  const result = await awkHarness().run(
    `/bin/awk '{ n=split($0, part, /[:,]/); gsub(/[0-9]+/, "#", part[2]); sub(/^./, "&-", part[1]); found=match(part[3], /[A-Z]+/); print n, part[1], part[2], found, RSTART, RLENGTH }'`,
    { stdin: "ab:123:XYZ\n" },
  );

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "3 a-b # 1 1 3\n",
    stderr: "",
  });
});

it("treats an empty record and empty split source as zero fields", async () => {
  const result = await awkHarness().run(
    `/bin/awk 'BEGIN { FS=":"; print split("", part, ","), length(part) } { print NF }'`,
    { stdin: "\n" },
  );

  expect(result).toMatchObject({ exitCode: 0, stdout: "0 0\n0\n", stderr: "" });
});

it("evaluates an array lvalue subscript once", async () => {
  const result = await awkHarness().run(
    `/bin/awk 'BEGIN { i=1; a[i++]=i; a[i++]++; sub(/2/,"x",a[1]); print a[1], a[2], i }'`,
  );

  expect(result).toMatchObject({ exitCode: 0, stdout: "x 1 3\n", stderr: "" });
});

it("runs C-style for, while, do-while, break, and continue under the shared budget", async () => {
  const result = await awkHarness().run(
    `/bin/awk 'BEGIN { for (i=0; i<5; i++) { if (i==2) continue; sum+=i } while (i<7) i++; do { i++; if (i==9) break } while (i<20); print sum, i }'`,
  );

  expect(result).toMatchObject({ exitCode: 0, stdout: "8 9\n", stderr: "" });
});

it("keeps independent inclusive state for range patterns", async () => {
  const result = await awkHarness().run(
    `/bin/awk '/start/,/end/ { print $1 } /open/,/close/ { count++ } END { print count }'`,
    { stdin: "skip\nstart\nopen\nend\nclose\nstart end\nafter\n" },
  );

  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "start\nopen\nend\nstart\n3\n",
    stderr: "",
  });
});

it("loads and combines bounded programs from repeated -f operands", async () => {
  const harness = awkHarness();
  await harness.fileSystem.writeFile("/first.awk", `BEGIN { FS=":" }\n{ total += $2 }`);
  await harness.fileSystem.writeFile("/last.awk", `END { print total }`);
  await harness.fileSystem.writeFile("/data", "a:2\nb:3\n");

  const result = await harness.run(`/bin/awk -f /first.awk -f /last.awk /data`);

  expect(result).toMatchObject({ exitCode: 0, stdout: "5\n", stderr: "" });
});

it("parses every -f program before opening data input", async () => {
  const harness = awkHarness();
  await harness.fileSystem.writeFile("/bad.awk", `{ print`);
  let pulls = 0;
  const stdin = new ReadableStream<Uint8Array>({
    type: "bytes",
    pull() {
      pulls += 1;
      throw new Error("data input must stay unread");
    },
  });

  const result = await harness.run(`/bin/awk -f /bad.awk`, { stdin });

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("awk:");
  expect(pulls).toBe(0);
});

it("bounds array growth and non-terminating loops", async () => {
  const array = await awkHarness({ limits: { maxBufferedRecords: 2 } }).run(
    `/bin/awk 'BEGIN { seen["a"]=1; seen["b"]=1; seen["c"]=1 }'`,
  );
  expect(array.exitCode).toBe(1);
  expect(array.stderr).toContain("array entry limit exceeded");

  const bytes = await awkHarness({ limits: { maxBufferedBytes: 3 } }).run(
    `/bin/awk 'BEGIN { seen["long"]="value" }'`,
  );
  expect(bytes.exitCode).toBe(1);
  expect(bytes.stderr).toContain("shell buffered-byte limit exceeded");

  const fields = await awkHarness({ limits: { maxBufferedRecords: 2 } }).run(
    `/bin/awk '{ print NF }'`,
    { stdin: "a b c\n" },
  );
  expect(fields.exitCode).toBe(1);
  expect(fields.stderr).toContain("awk: field limit exceeded");

  const rebuilt = await awkHarness({ limits: { maxBufferedRecords: 2 } }).run(
    `/bin/awk 'BEGIN { $3=1 }'`,
  );
  expect(rebuilt.exitCode).toBe(1);
  expect(rebuilt.stderr).toContain("awk: field limit exceeded");

  const substitution = await awkHarness({ limits: { maxExpansionChars: 128 } }).run(
    `/bin/awk 'BEGIN { value="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; gsub(/a/, "&&&&&&&&", value) }'`,
  );
  expect(substitution.exitCode).toBe(1);
  expect(substitution.stderr).toContain("substitution exceeds the expansion limit");

  const loop = await awkHarness({ limits: { maxLoopIterations: 3 } }).run(
    `/bin/awk 'BEGIN { while (1) { } }'`,
  );
  expect(loop.exitCode).toBe(1);
  expect(loop.stderr).toContain("shell loop iteration limit exceeded");
});

it.each([
  ["user functions", `function f(x) { return x }`, "unsupported construct function"],
  ["getline", `{ getline value }`, "unsupported construct getline"],
  ["out-of-loop break", `{ break }`, "break is not inside a loop"],
])("rejects unsupported %s before consuming input", async (_name, program, diagnostic) => {
  const result = await awkHarness().run(`/bin/awk '${program}'`, {
    stdin: "unread\n",
  });

  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(diagnostic);
});

it("shares the shell step bound across record evaluation", async () => {
  const result = await awkHarness({ limits: { maxSteps: 8 } }).run(
    `/bin/awk '{ total += $1 } END { print total }'`,
    { stdin: "1\n2\n3\n" },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("shell execution step limit exceeded");
});
