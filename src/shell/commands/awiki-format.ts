import { fileSystemOrigin } from "../fs-origin.js";
import type { ShellCommandContext } from "../types.js";
import {
  frontMatterEnd,
  splitKeyValue,
  splitWikiLinkParts,
  trimYamlScalar,
} from "./awiki-parse.js";
import {
  debugQuote,
  FenceState,
  isAsciiWhitespace,
  scanLines,
  trim,
  trimEnd,
  trimLine,
  trimStart,
} from "./awiki-text.js";
import { readContent, type Vault } from "./awiki-vault.js";

// --- front matter -----------------------------------------------------------

interface Entry {
  key: string | undefined;
  readonly lines: string[];
}

function topLevelKey(line: string): string | undefined {
  if (trim(line) === "" || line.startsWith(" ") || line.startsWith("\t")) return undefined;
  if (trimStart(line).startsWith("#")) return undefined;
  return splitKeyValue(line)?.[0];
}

function parseEntries(lines: readonly string[]): Entry[] {
  const entries: Entry[] = [];
  let current: Entry = { key: undefined, lines: [] };
  for (const line of lines) {
    const text = trimEnd(trimLine(line));
    const key = topLevelKey(text);
    if (key !== undefined && current.lines.length > 0) {
      entries.push(current);
      current = { key: undefined, lines: [] };
    }
    if (current.lines.length === 0) current.key = key;
    current.lines.push(text);
  }
  if (current.lines.length > 0) entries.push(current);
  return entries;
}

function splitQuotedCommas(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (quote === undefined && (character === "'" || character === '"')) quote = character;
    else if (quote === character) quote = undefined;
    else if (quote === undefined && character === ",") {
      out.push(value.slice(start, index));
      start = index + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function parseYamlList(value: string, rest: readonly string[]): string[] {
  const trimmed = trim(value);
  if (trimmed === "") {
    return rest
      .map((line) => trim(line))
      .filter((line) => line.startsWith("- "))
      .map((line) => trim(trimYamlScalar(line.slice(2))))
      .filter((item) => item !== "");
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trim(trimmed.slice(1, -1));
    if (inner === "") return [];
    return splitQuotedCommas(inner)
      .map((item) => trim(trimYamlScalar(trim(item))))
      .filter((item) => item !== "");
  }
  const scalar = trim(trimYamlScalar(trimmed));
  return scalar === "" ? [] : [scalar];
}

function listValues(entry: Entry): string[] {
  const first = entry.lines[0];
  const pair = first === undefined ? undefined : splitKeyValue(trim(first));
  return pair === undefined ? [] : parseYamlList(pair[1], entry.lines.slice(1));
}

const QUOTED_START = new Set([..."-{}[]&*#!|>@`"]);

function formatYamlScalar(value: string): string {
  const quoted =
    value === "" ||
    QUOTED_START.has(value.charAt(0)) ||
    value.includes(": ") ||
    value.includes(" #") ||
    /[[\],]/u.test(value);
  return quoted ? debugQuote(value) : value;
}

function yamlList(key: string, values: readonly string[]): string {
  const seen: string[] = [];
  for (const raw of values) {
    const value = trim(raw);
    if (value !== "" && !seen.includes(value)) seen.push(value);
  }
  if (seen.length === 0) return "";
  return `${key}:\n${seen.map((value) => `  - ${formatYamlScalar(value)}\n`).join("")}`;
}

function formatFrontMatter(lines: readonly string[]): string {
  let title: string | undefined;
  const aliases: string[] = [];
  const tags: string[] = [];
  const other: string[][] = [];
  for (const entry of parseEntries(lines)) {
    const pair = splitKeyValue(trim(entry.lines[0] ?? ""));
    if (entry.key === "title" && pair !== undefined) title = trimYamlScalar(pair[1]);
    else if (entry.key === "aliases") aliases.push(...listValues(entry));
    else if (entry.key === "tags") tags.push(...listValues(entry));
    else other.push(entry.lines);
  }
  let out = "---\n";
  if (title !== undefined && trim(title) !== "") out += `title: ${formatYamlScalar(trim(title))}\n`;
  out += yamlList("aliases", aliases);
  out += yamlList("tags", tags);
  for (const entry of other) for (const line of entry) out += `${trimLine(line)}\n`;
  return `${out}---\n\n`;
}

// --- body -------------------------------------------------------------------

function normalizeHeading(line: string): string | undefined {
  const trimmed = trimStart(line);
  const indent = line.slice(0, line.length - trimmed.length);
  let hashes = 0;
  while (trimmed[hashes] === "#") hashes += 1;
  if (
    hashes < 1 ||
    hashes > 6 ||
    trimmed.length === hashes ||
    !isAsciiWhitespace(trimmed[hashes])
  ) {
    return undefined;
  }
  let title = trim(trimmed.slice(hashes));
  let end = title.length;
  while (end > 0 && title[end - 1] === "#") end -= 1;
  title = trim(title.slice(0, end));
  return `${indent}${"#".repeat(hashes)} ${title}`;
}

function normalizeListMarker(line: string): string {
  const trimmed = trimStart(line);
  const indent = line.slice(0, line.length - trimmed.length);
  if (
    trimmed.length >= 2 &&
    (trimmed[0] === "*" || trimmed[0] === "+") &&
    isAsciiWhitespace(trimmed[1])
  ) {
    return `${indent}- ${trimStart(trimmed.slice(2))}`;
  }
  return line;
}

function formatWikiLinkInner(inner: string): string {
  const parts = splitWikiLinkParts(inner);
  if (parts.escaped) return trim(inner);
  const target = trim(parts.target);
  const hash = target.indexOf("#");
  const normalized =
    hash < 0 ? target : `${trim(target.slice(0, hash))}#${trim(target.slice(hash + 1))}`;
  const alias = trim(parts.label);
  return parts.hasLabel && alias !== "" ? `${normalized}|${alias}` : normalized;
}

function formatWikiLinks(line: string): string {
  let out = "";
  let last = 0;
  let index = 0;
  while (index + 3 < line.length) {
    if (line[index] === "[" && line[index + 1] === "[") {
      const end = line.indexOf("]]", index + 2);
      if (end >= 0) {
        out += `${line.slice(last, index)}[[${formatWikiLinkInner(line.slice(index + 2, end))}]]`;
        index = end + 2;
        last = index;
        continue;
      }
    }
    index += 1;
  }
  return out + line.slice(last);
}

function formatMarkdownLinks(line: string): string {
  let out = "";
  let last = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] === "!") {
      index += 1;
      continue;
    }
    if (line[index] === "[") {
      const labelEnd = line.indexOf("]", index + 1);
      if (labelEnd >= 0 && line[labelEnd + 1] === "(") {
        const destinationEnd = line.indexOf(")", labelEnd + 2);
        if (destinationEnd >= 0) {
          out += `${line.slice(last, index)}[${trim(line.slice(index + 1, labelEnd))}](${trim(line.slice(labelEnd + 2, destinationEnd))})`;
          index = destinationEnd + 1;
          last = index;
          continue;
        }
      }
    }
    index += 1;
  }
  return out + line.slice(last);
}

