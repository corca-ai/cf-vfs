import {
  compareDecimalIntegers,
  type NormalizedDecimalInteger,
  normalizeDecimalInteger,
} from "../../core/decimal-integer.js";
import { VfsError } from "../../core/errors.js";
import { isOneOf } from "../../core/literals.js";
import { normalizePathPreservingTrailingSlash } from "../../core/path.js";
import { type PosixPermission, shellModeAllows } from "../access.js";
import { identityLabel, resolveIdentityNames } from "../identity.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { isCharacterDevice, isRegularFile } from "./format.js";
import { writeText } from "./helpers.js";

const TEST = {
  name: "test",
  usage: "EXPRESSION",
  summary: "evaluates a bounded conditional expression",
  kind: "builtin",
} as const satisfies AppletSpec;

const BRACKET = {
  name: "[",
  usage: "EXPRESSION ]",
  summary: "evaluates a bounded conditional expression, requiring a closing ]",
  kind: "builtin",
} as const satisfies AppletSpec;

const ID = {
  name: "id",
  usage: "[-u|-g|-G] [-n]",
  summary: "prints the execution identity",
  options: {
    short: {
      u: { name: "user" },
      g: { name: "group" },
      G: { name: "groups" },
      n: { name: "name" },
    },
  },
} as const satisfies AppletSpecWithOptions<"user" | "group" | "groups" | "name">;

const GROUPS = {
  name: "groups",
  usage: "",
  summary: "prints the execution groups",
} as const satisfies AppletSpec;

const FILE_PREDICATES = ["-e", "-f", "-d", "-s", "-r", "-w", "-x", "-L", "-h", "-c"] as const;
type FilePredicate = (typeof FILE_PREDICATES)[number];
type PermissionPredicate = "-r" | "-w" | "-x";

const PERMISSION_BITS: Readonly<Record<PermissionPredicate, PosixPermission>> = {
  "-r": 4,
  "-w": 2,
  "-x": 1,
};

function normalizeTestInteger(value: string): NormalizedDecimalInteger {
  const normalized = normalizeDecimalInteger(value);
  if (normalized === undefined) throw appletUsageError(TEST, "integer expression expected");
  return normalized;
}

function compareTestIntegers(left: string, right: string): number {
  return compareDecimalIntegers(normalizeTestInteger(left), normalizeTestInteger(right));
}

function statPredicate(
  context: ShellCommandContext,
  predicate: FilePredicate,
  operand: string,
): boolean {
  const path = normalizePathPreservingTrailingSlash(operand, context.session.cwd);
  const link = predicate === "-L" || predicate === "-h";
  const stat = link ? context.fileSystem.lstat(path) : context.fileSystem.stat(path);
  if (link) return stat.kind === "symlink";
  if (predicate === "-c") return isCharacterDevice(stat);
  if (predicate === "-e") return true;
  if (predicate === "-f") return stat.kind === "file" && isRegularFile(stat);
  if (predicate === "-d") return stat.kind === "directory";
  if (predicate === "-s") return stat.sizeBytes > 0;
  return shellModeAllows(stat, context.session.credentials, PERMISSION_BITS[predicate]);
}

