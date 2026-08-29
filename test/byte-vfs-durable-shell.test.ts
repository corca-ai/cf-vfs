import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { R2OpaqueStore } from "../src/storage/r2.js";
import { DurableObjectFileSystem } from "../src/vfs/do-sql.js";
import { streamFromChunks } from "../src/vfs/streams.js";
import type { TestWorkspaceVfs } from "./worker.js";

function workspace(name: string): DurableObjectStub<TestWorkspaceVfs> {
  return env.VFS_TEST.getByName(`byte-${name}`);
}

it("executes Bash-compatible source over bounded RPC text results", async () => {
  const stub = workspace("shell-text-rpc");
  const result = await stub.executeText({
    script: "mkdir -p /repo; printf world > /repo/name; printf 'hello '; cat /repo/name",
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: "hello world", stderr: "" });
});

it("carries numeric credentials, groups, and umask across shell RPC", async () => {
  const stub = workspace("shell-posix-identity-rpc");
  await stub.mkdir("/home");
  await stub.setOwnership("/home", { uid: 1_000, gid: 10 });
  await stub.setMetadata("/home", { mode: 0o040700 });
  const result = await stub.executeText({
    script: "id; printf body > /home/file; chown :20 /home/file; stat -c '%u:%g:%a' /home/file",
    credentials: { uid: 1_000, gid: 10, supplementaryGids: [20] },
    umask: 0o027,
  });

  expect(result).toEqual({
    exitCode: 0,
    stdout: "uid=1000 gid=10 groups=10,20\n1000:20:640\n",
    stderr: "",
  });
});

it("checks credentials on paths deeper than the SQL binding limit", async () => {
  const stub = workspace("deep-posix-path");
  const path = `/${Array.from({ length: 120 }, (_unused, index) => `d${index}`).join("/")}`;
  const stat = await runInDurableObject(stub, (_instance, state) => {
    const fileSystem = new DurableObjectFileSystem(state.storage);
    fileSystem.mkdir(path, true);
    return fileSystem.forCredentials({ uid: 0, gid: 0 }).stat(path);
  });
  expect(stat.path).toBe(path);
});

it("resolves symlinks on paths deeper than the SQL binding limit", async () => {
  const stub = workspace("deep-symlink-path");
  const suffix = `/${Array.from({ length: 120 }, (_unused, index) => `d${index}`).join("/")}`;
  const stat = await runInDurableObject(stub, (_instance, state) => {
    const fileSystem = new DurableObjectFileSystem(state.storage);
    fileSystem.mkdir(`/target${suffix}`, true);
    fileSystem.symlink("/link", "/target");
    return fileSystem.stat(`/link${suffix}`);
  });
  expect(stat.path).toBe(`/target${suffix}`);
});

it("preflights recursive permissions with more than 100 groups", async () => {
  const stub = workspace("many-posix-groups");
  const removed = await runInDurableObject(stub, async (_instance, state) => {
    const fileSystem = new DurableObjectFileSystem(state.storage);
    fileSystem.mkdir("/home/tree", true);
    fileSystem.setOwnership("/home", { uid: 1_000, gid: 10 });
    fileSystem.setMetadata("/home", { mode: 0o040700 });
    fileSystem.setOwnership("/home/tree", { uid: 1_000, gid: 10 });
    fileSystem.setMetadata("/home/tree", { mode: 0o040700 });
    await fileSystem.writeFile("/home/tree/file", "body");
    const user = fileSystem.forCredentials({
      uid: 1_000,
      gid: 10,
      supplementaryGids: Array.from({ length: 120 }, (_unused, index) => 100 + index),
    });
    return user.remove("/home/tree", { recursive: true });
  });
  expect(removed).toEqual({ removed: 2, opaqueObjectsQueuedForDeletion: 0 });
});

