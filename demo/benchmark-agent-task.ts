import { defaultShellCommands } from "../src/shell/commands/default.js";
import { gitCommand } from "../src/shell/commands/git.js";
import { Shell } from "../src/shell/shell.js";
import type { PosixVirtualFileSystem } from "../src/vfs/types.js";

export const TASK_PHASES = ["inspect", "edit", "verify", "stage", "commit"] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];
const credentials = { uid: 1000, gid: 1000 };

/** Ordinary Git, independent shell executions, one permission-bound workspace. */
export class AgentTask {
  private readonly shell: Shell;
  private round = 0;
  constructor(private readonly fs: PosixVirtualFileSystem) {
    this.shell = new Shell({
      fileSystem: fs,
      commands: [...defaultShellCommands, gitCommand],
      now: () => 1700000000000,
    });
  }
  private async execute(script: string) {
    const result = await this.shell.executeText({ script, cwd: "/repo", credentials });
    if (result.exitCode !== 0 || result.stderr !== "")
      throw new Error(`Agent task failed: ${JSON.stringify(result)}`);
    return result.stdout;
  }
  async prepare() {
    this.fs.setMetadata("/", { mode: 0o40777 });
    const view = this.fs.forCredentials(credentials);
    view.mkdir("/repo");
    for (let i = 0; i < 1000; i++)
      await view.writeFile(`/repo/src/d${i % 20}/f${i}.txt`, this.body(i, 0), {
        createParents: true,
      });
    await this.execute(
      "git init && git config user.name Bench && git config user.email bench@example.invalid && git add . && git commit -m initial",
    );
  }
  private body(i: number, round: number) {
    return `export const value = 'state${round}'; // ${i}\n`;
  }
  async phase(phase: TaskPhase) {
    if (phase === "inspect") {
      this.round++;
      if ((await this.execute("git status --short")) !== "")
        throw new Error("Task starts with a dirty repository");
      return "";
    }
    const next = `state${this.round}`;
    if (phase === "edit")
      return this.execute(
        Array.from(
          { length: 20 },
          (_, i) =>
            `sed 's/state[0-9]*/${next}/g' src/d${i}/f${i}.txt > src/d${i}/next.txt && cat src/d${i}/next.txt > src/d${i}/f${i}.txt && rm src/d${i}/next.txt`,
        ).join(" && "),
      );
    if (phase === "verify") {
      const output = await this.execute(
        Array.from({ length: 20 }, (_, i) => `grep -c ${next} src/d${i}/f${i}.txt`).join(" && "),
      );
      if (output !== "1\n".repeat(20)) throw new Error("Edited content did not validate");
      return output;
    }
    if (phase === "stage") return this.execute("git add .");
    return this.execute(`git commit -m round${this.round}`);
  }
  async cycle() {
    const outputs = [];
    for (const phase of TASK_PHASES) outputs.push(await this.phase(phase));
    return outputs;
  }
  async validate() {
    const view = this.fs.forCredentials(credentials);
    for (let i = 0; i < 1000; i++) {
      const read = view.readFile(`/repo/src/d${i % 20}/f${i}.txt`);
      const text = await new Response(read.stream).text();
      if (text !== this.body(i, i < 20 ? this.round : 0))
        throw new Error(`Task body mismatch: ${i}`);
    }
    if ((await this.execute("git status --short")) !== "")
      throw new Error("Task leaves a dirty repository");
    return 1001;
  }
}
