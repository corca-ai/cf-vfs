import type { ShellNetwork } from "../src/shell/network.js";

/**
 * The origins this demo will talk to.
 *
 * Chosen to be read-only and boring. An origin that accepts what a caller sends
 * — a paste service, a webhook, an issue comment — would make the allowlist a
 * list of places to exfiltrate to, which is the failure mode a hostname list
 * cannot see. That is also why the demo's own origin is not here: the benchmark
 * endpoint on this Worker is the control plane for the thing running the shell.
 */
const ALLOWED_ORIGINS = new Set([
  "https://example.com",
  "https://api.github.com",
  "https://raw.githubusercontent.com",
]);

/** Read-only, so an allowed origin is somewhere to read and not somewhere to tell. */
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

/** Enough for a page or a source file; the shell's own budget bounds the rest. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

const DENIED = { status: 403, headers: { "content-type": "text/plain" } } as const;

/**
 * The demo's network capability.
 *
 * Deliberately more than a hostname allowlist, because a hostname allowlist is
 * the part of this that does the least work. It bounds the origin, the method,
 * and the size, refuses a request that carries a body, and drops headers the
 * session should not be choosing — each of which is a decision the shell has no
 * way to make and the host has no trouble making.
 */
export function demoNetwork(): ShellNetwork {
  return {
    async fetch(request, signal) {
      const url = new URL(request.url);
      if (!ALLOWED_ORIGINS.has(url.origin)) {
        return new Response(`origin is not allowed: ${url.origin}\n`, DENIED);
      }
      if (!ALLOWED_METHODS.has(request.method)) {
        return new Response(`method is not allowed: ${request.method}\n`, DENIED);
      }
      if (request.body !== null) {
        return new Response("this demo does not send request bodies\n", DENIED);
      }

      // Set rather than append, and only after dropping what the session sent:
      // a header a caller can add to is a header the caller controls. There is
      // no credential here to protect, but the shape is the point.
      const headers = new Headers();
      const accept = request.headers.get("accept");
      if (accept !== null) headers.set("accept", accept);
      headers.set("user-agent", "cf-vfs-demo");

      const response = await fetch(
        new Request(url, { method: request.method, headers, redirect: "manual" }),
        // Manual is the contract the capability relies on: returning a redirect
        // is what lets `curl -L` come back through here, so the hop after an
        // allowed origin is checked like any other.
        { redirect: "manual", ...(signal === undefined ? {} : { signal }) },
      );

      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return new Response(`response is larger than the demo allows\n`, DENIED);
      }
      return response;
    },
  };
}
