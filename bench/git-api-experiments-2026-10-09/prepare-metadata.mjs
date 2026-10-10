import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const root = "/tmp/cf-vfs-api-experiments/stat-many";
await mkdir(root, { recursive: true });
await cp(process.argv[2] ?? "dist", root + "/dist", { recursive: true });
await writeFile(root + "/package.json", '{"type":"module"}');
let file = root + "/dist/vfs/sql-query-base.js";
let s = await readFile(file, "utf8");
s = s.replace(
  "    stat(path, access) {",
  `    statMany(paths, options={}, access) {
      if(paths.length>1024) throw new VfsError('E2BIG','metadata batch exceeds 1024 paths');
      if(paths.length===0)return [];
      if(this.links()!==0 || access!==undefined || paths.some(p=>hasDotSegments(p)||pathRequiresDirectory(p)))
        return paths.map(p=>this.statEntry(p,options.follow!==false,access));
      const normalized=paths.map(normalizePath);
      const rows=this.sql.exec('SELECT '+ENTRY_COLUMNS+' FROM vfs_entries e WHERE e.path IN (SELECT value FROM json_each(?))', JSON.stringify(normalized)).toArray();
      const map=new Map(rows.map(r=>{const entry=parseEntry(r,this.mutationEpoch);return [entry.path,entry];}));
      return normalized.map((p,i)=>{const row=map.get(p);if(!row)return this.statEntry(paths[i],options.follow!==false,access);
        return row.contentClass==='opaque'?this.statEntry(paths[i],options.follow!==false,access):rowToStat(row);});
    }
    stat(path, access) {`,
);
await writeFile(file, s);
file = root + "/dist/vfs/sql.js";
s = await readFile(file, "utf8");
s = s.replace(
  "    stat(path) {",
  `    statMany(paths, options) { return this.inner.statMany(paths,options,this.access); }
    stat(path) {`,
);
await writeFile(file, s);
file = root + "/dist/shell/policy.js";
s = await readFile(file, "utf8");
s = s.replace(
  "    lstat(path) {",
  `    statMany(paths,options={}) {
      for(const path of paths) { if(options.follow===false)this.readLink(path);else this.read(path); }
      return this.#inner.statMany ? this.#inner.statMany(paths,options) : paths.map(p=>options.follow===false?this.#inner.lstat(p):this.#inner.stat(p));
    }
    lstat(path) {`,
);
await writeFile(file, s);
file = root + "/dist/shell/devices.js";
s = await readFile(file, "utf8");
s = s.replace(
  "    lstat(path) {",
  `    statMany(paths,options={}) {
      if(paths.some(p=>this.#statAt(p)!==undefined))return paths.map(p=>options.follow===false?this.lstat(p):this.stat(p));
      return this.#inner.statMany ? this.#inner.statMany(paths,options) : paths.map(p=>options.follow===false?this.#inner.lstat(p):this.#inner.stat(p));
    }
    lstat(path) {`,
);
await writeFile(file, s);
file = root + "/dist/shell/commands/git-fs.js";
s = await readFile(file, "utf8");
s = s.replace("    failure;", "    failure;\n    metadataPending = [];");
s = s.replace(
  "new FsStats(this.context.fileSystem.lstat(commandPath(this.context, path)))",
  "this.batchLstat(path)",
);
s = s.replace(
  "    check() {",
  `    batchLstat(path) {
      return new Promise((resolve,reject)=>{
        this.metadataPending.push({path:commandPath(this.context,path),resolve,reject});
        if(this.metadataPending.length===1)queueMicrotask(()=>{
          const pending=this.metadataPending.splice(0);
          for(let offset=0;offset<pending.length;offset+=128){const batch=pending.slice(offset,offset+128);
            try {const stats=this.context.fileSystem.statMany(batch.map(p=>p.path),{follow:false});batch.forEach((p,i)=>p.resolve(new FsStats(stats[i])));}
            catch {for(const p of batch){try {p.resolve(new FsStats(this.context.fileSystem.lstat(p.path)));}catch(e){p.reject(e);}}}
          }
        });
      });
    }
    check() {`,
);
await writeFile(file, s);
console.log(root);
