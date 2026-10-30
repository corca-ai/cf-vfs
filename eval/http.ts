/** HTTP plumbing shared by the evaluation and SQL lab Workers. */

/** One request body: a script, or one batch of fixture files. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(value: unknown, status = 200): Response {
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

export async function authorized(request: Request, expected: string | undefined): Promise<boolean> {
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

export async function body(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "request body too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
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
