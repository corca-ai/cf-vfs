import { expect, it } from "vitest";
import { awkCommand } from "../src/shell/commands/awk.js";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import type { ShellDerivedLimits } from "../src/shell/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

async function shellWith(files: Record<string, string>, limits: Partial<ShellDerivedLimits> = {}) {
  const fileSystem = createTestFileSystem();
  for (const [path, body] of Object.entries(files)) await fileSystem.writeFile(path, body);
  return new Shell({
    fileSystem,
    commands: [...defaultShellCommands, awkCommand],
    limits,
  });
}

const run = (shell: Shell, script: string) =>
  shell.executeText({ cwd: "/", script: `${script}; echo "status $?"` });

it("reads a file of any number of lines through commands that hold none of them", async () => {
  const lines = Array.from({ length: 150_000 }, (_, i) => `${i}\n`).join("");
  const shell = await shellWith({ "/big": lines });
  for (const [script, out] of [
    ["grep -c 9 /big", "58146"],
    ["awk 'END { print NR }' /big", "150000"],
    ["sed -n '$p' /big", "149999"],
    ["uniq /big | wc -l", "150000"],
    ["cat /big | grep -c 9", "58146"],
    ["cut -c1 /big | uniq -c | wc -l", "47"],
    ["head -n 120000 /big | tail -1", "119999"],
    ["grep -l 149999 /big", "/big"],
  ]) {
    expect((await run(shell, script as string)).stdout).toBe(`${out}\nstatus 0\n`);
  }
  // Holding every line is still bounded.
  expect((await run(shell, "sort /big | tail -1")).stderr).toContain("buffered record limit");
});

it("lets a pipeline carry more than one edge's buffer", async () => {
  const half = "x"
    .repeat(1023)
    .concat("\n")
    .repeat(6 * 1024);
  const shell = await shellWith({ "/a": half, "/b": half });
  expect((await run(shell, "cat /a /b | cat | wc -c")).stdout).toBe("12582912\nstatus 0\n");
});

it("charges each pipeline stage while it runs", async () => {
  const shell = await shellWith({ "/a": "a\n" });
  const stages = (count: number) => `cat /a${" | cat".repeat(count)}`;
  expect((await run(shell, stages(20))).stdout).toBe("a\nstatus 0\n");
  const many = await shellWith({ "/a": "a\n" }, { maxBufferedBytes: 1024 * 1024 });
  expect((await run(many, stages(20))).stderr).toContain("buffered-byte limit");
  // A pipeline gives its stages back when it settles, failed or not.
  const loop =
    "for i in 1 2 3 4 5 6 7 8; do cat /a | cat | cat | cat | wc -l; done; cat /none | cat | cat";
  const reused = await run(many, `${loop}; ${stages(9)}`);
  expect(reused.stdout).toBe(`${"1\n".repeat(8)}a\nstatus 0\n`);
});

it("charges searches that rescan a line, and many cheap patterns, as expansion work", async () => {
  const shell = await shellWith(
    { "/line": `${"x".repeat(4000)}\n`, "/t": "abcdefghij xyz owner 12345\n".repeat(400) },
    { maxExpansionWork: 2_000 },
  );
  const many = Array.from({ length: 60 }, (_, k) => `-e 'y{0,3}x${k}a|y{0,3}x${k}b'`).join(" ");
  for (const script of [
    "grep -cwE 'x[^z]*z|x' /line",
    "sed -E 's/x[^z]*z|x/y/g' /line",
    `grep -cE ${many} /t`,
    "awk -v r='y{0,3}xa|y{0,3}xb' '{ for (i = 0; i < 60; i++) if ($0 ~ r) c++ }' /t",
  ]) {
    expect((await run(shell, script)).stderr).toContain("expansion work limit");
  }
});

it("charges a pattern's steps as expansion work", async () => {
  const text = "abcdefghij xyz owner 12345 lorem ipsum\n".repeat(2_000);
  const shell = await shellWith({ "/t": text }, { maxExpansionWork: 100_000 });
  const branches = Array.from({ length: 120 }, (_, i) => `y{0,3}x${i}`).join("|");
  for (const script of [
    `grep -cE '${branches}' /t`,
    `sed -n -E '/${branches}/p' /t`,
    `awk '/${branches}/' /t`,
    `awk '{ n += gsub(/${branches}/, "") } END { print n }' /t`,
    `awk -v re='${branches}' '$0 ~ re' /t`,
    `sed -E 's/${branches}/-/g' /t`,
  ]) {
    expect((await run(shell, script)).stderr).toContain("expansion work limit");
  }
  // Patterns that cost a few steps a position fit the limit.
  for (const script of ["grep -cE '[a-z]+ [0-9]+' /t", "sed -n -E '/(own|xyz)er/p' /t | wc -l"]) {
    expect((await run(shell, script)).stdout).toBe("2000\nstatus 0\n");
  }
});
