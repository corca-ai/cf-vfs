import { VfsError } from "../core/errors.js";

/**
 * Whether a session may reach the network.
 *
 * `off` — the default — is what keeps this shell an isolated environment: a
 * networked command answers `ENOTSUP` before anything leaves the object.
 */
export type NetworkAccess = "off" | "allow";

/**
 * The capability that lets a command reach outside the namespace.
 *
 * Deliberately one method taking a `Request` and returning a `Response`, so the
 * host decides everything a host is better placed to decide: which origins are
 * reachable, what a URL is rewritten to, which methods and bodies are allowed,
 * what is logged, and what a rate limit is. An allowlist is one implementation
 * of this rather than the shape of it — a list of hostnames bounds where a
 * request goes and says nothing about what it carries, which is the half that
 * matters once the body can be a file the agent just read.
 *
 * Credentials belong here rather than in the session. A host attaches, scopes,
 * or signs one inside its own implementation, so nothing carrying it is ever in
 * `env`, in the arguments, or on the filesystem. That is why there is no
 * `curl -u`.
 *
 * The interface is structural on purpose: a shell that never uses it never
 * mentions it, and nothing here reaches for a binding or a global `fetch`.
 */
export interface ShellNetwork {
  /**
   * Performs one request and returns its response.
   *
   * **An implementation must not follow redirects.** Requests arrive with
   * `redirect: "manual"`; returning the redirect is what lets the caller come
   * back through this method for the next hop, so every hop is authorized
   * rather than only the first. A host that follows them itself, or that hands
   * the request on with `redirect: "follow"`, turns one authorized request into
   * an unbounded number of unauthorized ones.
   */
  fetch(request: Request, signal?: AbortSignal): Promise<Response>;
}

/**
 * One request, described rather than built.
 *
 * A `Request` carries its body as a stream that can be read once, which a
 * redirect cannot replay. Describing the request instead lets each hop be a
 * fresh `Request`, which is also what the capability wants to receive.
 */
export interface ShellRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: string | undefined;
}

/** Statuses that name a new location, and whether the method survives one. */
const REDIRECTS = new Map<number, "preserve" | "to-get">([
  [301, "to-get"],
  [302, "to-get"],
  [303, "to-get"],
  [307, "preserve"],
  [308, "preserve"],
]);

/** True when a response names somewhere else to go. */
export function redirectTarget(response: Response): string | null {
  return REDIRECTS.has(response.status) ? response.headers.get("location") : null;
}

export interface FetchOptions {
  /** How many redirects to follow. Zero returns the redirect itself. */
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal | undefined;
  /** Charged once per hop, so a redirect chain meets the execution's limits. */
  readonly account?: (() => void) | undefined;
}

/** Schemes a request may name. A redirect cannot leave them. */
const TRANSFERABLE = new Set(["http:", "https:"]);

/**
 * Settles when the request does, or when the execution is cancelled.
 *
 * A host implementation is free to ignore the signal, and one that hangs would
 * otherwise hold the execution past its deadline forever. The losing request is
 * left to finish and its body cancelled; what matters is that the command stops
 * waiting for it.
 */
async function abortable(
  pending: Promise<Response>,
  signal: AbortSignal | undefined,
  url: string,
): Promise<Response> {
  if (signal === undefined) return pending;
  if (signal.aborted) throw new VfsError("ECANCELED", "execution was cancelled", url);
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new VfsError("ECANCELED", "execution was cancelled", url));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void pending.then(
      (response) => {
        if (signal.aborted) void response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
  }
}

/** Names that must not follow a request to somewhere it was not sent. */
const CROSS_ORIGIN_STRIPPED = new Set(["authorization", "cookie", "proxy-authorization"]);

function build(request: ShellRequest, signal: AbortSignal | undefined): Request {
  const headers = new Headers();
  for (const [name, value] of request.headers) headers.append(name, value);
  return new Request(request.url, {
    method: request.method,
    headers,
    // Manual is the contract: the caller re-enters this function for each hop
    // so the host authorizes each one.
    redirect: "manual",
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function afterRedirect(request: ShellRequest, location: string, status: number): ShellRequest {
  const target = new URL(location, request.url);
  // `curl` restricts redirect protocols to HTTP and HTTPS by default and the
  // fetch specification network-errors on anything else. Without this a
  // `Location: file:///…` would arrive at the capability as a request the host
  // never expected to have an opinion about.
  if (!TRANSFERABLE.has(target.protocol)) {
    throw new VfsError(
      "ENOTSUP",
      `redirect to an unsupported scheme: ${target.protocol}`,
      target.href,
    );
  }
  const disposition = REDIRECTS.get(status);
  const toGet = disposition === "to-get" && request.method !== "GET" && request.method !== "HEAD";
  // Credentials the caller set were addressed to the origin it named. Real
  // `curl` and the fetch specification both drop them when the origin changes,
  // and so must this: an allowed origin that redirects elsewhere must not be
  // able to collect what was meant for it.
  const sameOrigin = new URL(request.url).origin === target.origin;
  const headers = request.headers.filter(
    ([name]) =>
      (sameOrigin || !CROSS_ORIGIN_STRIPPED.has(name.toLowerCase())) &&
      (!toGet ||
        (name.toLowerCase() !== "content-type" && name.toLowerCase() !== "content-length")),
  );
  const next: ShellRequest = { url: target.href, method: toGet ? "GET" : request.method, headers };
  return toGet || request.body === undefined ? next : { ...next, body: request.body };
}

/**
 * Sends `request` through the capability, refusing when there is not one.
 *
 * Both conditions belong to the host: it must have supplied the capability, and
 * the session's policy must allow this session to use it. Requiring both is
 * what makes offering a shell a network a statement about the host rather than
 * a decision about every session running on it.
 *
 * The last response is returned even when it is still a redirect, so a caller
 * that ran out of hops can say so rather than being told it succeeded.
 */
export async function fetchThrough(
  network: ShellNetwork | undefined,
  access: NetworkAccess | undefined,
  request: ShellRequest,
  options: FetchOptions = {},
): Promise<Response> {
  if (network === undefined || (access ?? "off") !== "allow") {
    throw new VfsError("ENOTSUP", "network access is not available to shell commands", request.url);
  }
  if (!TRANSFERABLE.has(new URL(request.url).protocol)) {
    throw new VfsError("ENOTSUP", "only http and https can be transferred", request.url);
  }
  const limit = options.maxRedirects ?? 0;
  let current = request;
  for (let hop = 0; ; hop += 1) {
    options.account?.();
    const response = await abortable(
      network.fetch(build(current, options.signal), options.signal),
      options.signal,
      current.url,
    );
    const location = redirectTarget(response);
    if (location === null || hop >= limit) return response;
    // Nothing will read the redirect's own body, and on a platform where a
    // response is a live subrequest, leaving it open leaks one per hop.
    await response.body?.cancel().catch(() => undefined);
    current = afterRedirect(current, location, response.status);
  }
}
