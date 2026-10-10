import { cp, readFile, writeFile } from "node:fs/promises";

const root = "/tmp/cf-vfs-api-experiments/object-batch";
await cp("/tmp/cf-vfs-api-experiments/bounded128", root, { recursive: true });
let file = root + "/engine.mjs";
let s = await readFile(file, "utf8");
s = s.replace(
  "          await addToIndex({\n          dir,",
  "          fs.deferredObjects = new Map();\n          await addToIndex({\n          dir,",
);
s = s.replace(
  "        });\n        }\n      }\n    );",
  "        });\n          const objects=[...fs.deferredObjects].map(([path,body])=>({path,body}));\n          fs.deferredObjects=undefined;\n          if(objects.length)await fs._original_unwrapped_fs.promises.writeFiles(objects);\n        }\n      }\n    );",
);
s = s.replace(
  "  if (!(await fs.exists(filepath))) await fs.write(filepath, object);",
  "  if (!(await fs.exists(filepath))) {\n    if(fs.deferredObjects) fs.deferredObjects.set(filepath,object);\n    else await fs.write(filepath, object);\n  }",
);
await writeFile(file, s);
file = root + "/dist/shell/commands/git-fs.js";
s = await readFile(file, "utf8");
s = s.replace(
  "        writeFile: (path, body, options) =>",
  `        writeFiles: entries => this.operation(async()=>{
          const resolved=entries.map(({path,body})=>{this.check();this.context.budget.io(body.byteLength);return {path:commandPath(this.context,path),body};});
          await this.context.fileSystem.writeFiles(resolved,{createParents:true});
        }),
        writeFile: (path, body, options) =>`,
);
await writeFile(file, s);
file = root + "/dist/shell/policy.js";
s = await readFile(file, "utf8");
s = s.replace(
  "    lstat(path) {",
  `    async writeFiles(entries,options) {
      for(const entry of entries){this.write(entry.path);this.#budget.mutation();}
      return this.#inner.writeFiles(entries,options);
    }
    lstat(path) {`,
);
await writeFile(file, s);
file = root + "/dist/shell/devices.js";
s = await readFile(file, "utf8");
s = s.replace(
  "    lstat(path) {",
  `    writeFiles(entries,options) {
      for(const entry of entries)this.#refuseMutation(entry.path);
      return this.#inner.writeFiles(entries,options);
    }
    lstat(path) {`,
);
await writeFile(file, s);
console.log(root);
