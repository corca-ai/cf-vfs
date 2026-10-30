import type { ShellCommandContext } from "../types.js";
import {
  cleanPath,
  cleanRelPath,
  dirSegment,
  documentKey,
  frontMatterEnd,
  joinSlash,
  lastSegment,
  normalizeDocumentName,
  splitKeyValue,
  trimYamlScalar,
} from "./awiki-parse.js";
import { Relinker } from "./awiki-relink.js";
import { debugQuote, scanLines, startsIndented, trim, trimLine } from "./awiki-text.js";
import { AwikiError, osError, readContent, type Vault } from "./awiki-vault.js";

export interface RenameResult {
  readonly oldName: string;
  readonly newName: string;
  readonly filesTouched: number;
  readonly linksUpdated: number;
  readonly titleUpdated: boolean;
}

function validateTarget(value: string): string {
  const name = normalizeDocumentName(value);
  if (name === "") throw new AwikiError("new document name must not be empty");
  if (/[/\\<>:"|?*]/u.test(name)) {
    throw new AwikiError(`new document name ${debugQuote(name)} contains invalid path characters`);
  }
  return name;
}

/** `Path::exists`: whether the path resolves, following links; any failure means no. */
function exists(context: ShellCommandContext, path: string): boolean {
  try {
    context.fileSystem.stat(path);
    return true;
  } catch {
    return false;
  }
}

function replaceLineText(original: string, replacement: string): string {
  if (original.endsWith("\r\n")) return `${replacement}\r\n`;
  if (original.endsWith("\n")) return `${replacement}\n`;
  return replacement;
}

function scalarLike(original: string, replacement: string): string {
  const value = trim(original);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return `"${replacement}"`;
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return `'${replacement}'`;
  return replacement;
}

function updateFrontMatterTitle(
  content: string,
  oldTitle: string,
  newTitle: string,
): [string, boolean] {
  const lines = scanLines(content);
  const end = frontMatterEnd(lines);
  if (end === undefined) return [content, false];
  let out = "";
  let changed = false;
  lines.forEach((line, index) => {
    const text = trimLine(line.text);
    if (index > 0 && index < end && !startsIndented(text)) {
      const pair = splitKeyValue(text);
      if (pair !== undefined && pair[0] === "title" && trimYamlScalar(pair[1]) === oldTitle) {
        out += replaceLineText(line.text, `title: ${scalarLike(pair[1], newTitle)}`);
        changed = true;
        return;
      }
    }
    out += line.text;
  });
  return changed ? [out, true] : [content, false];
}

/** The renamed document's name: a path in a recursive vault, staying in its folder unless given one. */
function renamedName(vault: Vault, relPath: string, newId: string, newBase: string): string {
  if (!vault.recursive) return newBase;
  if (!newId.includes("/")) return cleanRelPath(joinSlash(dirSegment(relPath), newBase));
  let name = cleanRelPath(newId);
  while (name.endsWith(".md")) name = name.slice(0, -3);
  return name;
}

interface Update {
  readonly path: string;
  readonly content: string;
  readonly token: string;
  readonly mode: number;
}

interface Rewrites {
  readonly updates: Update[];
  linksUpdated: number;
  titleUpdated: boolean;
}

/** Rewrites the pages that name the old basename; the rest would be read for nothing. */
async function rewritePages(
  context: ShellCommandContext,
  vault: Vault,
  index: number,
  newBase: string,
  newRel: string,
): Promise<Rewrites> {
  const renamed = vault.doc(index);
  const oldBase = lastSegment(renamed.relPath);
  const relinker = new Relinker(vault, {
    doc: index,
    oldKey: documentKey(oldBase),
    newBase,
    newRel,
  });
  const result: Rewrites = { updates: [], linksUpdated: 0, titleUpdated: false };
  for (const [position, candidate] of vault.documents.entries()) {
    const self = position === index;
    if (!self && !candidate.page.rewriteKeys.has(documentKey(oldBase))) continue;
    context.budget.checkDeadline();
    const { stat, content } = await readContent(context, candidate.path);
    const [linked, count] = relinker.rewrite(content, position);
    const [rewritten, changedTitle] = self
      ? updateFrontMatterTitle(linked, oldBase, newBase)
      : [linked, false];
    if (count === 0 && !changedTitle) continue;
    result.linksUpdated += count;
    result.titleUpdated ||= changedTitle;
    result.updates.push({
      path: candidate.path,
      content: rewritten,
      token: stat.mutationToken,
      mode: stat.mode,
    });
  }
  return result;
}

async function applyRename(
  context: ShellCommandContext,
  updates: readonly Update[],
  from: string,
  to: string,
): Promise<void> {
  try {
    for (const update of updates) {
      await context.fileSystem.writeFile(update.path, update.content, {
        ifMutationToken: update.token,
        disposition: "replace",
        mode: update.mode,
      });
    }
    if (to === from) return;
    const parent = to.slice(0, to.lastIndexOf("/"));
    if (parent !== "") context.fileSystem.mkdir(parent, true);
    await context.fileSystem.move(from, to);
  } catch (error) {
    throw osError(error);
  }
}

export async function renameDocument(
  context: ShellCommandContext,
  vault: Vault,
  oldId: string,
  newId: string,
): Promise<RenameResult> {
  const index = vault.resolveDocument(oldId);
  const document = vault.doc(index);
  const newBase = validateTarget(newId);
  const newName = renamedName(vault, document.relPath, newId, newBase);
  const newPath = `/${cleanPath(`${vault.root}/${vault.recursive ? newName : newBase}.md`)}`;
  if (newPath !== document.path && exists(context, newPath)) {
    throw new AwikiError(`document ${debugQuote(newName)} already exists`);
  }
  const rewrites = await rewritePages(context, vault, index, newBase, newName);
  await applyRename(context, rewrites.updates, document.path, newPath);
  return {
    oldName: vault.recursive ? document.relPath : document.name,
    newName,
    filesTouched: Math.max(new Set(rewrites.updates.map((update) => update.path)).size, 1),
    linksUpdated: rewrites.linksUpdated,
    titleUpdated: rewrites.titleUpdated,
  };
}
