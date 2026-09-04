import { expect, it } from "vitest";
import { createBashHarness } from "./helpers/bash.js";

it("keeps an in-place source intact when accumulated output exceeds the byte budget", async () => {
  const { fileSystem, run, readText } = createBashHarness({ limits: { maxBufferedBytes: 256 } });
  const before = "x\n".repeat(50);
  await fileSystem.writeFile("/input", before);
  const result = await run("sed -i 's/x/xxxxxxxxxx/' /input");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/limit/);
  expect(await readText("/input")).toBe(before);
});

it("bounds multibyte replacement growth before a discarded result is assembled", async () => {
  const { run } = createBashHarness({ limits: { maxBufferedBytes: 256 } });
  const result = await run("sed -n 's/.*/&&&&/;d'", { stdin: "😀".repeat(20) });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/limit/);
});

it("charges global substitution loops even when matching produces no output", async () => {
  const { run } = createBashHarness({ limits: { maxSteps: 40 } });
  const result = await run("sed -n 's/x//g'", { stdin: "x".repeat(100) });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/step limit/);
});
