import { VfsError } from "../core/errors.js";
import type { VfsStat } from "../vfs/types.js";
import type { ShellBudget, ShellFileDescriptors, ShellSink } from "./types.js";

/**
 * The device paths this shell answers, and nothing else.
 *
 * A table rather than a device framework: these are the four names ordinary
 * scripts actually reach for, and each one is a capability the descriptor
 * layer already has. `/dev/zero`, terminals, and the rest would each need a
 * model — an endless stream, a width, a mode — that this runtime has no way to
 * make true, so they stay absent and report `ENOENT` like any other path.
 */
const DEVICES = {
  "/dev/null": "null",
  "/dev/stdin": "stdin",
  "/dev/stdout": "stdout",
  "/dev/stderr": "stderr",
  "/dev/fd/0": "stdin",
  "/dev/fd/1": "stdout",
  "/dev/fd/2": "stderr",
} as const satisfies Readonly<Record<string, string>>;

export type ShellDevice = (typeof DEVICES)[keyof typeof DEVICES];

/** The character-device mode Linux gives `/dev/null`: `S_IFCHR` with `666`. */
const DEVICE_MODE = 0o020666;

/**
 * Names the device at a path, if the path is one.
 *
 * The paths are matched exactly, after normalization. There is no `/dev`
 * directory behind them and no lookup: a device is a name the shell knows, not
 * an entry anything could have created.
 */
export function shellDevice(path: string): ShellDevice | undefined {
  return Object.hasOwn(DEVICES, path) ? DEVICES[path as keyof typeof DEVICES] : undefined;
}

/**
 * What `stat`, `test`, `file`, and `ls -d` see at a device path.
 *
 * Reported as a character device with no content, which is what it is. The
 * timestamps are zero rather than the current time because a device has no
 * history — a value that changed on every call would make `stat` output
 * nondeterministic for no gain.
 */
export function deviceStat(path: string, device: ShellDevice): VfsStat {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
    name,
    kind: "file",
    contentClass: "inline",
    sizeBytes: 0,
    mode: DEVICE_MODE,
    createdAtMs: 0,
    modifiedAtMs: 0,
    revision: 1,
    // Never a valid guard: a device has no state to reserve, and returning a
    // token that looked usable would invite a caller to guard on nothing.
    mutationToken: `vfs:device:${device}`,
  };
}

/** An empty stream, which is what reading `/dev/null` gives. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * The stream a device is read from.
 *
 * `/dev/stdin` is this execution's input, so `cat /dev/stdin` and `cat` are the
 * same thing. Reading `/dev/stdout` is refused rather than approximated: there
 * is no file behind the descriptor to read back, and returning nothing would
 * silently look like an empty file.
 */
export function deviceInput(
  device: ShellDevice,
  fds: ShellFileDescriptors,
  path: string,
): ReadableStream<Uint8Array> {
  if (device === "null") return emptyStream();
  if (device === "stdin") return fds[0];
  throw new VfsError("EINVAL", "device is not readable", path);
}

/**
 * A sink that discards everything written to it.
 *
 * Nothing is buffered and no chunk is retained — the byte count is charged to
 * the I/O budget so a script cannot use `/dev/null` to do unmetered work, and
 * the chunk is dropped on the spot. `close` and `abort` do nothing because
 * there is nothing to publish or undo, which is also what makes it safe to
 * hand the same sink to two descriptors.
 */
function nullSink(budget: ShellBudget): ShellSink {
  const sink: ShellSink = {
    async write(chunk: Uint8Array): Promise<void> {
      budget.io(chunk.byteLength);
    },
    async close(): Promise<void> {},
    async abort(): Promise<void> {},
    clone: () => sink,
  };
  return sink;
}

/**
 * The sink a device is written to.
 *
 * A descriptor alias is a duplicate of the descriptor it names, taken through
 * the same reference counting `2>&1` uses: `> /dev/stderr` writes where
 * standard error currently goes, and closing the duplicate does not close what
 * it was duplicated from. Writing to `/dev/stdin` is refused for the same
 * reason reading `/dev/stdout` is.
 */
export function deviceSink(
  device: ShellDevice,
  fds: ShellFileDescriptors,
  budget: ShellBudget,
  path: string,
): ShellSink {
  if (device === "null") return nullSink(budget);
  if (device === "stdout") return fds[1].clone();
  if (device === "stderr") return fds[2].clone();
  throw new VfsError("EINVAL", "device is not writable", path);
}