it("preserves an interactive session over the SQLite-backed VFS", async () => {
  const stub = workspace("interactive-shell-rpc");
  await expect(
    stub.executeInteractiveText("mkdir -p /repo; cd /repo; NAME=sqlite; printf body > file"),
  ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
  await expect(
    stub.executeInteractiveText('printf \'%s:%s:\' "$PWD" "$NAME"; cat file'),
  ).resolves.toEqual({
    exitCode: 0,
    stdout: "/repo:sqlite:body",
    stderr: "",
  });
  await runInDurableObject(stub, (_instance, state) => {
    expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
  });
});

it("does not create or reject a missing touch -c target through RPC", async () => {
  const stub = workspace("shell-touch-no-create-rpc");
  const result = await stub.executeText({
    script: "touch /existing; touch -c /missing /existing; [[ ! -e /missing && -e /existing ]]",
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
});

it("sources an inline VFS unit through the Durable Object shell", async () => {
  const stub = workspace("shell-source-rpc");
  const result = await stub.executeText({
    script: [
      "cat > /library.sh <<'EOF'",
      "VALUE=sourced",
      "show() { printf '%s' \"$VALUE\"; }",
      "return 7",
      "EOF",
      "source /library.sh argument || printf '%s|' \"$?\"",
      "show",
    ].join("\n"),
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: "7|sourced", stderr: "" });
});

it("reads streamed records and parses positional options through RPC", async () => {
  const stub = workspace("shell-input-builtins-rpc");
  const result = await stub.executeText({
    script: [
      "read -r FIRST",
      "read -r SECOND",
      "getopts 'a:' OPT",
      'shift "$((OPTIND - 1))"',
      'printf \'%s:%s|%s:%s\' "$FIRST" "$SECOND" "$OPTARG" "$1"',
    ].join("\n"),
    args: ["-a", "value", "tail"],
    stdin: streamFromChunks([
      new TextEncoder().encode("first\nsec"),
      new TextEncoder().encode("ond\n"),
    ]),
  });
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "first:second|value:tail",
    stderr: "",
  });
});

it("expands bounded parameter patterns and substrings through RPC", async () => {
  const stub = workspace("shell-parameter-v3-rpc");
  const result = await stub.executeText({
    script: [
      "VALUE=src/components/button.ts",
      "BASE=${VALUE##*/}",
      "STEM=${BASE%.ts}",
      'printf \'%s|%s|%s\' "${STEM//t/T}" "${VALUE:4:10}" "${VALUE: -2}"',
    ].join("\n"),
  });
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "buTTon|components|ts",
    stderr: "",
  });
});

it("contains nounset termination at an isolated RPC shell scope", async () => {
  const stub = workspace("shell-nounset-v3-rpc");
  const result = await stub.executeText({
    script: [
      "set -u",
      "(printf '%s' \"$MISSING\") || printf '%s|' \"$?\"",
      "set +u",
      "printf '<%s>' \"$MISSING\"",
    ].join("\n"),
  });
  expect(result).toMatchObject({
    exitCode: 0,
    stdout: "1|<>",
    stderr: "MISSING: unbound variable\n",
  });
});

it("propagates deterministic errexit contexts through the Durable Object shell", async () => {
  const stub = workspace("shell-errexit-v4-rpc");
  const result = await stub.executeText({
    script: [
      "cat > /failure.sh <<'EOF'",
      "false",
      "printf sourced",
      "EOF",
      "set -e",
      "run() { false; printf function; }",
      "run || printf fallback",
      "source /failure.sh || printf fallback",
      "(false; printf sub) || printf fallback",
      "VALUE=$(false; printf value)",
      "printf '|%s|' \"$VALUE\"",
      "set -o pipefail",
      "false | true",
      "touch /after",
    ].join("\n"),
  });
  expect(result).toEqual({
    exitCode: 1,
    stdout: "functionsourcedsub|value|",
    stderr: "",
  });
  await expect(stub.executeText({ script: "[[ ! -e /after ]]" })).resolves.toMatchObject({
    exitCode: 0,
  });
  await expect(
    stub.executeText({
      script: "set -e; fail() { return 7; }; fail; printf no",
    }),
  ).resolves.toEqual({ exitCode: 7, stdout: "", stderr: "" });
});

it("exposes opaque files to double-bracket metadata predicates without reading R2", async () => {
  const stub = workspace("shell-double-bracket-opaque-v3");
  const upload = await stub.beginOpaqueUpload("/asset", { expectedSizeBytes: 4 });
  await new R2OpaqueStore(env.VFS_TEST_BUCKET).putIfAbsent(upload.objectKey, "body");
  await stub.commitOpaqueUpload(upload.uploadId);
  const result = await stub.executeText({
    script: "[[ -e /asset && -f /asset && ! -d /asset ]] && printf opaque",
  });
  expect(result).toEqual({ exitCode: 0, stdout: "opaque", stderr: "" });
  expect((await stub.stat("/asset")).contentClass).toBe("opaque");
});

it("uses caller-provided byte streams for the remote streaming boundary", async () => {
  const stub = workspace("shell-stream-rpc");
  const input = streamFromChunks([new TextEncoder().encode("streamed")]);
  const stdout = new IdentityTransformStream();
  const stderr = new IdentityTransformStream();

  const call = stub.executeTo({
    script: "cat",
    stdin: input,
    stdout: stdout.writable,
    stderr: stderr.writable,
  });
  const [status, output, error] = await Promise.all([
    call,
    new Response(stdout.readable).text(),
    new Response(stderr.readable).text(),
  ]);
  expect(status.exitCode).toBe(0);
  expect(output).toBe("streamed");
  expect(error).toBe("");
});
