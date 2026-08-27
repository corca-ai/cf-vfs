import { describe, expect, it } from "vitest";
import {
  parseRemoteExecuteToOptions,
  parseRemoteTextOptions,
} from "../src/shell/rpc-validation.js";
import {
  rpcFindOptions,
  rpcIdentity,
  rpcOptionalNonnegativeInteger,
  rpcOptionalPositiveInteger,
  rpcPosixCredentials,
  rpcWriteFilesEntries,
  rpcWriteOptions,
} from "../src/vfs/rpc-validation.js";

describe("shell RPC option parsing", () => {
  it("normalizes every supported text-execution field", () => {
    const stdin = Uint8Array.of(1, 2, 3);
    expect(
      parseRemoteTextOptions({
        script: "printf input",
        cwd: "/work",
        env: { HOME: "/work", EMPTY: "" },
        args: ["first", "second"],
        credentials: { uid: 1000, gid: 100, supplementaryGids: [200] },
        umask: 0o027,
        stdin,
      }),
    ).toEqual({
      script: "printf input",
      cwd: "/work",
      env: { HOME: "/work", EMPTY: "" },
      args: ["first", "second"],
      credentials: { uid: 1000, gid: 100, supplementaryGids: [200] },
      umask: 0o027,
      stdin,
    });
  });

  it.each([
    ["script", { script: 1 }, "options.script must be a string"],
    ["working directory", { script: "true", cwd: 1 }, "options.cwd must be a string"],
    [
      "environment",
      { script: "true", env: { VALID: "yes", INVALID: 1 } },
      "options.env values must be strings",
    ],
    [
      "arguments",
      { script: "true", args: ["valid", 1] },
      "options.args must be an array of strings",
    ],
    [
      "standard input",
      { script: "true", stdin: { not: "bytes" } },
      "options.stdin must be bytes, text, or a byte stream",
    ],
    [
      "credentials",
      { script: "true", credentials: { uid: 1000 } },
      "options.credentials requires uid and gid",
    ],
    ["umask", { script: "true", umask: -1 }, "options.umask must be a safe integer >= 0"],
    ["unknown field", { script: "true", timeout: 10 }, "options.timeout is not supported"],
  ])("rejects an invalid %s with a field-specific diagnostic", (_field, value, message) => {
    expect(() => parseRemoteTextOptions(value)).toThrowError(
      expect.objectContaining({ code: "EINVAL", message }),
    );
  });

  it("requires real byte streams and sinks for streaming execution", () => {
    const stdin = new ReadableStream<Uint8Array>();
    const stdout = new WritableStream<Uint8Array>();
    const stderr = new WritableStream<Uint8Array>();
    expect(parseRemoteExecuteToOptions({ script: "cat", stdin, stdout, stderr })).toEqual({
      script: "cat",
      stdin,
      stdout,
      stderr,
    });

    expect(() =>
      parseRemoteExecuteToOptions({ script: "cat", stdin: "text", stdout, stderr }),
    ).toThrowError(
      expect.objectContaining({ code: "EINVAL", message: "options.stdin must be a byte stream" }),
    );
    expect(() =>
      parseRemoteExecuteToOptions({ script: "cat", stdin, stdout: {}, stderr }),
    ).toThrowError(
      expect.objectContaining({
        code: "EINVAL",
        message: "options.stdout and options.stderr must be byte sinks",
      }),
    );
  });
});

describe("VFS RPC option parsing", () => {
  it("accepts the documented integer boundaries and refuses values outside them", () => {
    expect(rpcIdentity(1)).toBe(1);
    expect(rpcOptionalPositiveInteger(Number.MAX_SAFE_INTEGER, "limit")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(rpcOptionalNonnegativeInteger(0, "offset")).toBe(0);
    expect(
      rpcPosixCredentials(
        { uid: 0, gid: 0xffff_ffff, supplementaryGids: [0, 0xffff_ffff] },
        "credentials",
      ),
    ).toEqual({ uid: 0, gid: 0xffff_ffff, supplementaryGids: [0, 0xffff_ffff] });

    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => rpcIdentity(invalid), String(invalid)).toThrowError(
        expect.objectContaining({ code: "EINVAL" }),
      );
    }
    expect(() => rpcPosixCredentials({ uid: 0x1_0000_0000, gid: 0 }, "credentials")).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("preserves supported find and write modes while rejecting unknown literals", () => {
    expect(
      rpcFindOptions({
        path: "/src",
        includeRoot: true,
        maxDepth: 2,
        name: "*.ts",
        pathGlob: "/src/**",
        type: "file",
        cursor: "next",
        limit: 10,
      }),
    ).toEqual({
      path: "/src",
      includeRoot: true,
      maxDepth: 2,
      name: "*.ts",
      pathGlob: "/src/**",
      type: "file",
      cursor: "next",
      limit: 10,
    });
    expect(rpcWriteOptions({ disposition: "replace", createParents: true })).toEqual({
      disposition: "replace",
      createParents: true,
    });

    expect(() => rpcFindOptions({ path: "/", type: "device" })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => rpcWriteOptions({ disposition: "merge" })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it("identifies the malformed entry in a batch", () => {
    expect(() =>
      rpcWriteFilesEntries([
        { path: "/valid", body: "body" },
        { path: "/invalid", body: { not: "bytes" } },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "EINVAL",
        message: "entries[1].body must be bytes, text, or a byte stream",
      }),
    );
    expect(() =>
      rpcWriteFilesEntries([
        { path: "/valid", body: "body" },
        { path: "/invalid", body: "body", unexpected: true },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: "EINVAL",
        message: "entries[1].unexpected is not supported",
      }),
    );
  });
});
