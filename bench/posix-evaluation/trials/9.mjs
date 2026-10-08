/** Rejected experiment: per-handle copies preserve unlink reads but split identity. */
export async function experimentalOpen(vfs, fs, path, flags) {
  const initial = vfs.stat(path);
  let bytes = await fs.readFile(path);
  let closed = false;
  let offset = 0;
  const check = () => {
    if (closed) throw Object.assign(new Error("closed"), { code: "EBADF" });
  };
  return {
    async readFile(encoding) {
      check();
      const remaining = bytes.subarray(offset);
      offset = bytes.byteLength;
      return encoding === "utf8" ? new TextDecoder().decode(remaining) : remaining.slice();
    },
    async write(text, position = null) {
      check();
      if (flags === "r") throw Object.assign(new Error("not writable"), { code: "EBADF" });
      const incoming = new TextEncoder().encode(text);
      const at = position ?? offset;
      const next = new Uint8Array(Math.max(bytes.byteLength, at + incoming.byteLength));
      next.set(bytes);
      next.set(incoming, at);
      bytes = next;
      if (position === null) offset = at + incoming.byteLength;
      try {
        await fs.writeFile(vfs.statById(initial.ino).path, bytes);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return { bytesWritten: incoming.byteLength };
    },
    async close() {
      closed = true;
      bytes = new Uint8Array(0);
    },
  };
}
