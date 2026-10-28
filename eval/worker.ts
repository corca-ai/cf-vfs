import type { SeedFile } from "./workspace.js";

export { EvalRegistry } from "./registry.js";
export { EvalWorkspace } from "./workspace.js";

const REGISTRY_NAME = "registry-v1";
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_LABEL_LENGTH = 200;
/** One request body: a script, or one batch of fixture files. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SEED_FILES = 1_000;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

interface TimingSafeSubtleCrypto {
  timingSafeEqual(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
}

function supportsTimingSafeEqual(
  subtle: SubtleCrypto,
): subtle is SubtleCrypto & TimingSafeSubtleCrypto {
  return "timingSafeEqual" in subtle && typeof subtle.timingSafeEqual === "function";
}

async function authorized(request: Request, expected: string | undefined): Promise<boolean> {
  // An unset or empty secret must never match an empty bearer token.
  if (expected === undefined || expected.length === 0) return false;
  const authorization = request.headers.get("Authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (!supportsTimingSafeEqual(crypto.subtle)) {
    throw new Error("timing-safe secret comparison is unavailable");
  }
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "request body too large");
  }
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function seedFiles(value: unknown): SeedFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "files must be an array");
  if (value.length > MAX_SEED_FILES) {
    throw new HttpError(400, `at most ${MAX_SEED_FILES} files per request`);
  }
  return value.map((file: unknown, index) => {
    if (typeof file !== "object" || file === null) {
      throw new HttpError(400, `files[${index}] must be an object`);
    }
    const { path, content } = file as Record<string, unknown>;
    if (typeof path !== "string" || path === "" || typeof content !== "string") {
      throw new HttpError(400, `files[${index}] needs string path and content`);
    }
    return { path, content };
  });
}

function ttlMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TTL_SECONDS * 1000;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_TTL_SECONDS ||
    value > MAX_TTL_SECONDS
  ) {
    throw new HttpError(
      400,
      `ttlSeconds must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS}`,
    );
  }
  return value * 1000;
}

function label(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > MAX_LABEL_LENGTH) {
    throw new HttpError(400, `label must be a string of at most ${MAX_LABEL_LENGTH} characters`);
  }
  return value;
}

function nonnegativeInteger(value: string | null, fallback: number, name: string): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `${name} must be a non-negative integer`);
  }
  return parsed;
}

async function route(request: Request, env: AgentEvalEnv): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments[0] !== "api" || segments[1] !== "instances") {
    throw new HttpError(404, "not found");
  }
  const registry = env.EVAL_REGISTRY.getByName(REGISTRY_NAME);
  const id = segments[2];
  const action = segments[3];
  if (segments.length > 4) throw new HttpError(404, "not found");

  if (id === undefined) {
    if (request.method === "GET") return json({ instances: await registry.list() });
    if (request.method === "POST") {
      const input = await body(request);
      const created = await registry.create(
        label(input["label"]),
        ttlMs(input["ttlSeconds"]),
        seedFiles(input["files"]),
      );
      if (!created.ok) throw new HttpError(created.status, created.error);
      return json({ instance: created.instance }, 201);
    }
    throw new HttpError(405, "method not allowed");
  }

  if (!INSTANCE_ID.test(id)) throw new HttpError(404, "instance not found");
  const workspace = env.EVAL_WORKSPACES.getByName(id);

  if (action === undefined) {
    if (request.method === "GET") {
      const instance = await registry.get(id);
      if (instance === null) throw new HttpError(404, "instance not found");
      const info = instance.state === "ready" ? await workspace.info() : null;
      return json({ instance, workspace: info?.ok === true ? info.value : null });
    }
    if (request.method === "DELETE") {
      if (!(await registry.destroy(id))) throw new HttpError(404, "instance not found");
      return new Response(null, { status: 204 });
    }
    throw new HttpError(405, "method not allowed");
  }

  if (action === "exec" && request.method === "POST") {
    const { script } = await body(request);
    if (typeof script !== "string") throw new HttpError(400, "script must be a string");
    // Measured here because a Durable Object's clock stands still during synchronous SQL.
    const started = Date.now();
    const outcome = await workspace.exec(script);
    const workerMs = Date.now() - started;
    if (!outcome.ok) throw new HttpError(outcome.status, outcome.error);
    return json({ ...outcome.value, workerMs });
  }
  if (action === "files" && request.method === "POST") {
    const files = seedFiles((await body(request))["files"]);
    const outcome = await workspace.seed(files);
    if (!outcome.ok) throw new HttpError(outcome.status, outcome.error);
    return json(outcome.value);
  }
  if (action === "log" && request.method === "GET") {
    const after = nonnegativeInteger(url.searchParams.get("after"), 0, "after");
    const limit = nonnegativeInteger(url.searchParams.get("limit"), 100, "limit");
    const outcome = await workspace.log(after, limit);
    if (!outcome.ok) throw new HttpError(outcome.status, outcome.error);
    return json({ entries: outcome.value });
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await authorized(request, env.AGENT_EVAL_TOKEN))) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      return await route(request, env);
    } catch (caught) {
      if (caught instanceof HttpError) return json({ error: caught.message }, caught.status);
      throw caught;
    }
  },
} satisfies ExportedHandler<AgentEvalEnv>;
