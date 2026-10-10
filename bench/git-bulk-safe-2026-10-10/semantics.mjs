import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [baseline, copyVersion, batchVersion, output] = process.argv.slice(2);
async function probe(rootPath, scenario) {
  const root = pathToFileURL(`${resolve(rootPath)}/`);
  const { NodeSqlFileSystem } = await import(new URL("testing/node.js", root));
  const { Shell } = await import(new URL("shell/shell.js", root));
  const { gitCommand } = await import(new URL("shell/commands/git.js", root));
  const { CollaborativeFileSystem, DocumentRegistry, applyTextEdits } = await import(
    new URL("collab/index.js", root)
  );
  const raw = new NodeSqlFileSystem();
  const registry = new DocumentRegistry();
  const view = new CollaborativeFileSystem(raw, registry);
  const shell = new Shell({ fileSystem: view, commands: [gitCommand] });
  const run = (script) => shell.executeText({ script, cwd: "/repo" });
  const ok = async (script) => {
    const r = await run(script);
    assert.equal(r.exitCode, 0, r.stderr);
    return r;
  };
  try {
    assert.equal((await shell.executeText({ script: "git init /repo" })).exitCode, 0);
    await ok("git config user.name Test; git config user.email test@example.invalid");
    await raw.writeFile("/repo/f0", "base\n");
    await ok("git add -A; git commit -m base; git branch base");
    const path = scenario === "copy-open-source" ? "/repo/.git/objects/info/note" : "/repo/f0";
    await raw.writeFile(path, "stored\n");
    if (scenario === "checkout-open-target") await ok("git add -A; git commit -m next");
    let text = "stored\n";
    const document = {
      text: () => text,
      applyExternal: (edits) => {
        text = applyTextEdits(text, edits);
      },
    };
    registry.open(path, document, raw.stat(path).mutationToken);
    if (scenario === "copy-open-source") {
      text = "pending\n";
      registry.markDirty(path);
    }
    const result = await run(
      scenario === "copy-open-source" ? "git clone /repo /copy" : "git checkout --force base",
    );
    const copied =
      scenario === "copy-open-source" && result.exitCode === 0
        ? await new Response(raw.readFile("/copy/.git/objects/info/note").stream).text()
        : null;
    return {
      scenario,
      exitCode: result.exitCode,
      stderr: result.stderr,
      copied,
      documentText: text,
    };
  } finally {
    raw.close();
  }
}
const rows = [];
for (const scenario of ["copy-open-source", "checkout-open-target"]) {
  rows.push({ version: "baseline", ...(await probe(baseline, scenario)) });
  rows.push({
    version: "candidate",
    ...(await probe(scenario === "copy-open-source" ? copyVersion : batchVersion, scenario)),
  });
}
await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`);
console.log(JSON.stringify(rows, null, 2));
