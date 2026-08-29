import { VfsError } from "../core/errors.js";
import { codePointLength } from "../core/unicode.js";
import { ShellNounsetError } from "./errors.js";
import type { ShellBudget, ShellSession } from "./types.js";

function shellOptionFlags(session: ShellSession): string {
  return `${session.errexit === true ? "e" : ""}${session.nounset === true ? "u" : ""}`;
}

export function variableState(
  name: string,
  session: ShellSession,
): { set: boolean; value: string } {
  if (name === "?") return { set: true, value: String(session.lastExitCode) };
  if (name === "-") return { set: true, value: shellOptionFlags(session) };
  if (name === "#") return { set: true, value: String(session.args.length) };
  if (name === "@") return { set: session.args.length > 0, value: session.args.join(" ") };
  if (name === "*") return { set: session.args.length > 0, value: session.args.join(" ") };
  if (name === "0") return { set: true, value: session.env.get("0") ?? "cf-vfs" };
  if (/^[1-9][0-9]*$/u.test(name)) {
    const value = session.args[Number(name) - 1];
    return value === undefined ? { set: false, value: "" } : { set: true, value };
  }
  const value = session.env.get(name);
  return value === undefined ? { set: false, value: "" } : { set: true, value };
}

export function isShellParameterSet(name: string, session: ShellSession): boolean {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#@*-])$/u.test(name)) {
    throw new VfsError("EINVAL", `${name}: invalid variable name`);
  }
  return variableState(name, session).set;
}

export function assignParameter(name: string, value: string, session: ShellSession): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new VfsError("EINVAL", `cannot assign to special parameter ${name}`);
  }
  session.env.set(name, value);
}

export function substringByCodePoint(
  value: string,
  offset: number,
  length: number | undefined,
  budget: ShellBudget,
): string {
  let start = offset;
  if (start < 0) {
    budget.expansionWork(value.length);
    start = Math.max(codePointLength(value) + start, 0);
  }
  budget.expansionWork(value.length);
  const end = length === undefined ? Number.POSITIVE_INFINITY : start + length;
  let codePoints = 0;
  let codeUnits = 0;
  let startCodeUnit = value.length;
  let endCodeUnit = value.length;
  for (const character of value) {
    if (codePoints === start) startCodeUnit = codeUnits;
    if (codePoints === end) {
      endCodeUnit = codeUnits;
      break;
    }
    codePoints += 1;
    codeUnits += character.length;
  }
  if (codePoints === start) startCodeUnit = codeUnits;
  if (codePoints === end) endCodeUnit = codeUnits;
  return value.slice(startCodeUnit, endCodeUnit);
}

export function expansionInteger(value: string, label: string): number {
  const normalized = value.trim();
  if (!/^-?[0-9]+$/u.test(normalized)) {
    throw new VfsError("EINVAL", `${label} must expand to an integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new VfsError("EINVAL", `${label} must expand to a safe integer`);
  }
  return parsed;
}

export function missingParameter(name: string, session: ShellSession, message: string): never {
  const rendered = message || `${name}: parameter is unset or empty`;
  if (session.nounset) throw new ShellNounsetError(name, rendered);
  throw new VfsError("EINVAL", rendered);
}

export function indirectParameterValue(session: ShellSession, value: string): string {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#-])$/u.test(value)) {
    throw new VfsError("EINVAL", `${value}: invalid variable name for indirect expansion`);
  }
  const referenced = variableState(value, session);
  if (!referenced.set && session.nounset) throw new ShellNounsetError(value);
  return referenced.value;
}
