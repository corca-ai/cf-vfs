import { readFile, writeFile } from "node:fs/promises";
import { LINUX_WORKSPACE } from "../src/shell/linux.js";
import { NodeSqlFileSystem } from "../src/testing/node.js";
import { evalShell, provisionEvalWorkspace, seedEvalWorkspace } from "./profile.js";

/**
 * Replays recorded agent sessions against the current shell, locally and in
 * seconds, instead of running agents again. Each session file holds the
 * fixture an instance was seeded with and its execution log:
 *
 *   { "name": "...", "files": { "wiki/a.md": "..." }, "entries": [ ...log... ] }
 *
 * Executions run in order on a fresh workspace with the clock pinned to each
 * logged time, so Git object IDs and timestamps can match. An execution whose
 * status turned to 0, or whose diagnostics went away, is `fixed`; the reverse
 * is `broke`; any other difference in status or output is `changed`, which
 * needs a look: it is often a corrected output. Once an execution that wrote files ends differently, later
 * executions may see a different tree, so they are marked `afterDivergence`
 * and do not count as regressions.
 *
 *   npm run eval:replay -- SESSION.json... [--json REPORT.json]
 *
 * Exits 1 when an execution before any divergence broke or changed.
 */

/** The log keeps at most this much of each stream; longer output is compared as a prefix. */
const LOGGED_OUTPUT_BYTES = 64 * 1024;

/** The fields of a `GET /log` entry the replay reads. */
interface ExecLogEntry {
  readonly seq: number;
  readonly at: number;
  readonly script: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly mutations: number;
}

interface Session {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly entries: readonly ExecLogEntry[];
}

type Verdict = "same" | "fixed" | "broke" | "changed";

interface Replayed {
  readonly seq: number;
  readonly script: string;
  readonly verdict: Verdict;
  readonly afterDivergence: boolean;
  readonly before: { readonly exitCode: number | null; readonly stderr: string };
  readonly after: { readonly exitCode: number | null; readonly stderr: string };
  readonly stdoutChanged: boolean;
  /** The current output, kept in the JSON report to compare with the log. */
  readonly stdout: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function logged(text: string): string {
  const bytes = encoder.encode(text);
  return bytes.byteLength <= LOGGED_OUTPUT_BYTES
    ? text
    : decoder.decode(bytes.subarray(0, LOGGED_OUTPUT_BYTES));
}

/**
 * A status that turned to 0, or diagnostics that went away without the status
 * getting worse, is a fix; the reverse is a break. A script often ends with a
 * command that succeeds, so the status alone misses a failure earlier in it.
 */
function verdict(
  before: ExecLogEntry,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): Verdict {
  if (before.exitCode === exitCode && before.stdout === logged(stdout)) {
    if (before.stderr === logged(stderr)) return "same";
  }
  const succeeded = before.exitCode === 0;
  const succeeds = exitCode === 0;
  if (succeeded !== succeeds) return succeeds ? "fixed" : "broke";
  const complained = before.stderr !== "";
  const complains = stderr !== "";
  if (complained !== complains) return complains ? "broke" : "fixed";
  return "changed";
}

async function replay(session: Session): Promise<Replayed[]> {
  let clock = session.entries[0]?.at ?? 0;
  const now = (): number => clock;
  const fileSystem = new NodeSqlFileSystem({ now });
  provisionEvalWorkspace(fileSystem);
  await seedEvalWorkspace(
    fileSystem,
    Object.entries(session.files).map(([path, content]) => ({ path, content })),
  );
  let cwd = LINUX_WORKSPACE;
  let diverged = false;
  const results: Replayed[] = [];
  for (const entry of session.entries) {
    clock = entry.at;
    if (!directoryExists(fileSystem, cwd)) cwd = LINUX_WORKSPACE;
    const shell = evalShell(fileSystem, cwd, { now });
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";
    try {
      ({ exitCode, stdout, stderr } = await shell.runText({ script: entry.script }));
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
    }
    cwd = shell.cwd;
    const result = verdict(entry, exitCode, stdout, stderr);
    results.push({
      seq: entry.seq,
      script: entry.script,
      verdict: result,
      afterDivergence: diverged,
      before: { exitCode: entry.exitCode, stderr: entry.stderr },
      after: { exitCode, stderr: logged(stderr) },
      stdoutChanged: entry.stdout !== logged(stdout),
      stdout: logged(stdout),
    });
    if (result !== "same" && entry.mutations > 0) diverged = true;
  }
  return results;
}

function directoryExists(fileSystem: NodeSqlFileSystem, path: string): boolean {
  try {
    return fileSystem.stat(path).kind === "directory";
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((part) => part.trim() !== "") ?? "";
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function report(name: string, results: readonly Replayed[]): number {
  const counts = { same: 0, fixed: 0, broke: 0, changed: 0 };
  for (const result of results) counts[result.verdict] += 1;
  const regressions = results.filter(
    (result) =>
      !result.afterDivergence && (result.verdict === "broke" || result.verdict === "changed"),
  );
  console.log(
    `${name}: ${results.length} executions, ${counts.same} same, ${counts.fixed} fixed, ` +
      `${counts.broke} broke, ${counts.changed} changed, ${regressions.length} before divergence`,
  );
  for (const result of results) {
    if (result.verdict === "same") continue;
    const marker = result.afterDivergence ? " (after divergence)" : "";
    console.log(`  #${result.seq} ${result.verdict}${marker}: ${firstLine(result.script)}`);
    console.log(
      `    exit ${result.before.exitCode} -> ${result.after.exitCode}` +
        (result.stdoutChanged ? ", stdout differs" : ""),
    );
    if (result.before.stderr !== result.after.stderr) {
      console.log(`    stderr was: ${firstLine(result.before.stderr) || "(empty)"}`);
      console.log(`    stderr now: ${firstLine(result.after.stderr) || "(empty)"}`);
    }
  }
  return regressions.length;
}

const args = process.argv.slice(2);
const jsonIndex = args.indexOf("--json");
const output = jsonIndex < 0 ? undefined : args[jsonIndex + 1];
const paths =
  jsonIndex < 0 ? args : args.filter((_, index) => index !== jsonIndex && index !== jsonIndex + 1);
if (paths.length === 0) throw new Error("Usage: eval:replay SESSION.json... [--json REPORT.json]");

const all: Record<string, Replayed[]> = {};
let regressions = 0;
for (const path of paths) {
  const session = JSON.parse(await readFile(path, "utf8")) as Session;
  const results = await replay(session);
  all[session.name] = results;
  regressions += report(session.name, results);
}
if (output !== undefined) await writeFile(output, `${JSON.stringify(all, null, 2)}\n`);
if (regressions > 0) process.exitCode = 1;
