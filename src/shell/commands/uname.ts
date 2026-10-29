import { isVfsError } from "../../core/errors.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { readFileText, writeText } from "./helpers.js";

type Field =
  | "kernel-name"
  | "nodename"
  | "kernel-release"
  | "kernel-version"
  | "machine"
  | "processor"
  | "hardware-platform"
  | "operating-system";

const UNAME = {
  name: "uname",
  usage: "[-asnrvmpio]",
  summary: "prints what this shell profile reports about the system",
  options: {
    short: {
      a: { name: "all" },
      s: { name: "kernel-name" },
      n: { name: "nodename" },
      r: { name: "kernel-release" },
      v: { name: "kernel-version" },
      m: { name: "machine" },
      p: { name: "processor" },
      i: { name: "hardware-platform" },
      o: { name: "operating-system" },
    },
    long: {
      all: { name: "all" },
      "kernel-name": { name: "kernel-name" },
      nodename: { name: "nodename" },
      "kernel-release": { name: "kernel-release" },
      "kernel-version": { name: "kernel-version" },
      machine: { name: "machine" },
      processor: { name: "processor" },
      "hardware-platform": { name: "hardware-platform" },
      "operating-system": { name: "operating-system" },
    },
  },
} as const satisfies AppletSpecWithOptions<Field | "all">;

/** GNU's order, which `-a` follows, leaving out the fields it cannot know. */
const ORDER: readonly Field[] = [
  "kernel-name",
  "nodename",
  "kernel-release",
  "kernel-version",
  "machine",
  "processor",
  "hardware-platform",
  "operating-system",
];

/** The node name is the first line of `/etc/hostname`, as on Linux, or `localhost`. */
async function nodename(context: ShellCommandContext): Promise<string> {
  try {
    const read = await readFileText(context, "/etc/hostname", 256);
    try {
      return read.value.split("\n")[0]?.trim() || "localhost";
    } finally {
      read.release();
    }
  } catch (error) {
    if (isVfsError(error)) return "localhost";
    throw error;
  }
}

/**
 * The system as this profile presents it. There is no kernel, so only the
 * kernel name answers `Linux`: scripts test it to choose GNU options, and the
 * utilities follow GNU. The release and operating system name this shell
 * rather than imitate a distribution, and the machine is unknown.
 */
export const unameCommand = /* @__PURE__ */ defineApplet(UNAME, async (context, argv, fds) => {
  const parsed = parseAppletOptions(UNAME, argv);
  if (parsed.operands.length > 0) {
    throw appletUsageError(UNAME, `extra operand ${parsed.operands[0] ?? ""}`);
  }
  const all = parsed.options.some((option) => option.name === "all");
  const requested = new Set(parsed.options.map((option) => option.name));
  const values: Record<Field, string> = {
    "kernel-name": "Linux",
    nodename: "",
    "kernel-release": "cf-vfs",
    "kernel-version": "#1",
    machine: "unknown",
    processor: "unknown",
    "hardware-platform": "unknown",
    "operating-system": "cf-vfs",
  };
  const fields = ORDER.filter((field) =>
    all
      ? field !== "processor" && field !== "hardware-platform"
      : requested.has(field) || (requested.size === 0 && field === "kernel-name"),
  );
  if (fields.includes("nodename")) values.nodename = await nodename(context);
  await writeText(fds[1], `${fields.map((field) => values[field]).join(" ")}\n`);
  return 0;
});
