import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../src/shell/commands/default.js";
import { Shell } from "../src/shell/shell.js";
import { MemoryFileSystem } from "../src/vfs/memory.js";
import fixtures from "./fixtures/bash-v1.json" with { type: "json" };

describe(`Bash v1 differential fixtures (${fixtures.image}, LC_ALL=${fixtures.locale})`, () => {
  for (const fixture of fixtures.cases) {
    it(fixture.name, async () => {
      const shell = new Shell({
        fileSystem: new MemoryFileSystem(),
        commands: defaultShellCommands,
      });
      const result = await shell.executeText({
        script: fixture.script,
        env: fixture.env,
        args: fixture.args,
      });
      expect(result).toMatchObject({
        exitCode: fixture.exitCode,
        stdout: fixture.stdout,
        stderr: "",
      });
    });
  }
});
