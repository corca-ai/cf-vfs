import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Regenerates `test/fixtures/awiki-compat.json` by running the native awiki
// CLI (the version below, from PATH or $AWIKI) over each case's files. The
// binary is a development oracle only; the shell command never runs it.
//
// Must match `WORKDIR` in test/awiki-differential.test.ts.
const WORKDIR = "/work";
const VERSION = "0.5.1";
const binary = process.env.AWIKI ?? "awiki";
const fixtureUrl = new URL("../test/fixtures/awiki-compat.json", import.meta.url);

const reported = spawnSync(binary, ["version"], { encoding: "utf8" }).stdout.trim();
if (reported !== VERSION) throw new Error(`expected awiki ${VERSION}, found ${reported || "none"}`);

// --- a deterministic wiki large enough for sampling and duplicates ---------------

function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const pick = (items) => items[Math.floor(next() * items.length)];
  return { next, pick };
}

const WORDS = (
  "graph node edge path wiki note link page topic theory proof model data search index " +
  "cache query vector space time event agent memory review plan draft release team"
).split(" ");

function randomWiki(seed, count) {
  const { next, pick } = generator(seed);
  const names = Array.from({ length: count }, (_, index) => `${pick(WORDS)} ${pick(WORDS)} ${index}`);
  const files = {};
  const sentence = (length) =>
    Array.from({ length }, () => pick(WORDS)).join(" ").replace(/^./u, (c) => c.toUpperCase());
  names.forEach((name, index) => {
    const lines = [];
    if (next() < 0.6) {
      lines.push("---", `title: ${name}`);
      if (next() < 0.3) lines.push(`aliases: [${pick(WORDS)}-${index}]`);
      lines.push("---", "");
    }
    lines.push(`# ${name}`, "");
    const paragraphs = 1 + Math.floor(next() * 4);
    for (let paragraph = 0; paragraph < paragraphs; paragraph += 1) {
      let text = sentence(6 + Math.floor(next() * 30));
      // Links prefer nearby pages, so the graph has long paths.
      const links = Math.floor(next() * 3);
      for (let link = 0; link < links; link += 1) {
        const target =
          next() < 0.08
            ? `missing ${pick(WORDS)}`
            : names[Math.max(0, Math.min(count - 1, index + Math.floor((next() - 0.5) * 12)))];
        text += next() < 0.2 ? ` see [${pick(WORDS)}](<${target}.md>).` : ` see [[${target}]].`;
      }
      lines.push(text, "");
      if (next() < 0.1) lines.push(`- [[${pick(names)}]]`, "");
    }
    // Near-duplicate pairs: a few pages repeat a long shared passage.
    if (index % 37 === 5) lines.push(DUPLICATE_PASSAGE, "");
    if (index % 37 === 6) lines.push(`${DUPLICATE_PASSAGE} With one more remark.`, "");
    files[`${name}.md`] = lines.join("\n");
  });
  return files;
}

const DUPLICATE_PASSAGE =
  "The review cycle starts with a short planning note that lists every open question, " +
  "the owner of each answer, and the date the team expects to decide. Each answer links " +
  "the source that settled it so a later reader can follow the reasoning without asking. " +
  "When the plan changes, the note records what changed and why, and the old text stays " +
  "visible below a dated heading so nobody loses the history of the decision.";

// --- the cases ----------------------------------------------------------------

