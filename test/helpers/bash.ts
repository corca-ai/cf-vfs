import { expect, it } from "vitest";
import { defaultShellCommands } from "../../src/shell/commands/default.js";
import { Shell } from "../../src/shell/shell.js";
import type {
  ExecuteTextOptions,
  ExecuteTextResult,
  ShellCommand,
  ShellOptions,
} from "../../src/shell/types.js";
import { MemoryFileSystem } from "../../src/vfs/memory.js";
import { readAllBytes } from "../../src/vfs/streams.js";
import { MAX_INLINE_FILE_BYTES, type ByteBody } from "../../src/vfs/types.js";

export type BashSource = string | readonly string[];

export interface BashHarnessOptions extends Omit<ShellOptions, "fileSystem" | "commands"> {
  fileSystem?: MemoryFileSystem;
  commands?: readonly ShellCommand[];
  extraCommands?: readonly ShellCommand[];
}

export interface BashHarness {
  fileSystem: MemoryFileSystem;
  shell: Shell;
  run(source: BashSource, options?: Omit<ExecuteTextOptions, "script">): Promise<ExecuteTextResult>;
  readText(path: string): Promise<string>;
}

interface BashCaseBase extends Omit<ExecuteTextOptions, "script"> {
  name: string;
  script: BashSource;
  files?: Readonly<Record<string, ByteBody>>;
  exitCode?: number;
  stdout?: string;
  expectedFiles?: Readonly<Record<string, string>>;
  missingFiles?: readonly string[];
}

export type BashCase = BashCaseBase & (
  | { stderr?: string; stderrIncludes?: never }
  | { stderr?: never; stderrIncludes: string | readonly string[] }
);

export function commandList(...commands: readonly string[]): string {
  return commands.join(";\n");
}

function sourceText(source: BashSource): string {
  return typeof source === "string" ? source : commandList(...source);
}

export function createBashHarness(options: BashHarnessOptions = {}): BashHarness {
  const {
    fileSystem = new MemoryFileSystem(),
    commands = defaultShellCommands,
    extraCommands = [],
    ...shellOptions
  } = options;
  const shell = new Shell({
    fileSystem,
    commands: [...commands, ...extraCommands],
    ...shellOptions,
  });
  return {
    fileSystem,
    shell,
    run(source, runOptions = {}) {
      return shell.executeText({ script: sourceText(source), ...runOptions });
    },
    async readText(path) {
      const bytes = await readAllBytes(fileSystem.readFile(path).stream, MAX_INLINE_FILE_BYTES);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
  };
}

async function arrangeFiles(
  fileSystem: MemoryFileSystem,
  files: Readonly<Record<string, ByteBody>>,
): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    await fileSystem.writeFile(path, body, { createParents: true });
  }
}

export function bashCases(cases: readonly BashCase[]): void {
  for (const specification of cases) {
    it(specification.name, async () => {
      const harness = createBashHarness();
      await arrangeFiles(harness.fileSystem, specification.files ?? {});
      const result = await harness.run(specification.script, {
        ...(specification.stdin === undefined ? {} : { stdin: specification.stdin }),
        ...(specification.cwd === undefined ? {} : { cwd: specification.cwd }),
        ...(specification.env === undefined ? {} : { env: specification.env }),
        ...(specification.args === undefined ? {} : { args: specification.args }),
        ...(specification.signal === undefined ? {} : { signal: specification.signal }),
      });

      expect(result.exitCode).toBe(specification.exitCode ?? 0);
      expect(result.stdout).toBe(specification.stdout ?? "");
      if (specification.stderrIncludes === undefined) {
        expect(result.stderr).toBe(specification.stderr ?? "");
      } else {
        const fragments = typeof specification.stderrIncludes === "string"
          ? [specification.stderrIncludes]
          : specification.stderrIncludes;
        for (const fragment of fragments) expect(result.stderr).toContain(fragment);
      }
      for (const [path, expected] of Object.entries(specification.expectedFiles ?? {})) {
        expect(await harness.readText(path), path).toBe(expected);
      }
      for (const path of specification.missingFiles ?? []) {
        expect(() => harness.fileSystem.stat(path), path).toThrowError(
          expect.objectContaining({ code: "ENOENT" }),
        );
      }
    });
  }
}
