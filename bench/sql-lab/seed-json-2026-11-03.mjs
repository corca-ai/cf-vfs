import { lab } from "./lab.mjs";

// Usage: node seed-json-2026-11-03.mjs LAB [FILES]
//
// Seeds FILES (2,000 by default) small JSON documents under /data/items —
// the kind of records an agent filters with jq — deterministically, so a
// baseline and a candidate read the same bytes.

const [name, filesArg] = process.argv.slice(2);
if (!name) throw new Error("usage: LAB [FILES]");
const count = Number(filesArg ?? 2000);
const owners = ["ana", "bo", "chen", "dara", "eli", "fay", "gus", "hana"];
const files = {};
for (let index = 0; index < count; index += 1) {
  const item = {
    id: index,
    title: `Item ${index}: ${"lorem ipsum ".repeat(1 + (index % 5)).trim()}`,
    owner: owners[index % owners.length],
    size: (index * 7919) % 1000,
    tags: Array.from({ length: 1 + (index % 4) }, (_, tag) => `t${(index + tag) % 13}`),
    links: Array.from({ length: index % 6 }, (_, link) => ({ to: (index * 31 + link) % count })),
    body: `${"text ".repeat(40 + (index % 60))}`.trim(),
  };
  files[`data/items/item-${String(index).padStart(5, "0")}.json`] =
    `${JSON.stringify(item, null, 2)}\n`;
}
await lab(name).seed(files);
console.log(`seeded ${count} JSON files`);
