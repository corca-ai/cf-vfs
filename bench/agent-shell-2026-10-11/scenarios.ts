/** Non-interactive coding tasks; every execution has deterministic output. */
const manifest = JSON.stringify({
  name: "agent-project",
  version: "1.0.0",
  description: "Project documentation with Unicode 한글 😀 and paths src/module.ts. ".repeat(700),
  scripts: { test: "vitest run", build: "tsc" },
  dependencies: { alpha: "1.0.0", beta: "2.0.0" },
});
const source = "export const feature = 'old'; // project source 한글\n".repeat(200);
const dependencies = JSON.stringify({
  dependencies: Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [
      `module-${i}`,
      {
        version: `1.0.${i}`,
        resolved: `https://registry.example/module-${i}.tgz`,
        integrity: `sha512-${"a".repeat(90)}`,
      },
    ]),
  ),
});
export const files = {
  "/package.json": manifest,
  "/dependencies.json": dependencies,
  "/small.json": JSON.stringify({
    name: "agent-project",
    version: "1.0.0",
    scripts: { test: "vitest run" },
  }),
  "/escaped.json": JSON.stringify({ description: 'path\\to\\file\n"quoted" 한글😀'.repeat(500) }),
  "/source.ts": source,
  "/records.txt": "alpha\nbeta\nalpha\ngamma\n".repeat(200),
  "/task.sh": `#!/bin/bash
set -e
name=$(jq -r '.name' /package.json)
jq -c '. + {version: "2.0.0"}' /package.json > /next.json
sed 's/old/new/g' /source.ts > /next.ts
count=$(grep -c new /next.ts)
printf '%s:%s\\n' "$name" "$count"
`,
} as const;
export const scenarios = [
  {
    name: "dependency-inspection",
    script: "jq '.dependencies | keys | length' /dependencies.json",
    stdout: "300\n",
  },
  {
    name: "dependency-roundtrip",
    script:
      "jq -c . /dependencies.json > /dependencies-out.json; jq '.dependencies | keys | length' /dependencies-out.json",
    stdout: "300\n",
  },
  { name: "small-manifest", script: "jq -r .name /small.json", stdout: "agent-project\n" },
  {
    name: "many-small-commands",
    script: "for i in {1..20}; do name=$(jq -r .name /small.json); done; printf '%s\\n' \"$name\"",
    stdout: "agent-project\n",
  },
  {
    name: "escaped-json",
    script:
      "jq -c . /escaped.json > /escaped-out.json; jq -r .description /escaped-out.json | wc -l",
    stdout: "501\n",
  },
  {
    name: "manifest-inspection",
    script: "jq -r '.name, .version, .scripts.test' /package.json",
    stdout: "agent-project\n1.0.0\nvitest run\n",
  },
  {
    name: "manifest-update",
    script:
      "jq -c '. + {version: \"2.0.0\"}' /package.json > /next.json; jq -r .version /next.json",
    stdout: "2.0.0\n",
  },
  {
    name: "source-edit",
    script: "sed 's/old/new/g' /source.ts > /next.ts; grep -c new /next.ts",
    stdout: "200\n",
  },
  {
    name: "pipeline-summary",
    script: "cat /records.txt | sort | uniq -c",
    stdout: "    400 alpha\n    200 beta\n    200 gamma\n",
  },
  { name: "bash-file-workflow", script: "bash /task.sh", stdout: "agent-project:200\n" },
] as const;

export const expectedFiles: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "dependency-roundtrip": { "/dependencies-out.json": `${dependencies}\n` },
  "manifest-update": {
    "/next.json": `${manifest.replace('"version":"1.0.0"', '"version":"2.0.0"')}\n`,
  },
  "source-edit": { "/next.ts": source.replaceAll("old", "new") },
  "escaped-json": { "/escaped-out.json": `${files["/escaped.json"]}\n` },
  "bash-file-workflow": {
    "/next.json": `${manifest.replace('"version":"1.0.0"', '"version":"2.0.0"')}\n`,
    "/next.ts": source.replaceAll("old", "new"),
  },
};
