import { describe, expect, it } from "vitest";
import { defaultShellCommands } from "../../src/shell/commands/default.js";
import { Shell } from "../../src/shell/shell.js";
import type {
  ExecuteTextOptions,
  ExecuteTextResult,
  ShellCommand,
  ShellOptions,
} from "../../src/shell/types.js";
import type { NodeSqlFileSystem } from "../../src/testing/node.js";
import { readAllBytes } from "../../src/vfs/streams.js";
import { type ByteBody, MAX_INLINE_FILE_BYTES } from "../../src/vfs/types.js";
import { createTestFileSystem } from "./node-sql.js";

type BashSource = string | readonly string[];

export interface BashHarnessOptions extends Omit<ShellOptions, "fileSystem" | "commands"> {
  fileSystem?: NodeSqlFileSystem;
  commands?: readonly ShellCommand[];
  extraCommands?: readonly ShellCommand[];
}

export interface BashHarness {
  fileSystem: NodeSqlFileSystem;
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

export type BashCase = BashCaseBase &
  (
    | { stderr?: string; stderrIncludes?: never }
    | { stderr?: never; stderrIncludes: string | readonly string[] }
  );

function commandList(...commands: readonly string[]): string {
  return commands.join(";\n");
}

function sourceText(source: BashSource): string {
  return typeof source === "string" ? source : commandList(...source);
}

export function createBashHarness(options: BashHarnessOptions = {}): BashHarness {
  const {
    fileSystem = createTestFileSystem(),
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
  fileSystem: NodeSqlFileSystem,
  files: Readonly<Record<string, ByteBody>>,
): Promise<void> {
  for (const [path, body] of Object.entries(files)) {
    await fileSystem.writeFile(path, body, { createParents: true });
  }
}

function caseRunOptions(specification: BashCase): Omit<ExecuteTextOptions, "script"> {
  return {
    ...(specification.stdin === undefined ? {} : { stdin: specification.stdin }),
    ...(specification.cwd === undefined ? {} : { cwd: specification.cwd }),
    ...(specification.env === undefined ? {} : { env: specification.env }),
    ...(specification.args === undefined ? {} : { args: specification.args }),
    ...(specification.signal === undefined ? {} : { signal: specification.signal }),
  };
}

function expectStderr(result: ExecuteTextResult, specification: BashCase): void {
  if (specification.stderrIncludes === undefined) {
    expect(result.stderr).toBe(specification.stderr ?? "");
    return;
  }
  const fragments =
    typeof specification.stderrIncludes === "string"
      ? [specification.stderrIncludes]
      : specification.stderrIncludes;
  for (const fragment of fragments) expect(result.stderr).toContain(fragment);
}

async function expectFiles(harness: BashHarness, specification: BashCase): Promise<void> {
  for (const [path, expected] of Object.entries(specification.expectedFiles ?? {})) {
    expect(await harness.readText(path), path).toBe(expected);
  }
  for (const path of specification.missingFiles ?? []) {
    expect(() => harness.fileSystem.stat(path), path).toThrowError(
      expect.objectContaining({ code: "ENOENT" }),
    );
  }
}

async function runBashCase(specification: BashCase, options: BashHarnessOptions): Promise<void> {
  const harness = createBashHarness(options);
  await arrangeFiles(harness.fileSystem, specification.files ?? {});
  const result = await harness.run(specification.script, caseRunOptions(specification));

  expect(result.exitCode).toBe(specification.exitCode ?? 0);
  expect(result.stdout).toBe(specification.stdout ?? "");
  expectStderr(result, specification);
  await expectFiles(harness, specification);
}

export function bashCases(cases: readonly BashCase[], options: BashHarnessOptions = {}): void {
  for (const specification of cases) {
    it(specification.name, () => runBashCase(specification, options));
  }
}

/** Registers a data-driven Bash suite without hiding its case table in one giant callback. */
export function bashSuite(
  name: string,
  cases: readonly BashCase[],
  options: BashHarnessOptions = {},
): void {
  describe(name, () => bashCases(cases, options));
}
