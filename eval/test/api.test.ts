import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { Instance } from "../registry.js";
import type { ExecLogEntry, ExecResult, WorkspaceInfo } from "../workspace.js";

const AUTH = { Authorization: "Bearer test-token" };

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://eval.test${path}`, {
    ...init,
    headers: { ...AUTH, "Content-Type": "application/json", ...init.headers },
  });
}

async function create(input: Record<string, unknown> = {}): Promise<Instance> {
  const response = await api("/api/instances", { method: "POST", body: JSON.stringify(input) });
  expect(response.status).toBe(201);
  return ((await response.json()) as { instance: Instance }).instance;
}

async function exec(id: string, script: string): Promise<ExecResult & { workerMs: number }> {
  const response = await api(`/api/instances/${id}/exec`, {
    method: "POST",
    body: JSON.stringify({ script }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ExecResult & { workerMs: number };
}

async function list(): Promise<Instance[]> {
  const response = await api("/api/instances");
  return ((await response.json()) as { instances: Instance[] }).instances;
}

afterEach(async () => {
  for (const instance of await list()) {
    await api(`/api/instances/${instance.id}`, { method: "DELETE" });
  }
});

it("refuses every route without the bearer token", async () => {
  for (const [path, method] of [
    ["/api/instances", "GET"],
    ["/api/instances", "POST"],
    ["/", "GET"],
  ] as const) {
    const anonymous = await SELF.fetch(`https://eval.test${path}`, { method });
    expect(anonymous.status).toBe(401);
    const wrong = await SELF.fetch(`https://eval.test${path}`, {
      method,
      headers: { Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
  }
});

it("creates, lists, describes and deletes an instance", async () => {
  const instance = await create({ label: "pilot" });
  expect(instance).toMatchObject({ label: "pilot", state: "ready" });
  expect((await list()).map((entry) => entry.id)).toEqual([instance.id]);

  const described = await api(`/api/instances/${instance.id}`);
  const details = (await described.json()) as { instance: Instance; workspace: WorkspaceInfo };
  expect(details.workspace).toMatchObject({ cwd: "/workspace", execCount: 0 });

  expect((await api(`/api/instances/${instance.id}`, { method: "DELETE" })).status).toBe(204);
  expect(await list()).toEqual([]);
  const gone = await api(`/api/instances/${instance.id}/exec`, {
    method: "POST",
    body: JSON.stringify({ script: "true" }),
  });
  expect(gone.status).toBe(404);
  expect((await api(`/api/instances/${instance.id}`, { method: "DELETE" })).status).toBe(404);
});

it("keeps the working directory between executions but not variables", async () => {
  const { id } = await create();
  expect((await exec(id, "pwd")).stdout).toBe("/workspace\n");
  const moved = await exec(id, "mkdir -p notes && cd notes && X=1");
  expect(moved).toMatchObject({ exitCode: 0, cwd: "/workspace/notes" });
  expect((await exec(id, 'pwd; echo "x=${X:-unset}"')).stdout).toBe("/workspace/notes\nx=unset\n");

  await exec(id, "cd /workspace && rm -r notes");
  await exec(id, "mkdir gone && cd gone");
  await exec(id, "rmdir /workspace/gone");
  const reset = await exec(id, "pwd");
  expect(reset).toMatchObject({ cwdReset: true, stdout: "/workspace\n" });
});

it("looks like an ordinary Linux account", async () => {
  const { id } = await create();
  const result = await exec(
    id,
    'id -un; echo "$HOME"; touch mine; stat -c "%U %a" mine; stat -c "%a" /tmp',
  );
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(result.stdout).toBe("user\n/home/user\nuser 644\n1777\n");
});

it("reports status, output, commands and SQL cost for each execution", async () => {
  const { id } = await create();
  const result = await exec(id, "echo hi > a.txt; cat a.txt; cat missing.txt");
  expect(result).toMatchObject({ exitCode: 1, stdout: "hi\n", error: null, seq: 1 });
  expect(result.stderr).toContain("missing.txt");
  // A command that fails by throwing emits no `shell.command` event, so the
  // failing `cat` is visible only through status and stderr.
  expect(result.commands.map((command) => command.name)).toEqual(["echo", "cat"]);
  expect(result.sql.statements).toBeGreaterThan(0);
  expect(result.sql.rowsWritten).toBeGreaterThan(0);
  expect(result.mutations).toBeGreaterThan(0);

  const unsupported = await exec(id, "arr=(1 2 3); echo ${arr[1]}");
  expect(unsupported.exitCode).not.toBe(0);
  expect(unsupported.stderr).not.toBe("");

  const response = await api(`/api/instances/${id}/log?after=1`);
  const { entries } = (await response.json()) as { entries: ExecLogEntry[] };
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ seq: 2, script: "arr=(1 2 3); echo ${arr[1]}" });
});

it("records an execution limit as a failure code", async () => {
  const { id } = await create();
  const result = await exec(id, "while true; do :; done");
  expect(result.exitCode).not.toBe(0);
  expect(result.failureCode).not.toBeNull();
  expect(result.limits.length).toBeGreaterThan(0);
});

it("seeds fixture files as the agent account, at creation and later", async () => {
  const { id } = await create({
    files: [
      { path: "wiki/index.md", content: "# Home\nSee [[guide]].\n" },
      { path: "/workspace/wiki/guide.md", content: "# Guide\n" },
    ],
  });
  const more = await api(`/api/instances/${id}/files`, {
    method: "POST",
    body: JSON.stringify({ files: [{ path: "wiki/faq.md", content: "# FAQ\n" }] }),
  });
  expect(more.status).toBe(200);
  const result = await exec(id, "grep -rl '^# ' wiki | sort; stat -c %U wiki/faq.md");
  expect(result.stdout).toBe("wiki/faq.md\nwiki/guide.md\nwiki/index.md\nuser\n");
});

it("refuses instances beyond the configured limit", async () => {
  for (let index = 0; index < 3; index += 1) await create();
  const refused = await api("/api/instances", { method: "POST", body: "{}" });
  expect(refused.status).toBe(429);
});

it("validates request bodies", async () => {
  const bad = await api("/api/instances", {
    method: "POST",
    body: JSON.stringify({ ttlSeconds: 1 }),
  });
  expect(bad.status).toBe(400);
  const { id } = await create();
  const noScript = await api(`/api/instances/${id}/exec`, { method: "POST", body: "{}" });
  expect(noScript.status).toBe(400);
  const unknown = await api("/api/instances/not-an-id/exec", {
    method: "POST",
    body: JSON.stringify({ script: "true" }),
  });
  expect(unknown.status).toBe(404);
});

it("expires instances and finishes interrupted transitions from the alarm", async () => {
  const expiring = await create({ ttlSeconds: 60 });
  const kept = await create();
  const registry = env.EVAL_REGISTRY.getByName("registry-v1");
  await runInDurableObject(registry, (_instance, state) => {
    state.storage.sql.exec("UPDATE eval_instances SET expires_at = 0 WHERE id = ?", expiring.id);
    // A creation whose Worker died after reserving the row.
    state.storage.sql.exec(
      "INSERT INTO eval_instances VALUES ('00000000-0000-4000-8000-000000000000', '', 'creating', 0, ?, 0)",
      Date.now() + 60_000,
    );
  });
  expect(await runDurableObjectAlarm(registry)).toBe(true);
  expect((await list()).map((entry) => entry.id)).toEqual([kept.id]);

  const workspace = env.EVAL_WORKSPACES.getByName(expiring.id);
  const info = await workspace.info();
  expect(info.ok).toBe(false);
});
