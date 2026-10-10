import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";

const root = "/tmp/cf-vfs-api-experiments";
await mkdir(root, { recursive: true });
try {
  await symlink(process.cwd() + "/node_modules", root + "/node_modules");
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}
const engine = await readFile("node_modules/isomorphic-git/index.js", "utf8");
for (const name of ["baseline", "bounded32", "bounded64", "bounded128"]) {
  const at = root + "/" + name;
  await mkdir(at, { recursive: true });
  await cp(process.argv[2] ?? "dist", at + "/dist", { recursive: true });
  await writeFile(at + "/package.json", '{"type":"module"}');
  let source = engine;
  if (name !== "baseline") {
    const size = Number(name.slice(7));
    const needle = "        return addToIndex({\n          dir,";
    if (!source.includes(needle)) throw Error("engine match missing");
    source = source.replace(
      needle,
      `        const batches = Array.isArray(filepath) ? filepath : [filepath];\n        for (let offset=0; offset<batches.length; offset+=${size}) {\n          await addToIndex({\n          dir,`,
    );
    const end =
      "          filepath,\n          index,\n          force,\n          parallel,\n          autocrlf,\n        })";
    if (!source.includes(end)) throw Error("engine end missing");
    source = source.replace(
      end,
      `          filepath: batches.slice(offset, offset+${size}),\n          index,\n          force,\n          parallel,\n          autocrlf,\n        });\n        }`,
    );
    let work = await readFile(at + "/dist/shell/commands/git-worktree.js", "utf8");
    work = work.replace(
      "for (const batch of stagingBatches(selected, sizes))",
      "for (const batch of [selected])",
    );
    await writeFile(at + "/dist/shell/commands/git-worktree.js", work);
  }
  await writeFile(at + "/engine.mjs", source);
  for (const mod of ["git", "git-worktree", "git-status", "git-local", "git-repository"]) {
    const file = at + "/dist/shell/commands/" + mod + ".js";
    let text = await readFile(file, "utf8");
    text = text.replaceAll('from "isomorphic-git"', 'from "../../../engine.mjs"');
    await writeFile(file, text);
  }
}
console.log(root);
