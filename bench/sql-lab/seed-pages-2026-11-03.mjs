import { readFileSync } from "node:fs";
import { lab } from "./lab.mjs";

// Usage: node seed-pages-2026-11-03.mjs LAB FIXTURE.json [PAGES]
//
// Seeds PAGES pages (200 by default), taken evenly across FIXTURE's sorted
// paths, under /wiki: the small page set a Cloudflare check runs on.

const [name, fixture, pagesArg] = process.argv.slice(2);
if (!name || !fixture) throw new Error("usage: LAB FIXTURE.json [PAGES]");
const pages = Number(pagesArg ?? 200);
const { files } = JSON.parse(readFileSync(fixture, "utf8"));
const all = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1));
const step = Math.floor(all.length / pages);
const chosen = Array.from({ length: pages }, (_, index) => all[index * step]);
await lab(name).seed(Object.fromEntries(chosen.map(([path, body]) => [`wiki/${path}`, body])));
console.log(`seeded ${chosen.length} pages`);
