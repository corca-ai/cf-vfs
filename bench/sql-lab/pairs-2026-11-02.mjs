import { appendFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: SCRIPTS='{"label":"script",...}' node pairs-2026-11-02.mjs LAB SESSION OUT.jsonl [PAIRS]
//
// The paired comparison of runtime-pairs-2026-10-31.mjs for any scripts:
// the lab bundles a baseline shell beside the candidate's (the scaffolding
// patch), and each pair runs both on the same object, alternating which goes
// first. Meant for a local `cf dev` lab (LAB_URL).

const [name, session, out, pairsArg] = process.argv.slice(2);
if (!name || !session || !out) throw new Error("usage: LAB SESSION OUT.jsonl [PAIRS]");
const scripts = JSON.parse(process.env.SCRIPTS ?? "{}");
const pairs = Number(pairsArg ?? 6);
const w = lab(name);
for (let pair = 0; pair < pairs; pair += 1) {
  for (const [what, script] of Object.entries(scripts)) {
    const order = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const outputs = {};
    for (const version of order) {
      const result = await w.shell(script, version === "baseline" ? { version } : {});
      outputs[version] = `${result.exitCode}\n${result.stdout}\n${result.stderr}`;
      appendFileSync(
        out,
        `${JSON.stringify({ session, pair, what, version, ms: result.ms, exit: result.exitCode })}\n`,
      );
    }
    if (outputs.baseline !== outputs.candidate) {
      console.log(
        `OUTPUT DIFFERS: ${what}\n--- baseline\n${outputs.baseline.slice(0, 400)}\n--- candidate\n${outputs.candidate.slice(0, 400)}`,
      );
    }
  }
}
