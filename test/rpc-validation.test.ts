import { describe, expect, it } from "vitest";
import {
  parseRemoteExecuteToOptions,
  parseRemoteTextOptions,
} from "../src/shell/rpc-validation.js";
import {
  rpcAppendOptions,
  rpcBeginUploadOptions,
  rpcChangesSinceOptions,
  rpcCommitUploadOptions,
  rpcCopyOptions,
  rpcFindOptions,
  rpcFollowOptions,
  rpcIdentity,
  rpcMetadataOptions,
  rpcMoveOptions,
  rpcOptionalNonnegativeInteger,
  rpcOptionalPositiveInteger,
  rpcOwnershipOptions,
  rpcPageOptions,
  rpcPosixCredentials,
  rpcReadFileOptions,
  rpcRemoveOptions,
  rpcSymlinkOptions,
  rpcTouchOptions,
  rpcWriteFilesEntries,
  rpcWriteFilesOptions,
  rpcWriteOptions,
} from "../src/vfs/rpc-validation.js";

const VFS_OPTION_BOUNDARIES: readonly {
  readonly name: string;
  readonly parse: (value: unknown) => unknown;
  readonly input: Readonly<Record<string, unknown>>;
  readonly expected: unknown;
}[] = [
  {
    name: "page",
    parse: rpcPageOptions,
    input: { cursor: "next", limit: 25 },
    expected: { cursor: "next", limit: 25 },
  },
  {
    name: "change feed",
    parse: rpcChangesSinceOptions,
    input: { limit: 50 },
    expected: { limit: 50 },
  },
  {
    name: "read",
    parse: rpcReadFileOptions,
    input: { range: { offset: 10, length: 20 } },
    expected: { range: { offset: 10, length: 20 } },
  },
  {
    name: "find",
    parse: rpcFindOptions,
    input: {
      path: "/src",
      includeRoot: true,
      maxDepth: 2,
      name: "*.ts",
      pathGlob: "/src/**",
      type: "file",
      cursor: "next",
      limit: 10,
    },
    expected: {
      path: "/src",
      includeRoot: true,
      maxDepth: 2,
      name: "*.ts",
      pathGlob: "/src/**",
      type: "file",
      cursor: "next",
      limit: 10,
    },
  },
  {
    name: "write",
    parse: rpcWriteOptions,
    input: {
      createParents: true,
      disposition: "replace",
      ifMutationToken: "epoch:1",
      mode: 0o640,
      skipIfUnchanged: true,
    },
    expected: {
      createParents: true,
      disposition: "replace",
      ifMutationToken: "epoch:1",
      mode: 0o640,
      skipIfUnchanged: true,
    },
  },
  {
    name: "batch write",
    parse: rpcWriteFilesOptions,
    input: { createParents: true, disposition: "create", skipIfUnchanged: true },
    expected: { createParents: true, disposition: "create", skipIfUnchanged: true },
  },
  {
    name: "append",
    parse: rpcAppendOptions,
    input: { ifMutationToken: "epoch:2" },
    expected: { ifMutationToken: "epoch:2" },
  },
  {
    name: "metadata",
    parse: rpcMetadataOptions,
    input: { ifMutationToken: "epoch:3", mode: 0o600, modifiedAtMs: 1234 },
    expected: { ifMutationToken: "epoch:3", mode: 0o600, modifiedAtMs: 1234 },
  },
  {
    name: "ownership",
    parse: rpcOwnershipOptions,
    input: { ifMutationToken: "epoch:4", uid: 1000, gid: 100 },
    expected: { ifMutationToken: "epoch:4", uid: 1000, gid: 100 },
  },
  {
    name: "symlink",
    parse: rpcSymlinkOptions,
    input: { createParents: true, ifMutationToken: "epoch:5", replace: true },
    expected: { createParents: true, ifMutationToken: "epoch:5", replace: true },
  },
  {
    name: "link following",
    parse: rpcFollowOptions,
    input: { follow: false },
    expected: { follow: false },
  },
  {
    name: "touch",
    parse: rpcTouchOptions,
    input: {
      create: false,
      createParents: true,
      ifMutationToken: "epoch:6",
      mode: 0o644,
      modifiedAtMs: 5678,
    },
    expected: {
      create: false,
      createParents: true,
      ifMutationToken: "epoch:6",
      mode: 0o644,
      modifiedAtMs: 5678,
    },
  },
  {
    name: "remove",
    parse: rpcRemoveOptions,
    input: { recursive: true },
    expected: { recursive: true },
  },
  {
    name: "move",
    parse: rpcMoveOptions,
    input: { replace: true },
    expected: { replace: true },
  },
  {
    name: "copy",
    parse: rpcCopyOptions,
    input: { replace: true, recursive: true, createParents: true, dereference: true },
    expected: { replace: true, recursive: true, createParents: true, dereference: true },
  },
  {
    name: "begin upload",
    parse: rpcBeginUploadOptions,
    input: {
      createParents: true,
      ifMutationToken: "epoch:7",
      mode: 0o640,
      expectedSizeBytes: 4096,
      expiresInMs: 60_000,
      contentType: "text/plain",
    },
    expected: {
      createParents: true,
      ifMutationToken: "epoch:7",
      mode: 0o640,
      expectedSizeBytes: 4096,
      expiresInMs: 60_000,
      contentType: "text/plain",
    },
  },
  {
    name: "commit upload",
    parse: rpcCommitUploadOptions,
    input: { verifiedSha256: "abc123" },
    expected: { verifiedSha256: "abc123" },
  },
];

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
      "environment record",
      { script: "true", env: new Map([["HOME", "/work"]]) },
      "options.env must be a string record",
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
    [
      "umask upper bound",
      { script: "true", umask: 0o1000 },
      "options.umask must be an integer between 000 and 777",
    ],
    ["stream-only field", { script: "true", stdout: {} }, "options.stdout is not supported"],
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
  it("rejects built-in objects where an option record is required", () => {
    expect(() => rpcWriteOptions(new Date())).toThrowError(
      expect.objectContaining({ code: "EINVAL", message: "options must be an object" }),
    );
  });

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

  it("rejects unknown find and write literals", () => {
    expect(() => rpcFindOptions({ path: "/", type: "device" })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
    expect(() => rpcWriteOptions({ disposition: "merge" })).toThrowError(
      expect.objectContaining({ code: "EINVAL" }),
    );
  });

  it.each(VFS_OPTION_BOUNDARIES)(
    "normalizes every supported $name option",
    ({ parse, input, expected }) => {
      expect(parse(input)).toEqual(expected);
    },
  );

  it.each(VFS_OPTION_BOUNDARIES)(
    "$name options reject fields outside their public contract",
    ({ parse, input }) => {
      expect(() => parse({ ...input, unexpected: true })).toThrowError(
        expect.objectContaining({
          code: "EINVAL",
          message: "options.unexpected is not supported",
        }),
      );
    },
  );

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
