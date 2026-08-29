import { codePointLength } from "../core/unicode.js";
import type { LiteralWordPart, WordPart } from "./parser.js";
import type { ShellBudget, ShellSession } from "./types.js";

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;

function tildeHome(session: ShellSession): string | undefined {
  const home = session.env.get("HOME");
  return home === undefined || home === "" ? undefined : home;
}

function tildeSuffix(segment: string): string | undefined {
  if (!segment.startsWith("~")) return undefined;
  const rest = segment.slice(1);
  return rest === "" || rest.startsWith("/") ? rest : undefined;
}

function tildeParts(template: LiteralWordPart, home: string, suffix: string): WordPart[] {
  const parts: WordPart[] = [{ ...template, value: home, quoted: true }];
  if (suffix !== "") parts.push({ ...template, value: suffix, quoted: false });
  return parts;
}

function chargeTilde(home: string, budget: ShellBudget): void {
  budget.expansionWork(home.length);
  budget.checkExpansionOutput(codePointLength(home));
}

function leadingTildePrefix(
  parts: readonly WordPart[],
  first: LiteralWordPart,
  home: string,
  budget: ShellBudget,
): readonly WordPart[] {
  const suffix = tildeSuffix(first.value);
  if (suffix === undefined || (suffix === "" && parts.length > 1)) return parts;
  chargeTilde(home, budget);
  return [...tildeParts(first, home, suffix), ...parts.slice(1)];
}

interface AssignmentTildeState {
  readonly output: WordPart[];
  atBoundary: boolean;
  seenName: boolean;
  expanded: boolean;
}

function appendAssignmentTildeSegment(
  state: AssignmentTildeState,
  part: LiteralWordPart,
  segment: string,
  continues: boolean,
  home: string,
  budget: ShellBudget,
): void {
  const suffix = state.atBoundary ? tildeSuffix(segment) : undefined;
  if (suffix === undefined || (suffix === "" && continues)) {
    if (segment !== "") state.output.push({ ...part, value: segment });
  } else {
    chargeTilde(home, budget);
    state.output.push(...tildeParts(part, home, suffix));
    state.expanded = true;
  }
  state.atBoundary = false;
}

function appendAssignmentTildePart(
  state: AssignmentTildeState,
  part: WordPart,
  index: number,
  partCount: number,
  home: string,
  budget: ShellBudget,
): void {
  if (part.kind !== "literal" || part.quoted) {
    state.output.push(part);
    state.atBoundary = false;
    return;
  }
  let value = part.value;
  if (!state.seenName) {
    const separator = value.indexOf("=");
    state.output.push({ ...part, value: value.slice(0, separator + 1) });
    value = value.slice(separator + 1);
    state.seenName = true;
    state.atBoundary = true;
  }
  const segments = value.split(":");
  for (const [segmentIndex, segment] of segments.entries()) {
    if (segmentIndex > 0) {
      state.output.push({ ...part, value: ":" });
      state.atBoundary = true;
    }
    const continues = segmentIndex === segments.length - 1 && index < partCount - 1;
    appendAssignmentTildeSegment(state, part, segment, continues, home, budget);
  }
}

function assignmentTildePrefix(
  parts: readonly WordPart[],
  home: string,
  budget: ShellBudget,
): readonly WordPart[] {
  const state: AssignmentTildeState = {
    output: [],
    atBoundary: false,
    seenName: false,
    expanded: false,
  };
  for (const [index, part] of parts.entries()) {
    appendAssignmentTildePart(state, part, index, parts.length, home, budget);
  }
  return state.expanded ? state.output : parts;
}

export function withTildePrefix(
  parts: readonly WordPart[],
  session: ShellSession,
  budget: ShellBudget,
): readonly WordPart[] {
  const first = parts[0];
  if (first?.kind !== "literal" || first.quoted) return parts;
  const home = tildeHome(session);
  if (home === undefined) return parts;
  return ASSIGNMENT_WORD.test(first.value)
    ? assignmentTildePrefix(parts, home, budget)
    : leadingTildePrefix(parts, first, home, budget);
}
