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
}

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
  const target = new URL(location, request.url).toString();
  const disposition = REDIRECTS.get(status);
  const toGet = disposition === "to-get" && request.method !== "GET" && request.method !== "HEAD";
  if (!toGet) return { ...request, url: target };
  return {
    url: target,
    method: "GET",
    headers: request.headers.filter(
      ([name]) => name.toLowerCase() !== "content-type" && name.toLowerCase() !== "content-length",
    ),
  };
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
  const limit = options.maxRedirects ?? 0;
  let current = request;
  for (let hop = 0; ; hop += 1) {
    const response = await network.fetch(build(current, options.signal), options.signal);
    const location = redirectTarget(response);
    if (location === null || hop >= limit) return response;
    current = afterRedirect(current, location, response.status);
  }
}
