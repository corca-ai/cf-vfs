import { appendFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node runtime-pairs-2026-10-31.mjs LAB SESSION [PAIRS]
//
// Paired comparison inside one deployment: the lab bundles main's shell
// beside the candidate's (version "baseline" or the default), so each pair
// runs both on the same object, minutes apart at most, alternating which goes
// first. Appends one JSON line per run to runtime-pairs-2026-10-31-LAB.jsonl.

const [name, session, pairsArg] = process.argv.slice(2);
if (!name || !session) throw new Error("usage: LAB SESSION [PAIRS]");
const pairs = Number(pairsArg ?? 6);
const w = lab(name);
const SCRIPTS = {
  "awk FNR==1 glob > null": "awk 'FNR == 1' /wiki/*/*.md > /dev/null",
  "awk print $1 glob | wc -l": "awk '{ print $1 }' /wiki/*/*.md | wc -l",
  "wc -l glob | tail -1": "wc -l /wiki/*/*.md | tail -1",
  "awiki lint cold": "awiki lint -r -root /wiki > /dev/null; echo $?",
  "grep -rc owner | tail": "grep -rc owner /wiki | tail -1",
  "cat dir | grep -c x": "cat /wiki/sales/*.md | grep -c owner",
};
const out = new URL(`./runtime-pairs-2026-10-31-${name}.jsonl`, import.meta.url);
for (let pair = 0; pair < pairs; pair += 1) {
  for (const [what, script] of Object.entries(SCRIPTS)) {
    const order = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    const outputs = {};
    for (const version of order) {
      const result = await w.shell(script, version === "baseline" ? { version } : {});
      outputs[version] = result.stdout;
      appendFileSync(
        out,
        `${JSON.stringify({ session, pair, what, version, ms: result.ms, exit: result.exitCode })}\n`,
      );
    }
    if (outputs.baseline !== outputs.candidate) console.log(`OUTPUT DIFFERS: ${what}`);
  }
  console.log(`pair ${pair} done`);
}