function formatBodyLine(line: string): string {
  const formatted = normalizeHeading(line) ?? normalizeListMarker(line);
  return formatted.includes("`") ? formatted : formatWikiLinks(formatMarkdownLinks(formatted));
}

function formatBody(content: string): string {
  const lines: string[] = [];
  const fences = new FenceState();
  let afterHeading = false;
  const push = (line: string) => {
    const heading = normalizeHeading(line) !== undefined;
    const last = lines[lines.length - 1];
    if ((heading || afterHeading) && last !== undefined && last !== "") lines.push("");
    lines.push(line);
    afterHeading = heading;
  };
  for (const scanned of scanLines(content)) {
    const raw = trimLine(scanned.text);
    if (fences.fence(trim(raw))) {
      push(raw);
      continue;
    }
    if (fences.inside) {
      lines.push(raw);
      continue;
    }
    const formatted = formatBodyLine(trimEnd(raw));
    if (trim(formatted) === "") {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
    } else {
      push(formatted);
    }
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function formatMarkdownDocument(content: string): string {
  const lines = scanLines(content);
  const end = frontMatterEnd(lines);
  let out =
    end === undefined
      ? formatBody(content)
      : formatFrontMatter(lines.slice(1, end).map((line) => line.text)) +
        formatBody(content.slice(lines[end]?.end ?? content.length));
  while (out.endsWith("\n")) out = out.slice(0, -1);
  return `${out}\n`;
}

// --- the command ------------------------------------------------------------

/** Pages known to be in format at an identity and token, per filesystem owner. */
const formatted = new WeakMap<object, Map<string, string>>();
const FORMATTED_CAPACITY = 16_384;

function remember(known: Map<string, string>, path: string, identity: string): void {
  if (known.size < FORMATTED_CAPACITY || known.has(path)) known.set(path, identity);
}

export async function formatVault(context: ShellCommandContext, vault: Vault): Promise<string[]> {
  const origin = fileSystemOrigin(context.fileSystem);
  let known = formatted.get(origin);
  if (known === undefined) {
    known = new Map();
    formatted.set(origin, known);
  }
  const changed: string[] = [];
  for (const document of vault.documents) {
    context.budget.checkDeadline();
    const identity = `${document.ino}:${document.token}`;
    if (known.get(document.path) === identity) {
      // Charge the reread a cold run makes, so limits never depend on the cache.
      context.budget.read(document.sizeBytes);
      continue;
    }
    const { stat, content } = await readContent(context, document.path);
    const result = formatMarkdownDocument(content);
    if (result === content) {
      remember(known, document.path, `${stat.ino}:${stat.mutationToken}`);
      continue;
    }
    const written = await context.fileSystem.writeFile(document.path, result, {
      ifMutationToken: stat.mutationToken,
      disposition: "replace",
      mode: stat.mode,
    });
    remember(known, document.path, `${stat.ino}:${written.mutationToken}`);
    changed.push(document.relPath);
  }
  return changed;
}