const FLAT = {
  "Graph theory.md": [
    "---",
    "title: Graph theory",
    "aliases:",
    "  - Graphs",
    '  - "Network theory"',
    "tags: [math]",
    "---",
    "",
    "# Graph theory",
    "",
    "Studies graphs as mathematical objects. See [[Vertex]] and [[Edge|edges]].",
    "Compare with [[Probability#History|history of chance]] and [[Missing note]].",
    "- [[Vertex]]",
    "> **[[Edge]]**",
    "1. [[Combinatorics]]",
    "- [ ] [[Probability]]",
    "## [[Bayes theorem]]",
    "Inline `[[Not a link]]` code and an image ![alt](Vertex.md) and [site](https://example.com).",
    "Mail [me](mailto:me@example.com) or [jump](#section) or [doc](<Combinatorics.md#Counting>).",
    "```",
    "[[Inside fence]]",
    "```",
    "~~~~",
    "[[Also fenced]]",
    "~~~",
    "still fenced [[Fenced too]]",
    "~~~~",
    "Table cell [[Vertex\\|vertices]] and [[ Edge | spaced ]].",
    "",
  ].join("\n"),
  "Vertex.md": "A node in a graph. Back to [[Graph theory]] and [[graphs]].\n",
  "Edge.md": "---\ntitle: Edge\naliases: [Link, 'Arc']\n---\nConnects two [[vertex|vertices]] in [[Graph Theory]].\n",
  "Combinatorics.md": "Studies discrete structures and counting, [[Graph theory]] included.\r\n\r\n- [[Missing note]]\r\n",
  "Probability.md": "---\ntitle: Probability\n---\n\n## History\n\nMeasures how likely an event is. Leads to [[Bayes theorem]].\n",
  "Bayes theorem.md": "Relates prior belief to updated evidence, building on [[Probability]].\n[[Missing note]] and [[Another gap]] and [[another gap#x]].\n",
  "Island A.md": "First island page, linked with [[Island B]].\n",
  "Island B.md": "Second island page.\n",
  "Lonely.md": "",
  "Front only.md": "---\ntitle: Front only\n---\n",
  "Code only.md": "```\njust code\n```\n",
  "Bom.md": "﻿---\ntitle: Bom\n---\nThe byte order mark keeps this from being front matter. [[Vertex]]\n",
  "Café.md": "Unicode name, linked from nowhere but linking to [[Café au lait]] and [[Vertex]].\n",
  "한국어 문서.md": "한국어 본문입니다. [[Graph theory]]와 연결됩니다.\n",
  "notes.txt": "[[Vertex]] is not counted from a text file.\n",
  "sub/Nested.md": "Ignored without -recursive. [[Vertex]]\n",
};

const RECURSIVE = {
  "index.md": "Start at [[goals/login]] or [[login]] or [plan](plans/plan.md).\n",
  "goals/login.md": "---\ntitle: Login goal\n---\nUsers sign in. See [[../plans/plan]] and [[plan#Steps|steps]].\n",
  "plans/plan.md": "Plan for [[login]] and [[./sub/detail]] and [[goals/missing]].\n",
  "plans/sub/detail.md": "Details. Up to [parent](../plan.md) and [[index]].\n",
  "other/login.md": "A second login page, reachable only by path. [[index]]\n",
  ".hidden/secret.md": "[[index]]\n",
  "node_modules/pkg/readme.md": "[[index]]\n",
  "vendor/lib.md": "[[index]]\n",
};

const FORMAT = {
  "Messy.md": [
    "---",
    "tags: [b, a, b]",
    "title:   'Messy page'   ",
    "owner: someone",
    "aliases: Single",
    "# a comment",
    "extra:",
    "  nested: value",
    "---",
    "#Not a heading",
    "##   Heading with trailing hashes ##   ",
    "Text right after heading.   ",
    "",
    "",
    "",
    "* star item",
    "+ plus item",
    "  * nested star",
    "A [[ Page | Alias ]] and [[Page|]] and [[ Page # Section ]] and [ Text ]( ./note.md ).",
    "Code `[[ keep ]]` untouched.",
    "```",
    "  keep   spacing   ",
    "",
    "",
    "```",
    "Last line without newline   ",
  ].join("\n"),
  "Clean.md": "---\ntitle: Clean\n---\n\nAlready clean.\n",
  "Quoted.md": "---\ntitle: 'Colon: in title'\naliases: [\"-dash\", 'a, b', plain]\ntags: []\n---\nBody\n\n\n",
  "Empty title.md": "---\ntitle:\n---\n# Only heading\n",
};

const RENAME = {
  "Old Page.md": "---\ntitle: Old Page\n---\n# Old Page\nSelf link [[Old Page#Top]].\n",
  "Linker.md": [
    "Links: [[Old Page]], [[old page|Label]], [[Old Page#Sec]], [[Old Page.md]], [[Old Page\\|Esc]].",
    "Markdown: [x](Old%20Page.md) [y](<Old Page.md#S>) [z](./Old Page.md) ![img](<Old Page.md>).",
    "Code `[[Old Page]]` and prefix [[Old Page 2]].",
    "```",
    "[[Old Page]]",
    "```",
    "",
  ].join("\n"),
  "Front.md": "---\ntitle: Front\nrelated: [[Old Page]]\n---\nBody.\n",
  "Old Page 2.md": "A different page.\n",
};

