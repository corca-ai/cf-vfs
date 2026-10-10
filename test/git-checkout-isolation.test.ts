import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import type { VirtualFileSystem } from "../src/vfs/types.js";
import { createTestFileSystem } from "./helpers/node-sql.js";

it("a stalled checkout does not hold another filesystem's same-path index lock", async () => {
  const first = createTestFileSystem();
  const second = createTestFileSystem();
  for (const vfs of [first, second]) {
    const shell = new Shell({ fileSystem: vfs, commands: [gitCommand] });
    await shell.executeText({ script: "git init /checkout-isolation" });
    const run = (script: string) => shell.executeText({ script, cwd: "/checkout-isolation" });
    await run("git config user.name Test; git config user.email test@example.invalid");
    await vfs.writeFile("/checkout-isolation/a", "committed");
    expect((await run("git add a; git commit -m initial")).exitCode).toBe(0);
    await vfs.writeFile("/checkout-isolation/a", "dirty");
  }
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const held = new Proxy(first, {
    get(target, property) {
      if (property === "forCredentials") return undefined;
      if (property === "writeFiles")
        return async (...args: Parameters<VirtualFileSystem["writeFiles"]>) => {
          if (args[0].some((entry) => entry.path === "/checkout-isolation/a")) {
            entered.resolve();
            await resume.promise;
          }
          return target.writeFiles(...args);
        };
      if (property === "writeFile")
        return async (...args: Parameters<VirtualFileSystem["writeFile"]>) => {
          if (args[0] === "/checkout-isolation/a") {
            entered.resolve();
            await resume.promise;
          }
          return target.writeFile(...args);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const pending = new Shell({ fileSystem: held, commands: [gitCommand] }).executeText({
    script: "git checkout --force main",
    cwd: "/checkout-isolation",
  });
  await entered.promise;
  const independent = new Shell({ fileSystem: second, commands: [gitCommand] }).executeText({
    script: "git checkout --force main",
    cwd: "/checkout-isolation",
  });
  try {
    const completed = await Promise.race([independent, delay(1000).then(() => undefined)]);
    expect(completed?.exitCode, "independent checkout blocked on another filesystem").toBe(0);
  } finally {
    resume.resolve();
    await Promise.all([pending, independent]);
  }
});