function evaluateFilePredicate(
  context: ShellCommandContext,
  predicate: FilePredicate,
  operand: string,
): boolean {
  if (operand.length === 0) return false;
  try {
    return statPredicate(context, predicate, operand);
  } catch (error) {
    if (error instanceof VfsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}

function evaluateUnary(
  context: ShellCommandContext,
  operator: string,
  operand: string,
): boolean | undefined {
  if (operator === "-n") return operand.length > 0;
  if (operator === "-z") return operand.length === 0;
  return isOneOf(operator, FILE_PREDICATES)
    ? evaluateFilePredicate(context, operator, operand)
    : undefined;
}

function evaluateIntegerComparison(operator: string, order: number): boolean | undefined {
  if (operator === "-eq") return order === 0;
  if (operator === "-ne") return order !== 0;
  if (operator === "-lt") return order < 0;
  if (operator === "-le") return order <= 0;
  if (operator === "-gt") return order > 0;
  if (operator === "-ge") return order >= 0;
  return undefined;
}

function evaluateBinary(left: string, operator: string, right: string): boolean | undefined {
  if (operator === "=" || operator === "==") return left === right;
  if (operator === "!=") return left !== right;
  if (!["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(operator)) return undefined;
  return evaluateIntegerComparison(operator, compareTestIntegers(left, right));
}

async function evaluateTest(
  context: ShellCommandContext,
  values: readonly string[],
): Promise<boolean> {
  if (values.length === 0) return false;
  if (values[0] === "!") return !(await evaluateTest(context, values.slice(1)));
  if (values.length === 1) return values[0] !== "";
  if (values.length === 2) {
    const result = evaluateUnary(context, values[0] ?? "", values[1] ?? "");
    if (result !== undefined) return result;
  }
  if (values.length === 3) {
    const result = evaluateBinary(values[0] ?? "", values[1] ?? "", values[2] ?? "");
    if (result !== undefined) return result;
  }
  throw appletUsageError(TEST, "unsupported expression");
}

export const testCommand = /* @__PURE__ */ defineApplet(TEST, async (context, argv) =>
  (await evaluateTest(context, argv)) ? 0 : 1,
);

export const bracketCommand = /* @__PURE__ */ defineApplet(BRACKET, async (context, argv) => {
  if (argv.at(-1) !== "]") throw appletUsageError(BRACKET, "missing ]");
  return (await evaluateTest(context, argv.slice(0, -1))) ? 0 : 1;
});

function executionIdentity(context: ShellCommandContext, spec: AppletSpec) {
  const credentials = context.session.credentials;
  if (credentials === undefined) {
    throw new VfsError("ENOTSUP", `${spec.name} requires execution credentials`);
  }
  const groups = [...new Set([credentials.gid, ...credentials.supplementaryGids])];
  return { credentials, groups };
}

function annotatedIdentity(id: number, names: ReadonlyMap<number, string> | undefined): string {
  const name = names?.get(id);
  return name === undefined ? String(id) : `${id}(${name})`;
}

type IdentitySelection = "user" | "group" | "groups" | undefined;

function isIdentitySelection(value: string): value is Exclude<IdentitySelection, undefined> {
  return value === "user" || value === "group" || value === "groups";
}

function selectedIds(
  selection: IdentitySelection,
  names: boolean,
  uid: number,
  gid: number,
  groups: readonly number[],
): { uids: number[]; gids: number[] } {
  const uids = selection === undefined || (selection === "user" && names) ? [uid] : [];
  if (selection === undefined) return { uids, gids: [...groups] };
  if (!names) return { uids, gids: [] };
  if (selection === "group") return { uids, gids: [gid] };
  return { uids, gids: selection === "groups" ? [...groups] : [] };
}

function selectedIdentityOutput(
  selection: Exclude<IdentitySelection, undefined>,
  names: boolean,
  credentials: { uid: number; gid: number },
  groups: readonly number[],
  labels: { user: string; group: string; groups: readonly string[] },
): string {
  if (selection === "user") return names ? labels.user : String(credentials.uid);
  if (selection === "group") return names ? labels.group : String(credentials.gid);
  return names ? labels.groups.join(" ") : groups.join(" ");
}

export const idCommand = /* @__PURE__ */ defineApplet(ID, async (context, argv, fds) => {
  const parsed = parseAppletOptions(ID, argv);
  if (parsed.operands.length > 0) throw appletUsageError(ID, "user lookup is not supported");
  const selections = parsed.options.map((option) => option.name).filter(isIdentitySelection);
  if (selections.length > 1) throw appletUsageError(ID, "supports only one of -u, -g, or -G");
  const names = parsed.options.some((option) => option.name === "name");
  if (names && selections.length === 0) throw appletUsageError(ID, "-n requires -u, -g, or -G");
  const { credentials, groups } = executionIdentity(context, ID);
  const selection = selections[0];
  const ids = selectedIds(selection, names, credentials.uid, credentials.gid, groups);
  const identities =
    context.identities === undefined || (ids.uids.length === 0 && ids.gids.length === 0)
      ? undefined
      : await resolveIdentityNames(context.identities, ids.uids, ids.gids);
  const labels = {
    user: identityLabel(identities?.users, credentials.uid),
    group: identityLabel(identities?.groups, credentials.gid),
    groups: groups.map((id) => identityLabel(identities?.groups, id)),
  };
  const output =
    selection === undefined
      ? `uid=${annotatedIdentity(credentials.uid, identities?.users)} gid=${annotatedIdentity(credentials.gid, identities?.groups)} groups=${groups.map((id) => annotatedIdentity(id, identities?.groups)).join(",")}`
      : selectedIdentityOutput(selection, names, credentials, groups, labels);
  await writeText(fds[1], `${output}\n`);
  return 0;
});

export const groupsCommand = /* @__PURE__ */ defineApplet(GROUPS, async (context, argv, fds) => {
  if (argv.length !== 0) throw appletUsageError(GROUPS, "user-name lookup is not supported");
  const { groups } = executionIdentity(context, GROUPS);
  const identities =
    context.identities === undefined
      ? undefined
      : await resolveIdentityNames(context.identities, [], groups);
  await writeText(
    fds[1],
    `${groups.map((id) => identityLabel(identities?.groups, id)).join(" ")}\n`,
  );
  return 0;
});