const RECURSIVE_RENAME = {
  "a/note.md": "---\ntitle: a/note\n---\nSee [[b/other]].\n",
  "b/other.md": "Back to [[note]] and [[a/note]] and [n](../a/note.md).\n",
};

/** Same basenames in different folders: only links that resolve to the page change. */
const RECURSIVE_COLLISION = {
  "a/note.md": "---\ntitle: note\n---\nSelf [[note]].\n",
  "b/note.md": "Unrelated note.\n",
  "c/x.md":
    "[[b/note]] [[a/note]] [[note]] [[../a/note#S|s]] [[./y]] [up](../a/note.md) [other](../b/note.md) ![i](../a/note.md) [sp]( <../a/note.md#T> )\n",
  "c/y.md": "[[x]] and [[../c/x]]\n",
  "deep/old.md": "Old.\n",
  "taken.md": "Already at the root.\n",
  "index.md": "[[old]] and [o](deep/old.md) and [[deep/old.md]]\n",
};

const DUPLICATES = {
  "First.md": `${DUPLICATE_PASSAGE}\n\nLinks to [[Second]].\n`,
  "Second.md": `${DUPLICATE_PASSAGE} One more sentence here.\n\n[[First]]\n`,
  "Third.md": `Something else entirely about ${DUPLICATE_PASSAGE.slice(0, 160)}.\n`,
  "한국.md": `${"위키 문서는 서로 연결되어야 하며 각 문서는 맥락을 가진 링크를 포함해야 합니다. ".repeat(4)}\n`,
  "조선.md": `${"위키 문서는 서로 연결되어야 하며 각 문서는 맥락을 가진 링크를 포함해야 합니다. ".repeat(4)}추가 문장.\n`,
};

const EDGES = {
  "Hub.md": [
    "---",
    "aliases:",
    "",
    "  - Center",
    "  -  'Middle'  ",
    "title: \"Hub\"",
    "---",
    "**[[Alpha]]**",
    "[Beta](Beta.md)",
    "- [[Gamma|g]]",
    "[[Delta]] -",
    "1) [[Alpha]]",
    "> - [[Beta]]",
    "[[Alpha]] [[Beta]]",
    "- [[Gamma]] (more)",
    "* [x] [[Delta]]",
    "#### [[Gamma]]",
    "####### [[Alpha]]",
    "Twice [[Missing]] and [[missing#Part]] here; [[MISSING|x]] too.",
    "[[ ]] and [[#Only heading]] and [[./]] and [[a/b/Gamma.md]].",
    "[spaced](Delta.md \"title\") [bare](Delta) [img2](Beta.md).",
    "````",
    "```",
    "[[Fenced]]",
    "````",
    "After [[Delta]] fence.",
    "",
  ].join("\n"),
  "Alpha.md": "---\ntitle: Shared\n---\nAlpha body.\n",
  "Beta.md": "---\naliases: Shared\n---\nBeta body.\n",
  "Gamma.md": "\t  Indented first line with  spaces\tand tabs.  \n",
  "Delta.md": `${"Long line of text that goes on. ".repeat(10)}\n`,
  "Epsilon.md": "---\n---\n# Heading only\n",
};

/** 32 pages, one an orphan: rates land exactly on a rounding tie. */
const RING = Object.fromEntries([
  ...Array.from({ length: 31 }, (_, index) => [
    `p${index + 1}.md`,
    `Page ${index + 1} links [[p${((index + 1) % 31) + 1}]] here.\n`,
  ]),
  ["z.md", "alone\n"],
]);

const ERRORS = ["", "bogus", "bogus --version", "help", "version", "-h"];

const cases = [
  {
    name: "flat wiki",
    files: FLAT,
    steps: [
      "lint",
      "lint -h",
      "links 'Graph theory'",
      "links graphs",
      "links 'network theory'",
      "links Lonely",
      "links Link",
      "links 'Missing note'",
      "links",
      "path Vertex 'Bayes theorem'",
      "path Vertex 'Island A'",
      "path Vertex Vertex",
      "wanted",
      "wanted -n 1 -sources 1",
      "wanted -sources 0 -n 0",
      "wanted -n -1",
      "wanted extra",
      "avg-shortest-path",
      "avg-shortest-path -samples 3 -examples 2 -seed 9",
      "avg-shortest-path -samples 0",
      "suggest",
      "suggest --filter=wanted-pressure,short-stubs -n 2 --short-words 5",
      "suggest --filter long-pages --long-lines 3 --long-words 20",
      "suggest --filter bogus",
      "suggest --filter ,",
      "suggest --duplicate-threshold 1.5",
      "suggest -h",
      "lint -root sub",
      "lint -root missing",
      "lint -root notes.txt",
      "lint -x",
      "format extra",
      "links -h",
      "path -h",
      "rename --help",
      "wanted -help",
      "avg-shortest-path -h",
      "format -h",
      ...ERRORS,
    ],
  },
  {
    name: "recursive wiki",
    files: RECURSIVE,
    steps: [
      "lint -r",
      "lint",
      "links -r goals/login",
      "links -r login",
      "links -r plans/sub/detail",
      "path -r index plans/sub/detail",
      "wanted -r",
      "suggest -r --filter sampled-diameter,wanted-pressure",
    ],
  },
  { name: "format", files: FORMAT, mutates: true, steps: ["format", "format", "lint"] },
  {
    name: "rename",
    files: RENAME,
    mutates: true,
    steps: [
      "rename 'Old Page' 'Old Page 2'",
      "rename 'Old Page' 'bad:name'",
      "rename 'Old Page' ''",
      "rename 'Old Page' 'New Page'",
      "links 'New Page'",
      "rename missing x",
    ],
  },
  {
    name: "recursive rename",
    files: RECURSIVE_RENAME,
    mutates: true,
    steps: ["rename -r a/note fresh", "rename -r b/other c/moved", "links -r c/moved"],
  },
  {
    name: "recursive rename resolution",
    files: RECURSIVE_COLLISION,
    mutates: true,
    steps: [
      "rename -r a/note d/moved",
      "rename -r deep/old taken",
      "rename -r c/x z",
      "rename -r c/y c/sub/y2",
      "lint -r",
    ],
  },
  {
    name: "near duplicates",
    files: DUPLICATES,
    steps: [
      "suggest --filter near-duplicates",
      "suggest --filter near-duplicates --duplicate-threshold 0.3 --short-words 10",
      "suggest --filter short-stubs,long-pages --long-words 30",
    ],
  },
  {
    name: "edge cases",
    files: EDGES,
    steps: [
      "lint",
      "links Hub",
      "links Center",
      "links middle",
      "links Shared",
      "links alpha.md",
      "links '<Alpha>'",
      "wanted -sources 0",
      "suggest --filter long-pages,short-stubs --long-lines 2 --long-words 50 --short-words 3",
      "suggest --filter=near-duplicates --duplicate-threshold=nan",
      "suggest --filter=near-duplicates --duplicate-threshold=+.5e0",
      "suggest --samples=-1",
      "suggest -limit 1 -seed=3",
      "path Gamma Delta",
      "rename Hub 'Hub 2'",
      "format",
      "lint",
    ],
    mutates: true,
  },
  {
    name: "rounding ties",
    files: RING,
    steps: ["lint", "suggest --filter short-stubs --short-words 3", "avg-shortest-path -samples 7"],
  },
  {
    name: "generated wiki",
    files: randomWiki(20261030, 160),
    steps: [
      "lint",
      "suggest",
      "suggest --samples 50 --paths 2 --seed 7",
      "avg-shortest-path -samples 1000 -examples 3 -seed 42",
      "avg-shortest-path",
      "wanted -n 5",
    ],
  },
];

// --- running ------------------------------------------------------------------

function snapshot(root) {
  const files = {};
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[path.slice(root.length + 1)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const base = realpathSync(mkdtempSync(join(tmpdir(), "awiki-oracle-")));
try {
  const recorded = [];
  for (const fixture of cases) {
    const root = join(base, "work");
    rmSync(root, { recursive: true, force: true });
    for (const [path, content] of Object.entries(fixture.files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const results = fixture.steps.map((step) => {
      const run = spawnSync("sh", ["-c", `"$AWIKI_BIN" ${step}`], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, AWIKI_BIN: binary },
      });
      const local = (text) => text.replaceAll(root, WORKDIR);
      return {
        step,
        exitCode: run.status,
        stdout: local(run.stdout),
        stderr: local(run.stderr),
        ...(fixture.mutates ? { files: snapshot(root) } : {}),
      };
    });
    recorded.push({ name: fixture.name, files: fixture.files, results });
  }
  writeFileSync(fixtureUrl, `${JSON.stringify({ awiki: VERSION, workdir: WORKDIR, cases: recorded }, null, 1)}\n`);
} finally {
  rmSync(base, { recursive: true, force: true });
}
