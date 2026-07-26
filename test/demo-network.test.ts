import { describe, expect, it, vi } from "vitest";
import { demoNetwork } from "../demo/network.js";

/**
 * The demo's capability, tested without leaving the machine.
 *
 * Every case here is a refusal the shell could not have made for itself, which
 * is the whole argument for putting the decision in the host: the applet knows
 * what was asked for, and only the host knows what may be answered.
 */
function withUpstream(handler: (request: Request) => Response): () => Request[] {
  const seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
    seen.push(request);
    return handler(request);
  });
  return () => seen;
}

describe("demo network capability", () => {
  it("refuses an origin that is not on the list", async () => {
    const upstream = withUpstream(() => new Response("should not reach here"));
    const response = await demoNetwork().fetch(new Request("https://elsewhere.test/"));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("origin is not allowed");
    expect(upstream()).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("refuses the demo's own origin, which is the control plane", async () => {
    const upstream = withUpstream(() => new Response("should not reach here"));
    const response = await demoNetwork().fetch(new Request("https://vfs.borca.ai/benchmark"));
    expect(response.status).toBe(403);
    expect(upstream()).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("allows a listed origin and rewrites the headers it forwards", async () => {
    const upstream = withUpstream(() => new Response("hello"));
    const response = await demoNetwork().fetch(
      new Request("https://example.com/page", {
        headers: { authorization: "Bearer session-chosen", accept: "text/plain" },
      }),
    );
    expect(response.status).toBe(200);
    const sent = upstream()[0];
    // A header the session can set is a header the session controls, so the
    // host builds its own rather than adding to what arrived.
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("accept")).toBe("text/plain");
    expect(sent?.headers.get("user-agent")).toBe("cf-vfs-demo");
    vi.unstubAllGlobals();
  });

  it("refuses a method that would let an allowed origin be told something", async () => {
    const upstream = withUpstream(() => new Response("should not reach here"));
    const response = await demoNetwork().fetch(
      new Request("https://example.com/", { method: "POST", body: "leak=secret" }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("method is not allowed");
    expect(upstream()).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("keeps redirects manual so the next hop comes back for authorization", async () => {
    const upstream = withUpstream(
      () => new Response("", { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    const response = await demoNetwork().fetch(new Request("https://example.com/go"));
    expect(response.status).toBe(302);
    expect(upstream()[0]?.redirect).toBe("manual");
    vi.unstubAllGlobals();
  });

  it("refuses a response that declares more than the demo allows", async () => {
    withUpstream(
      () => new Response("body", { headers: { "content-length": String(8 * 1024 * 1024) } }),
    );
    const response = await demoNetwork().fetch(new Request("https://example.com/big"));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("larger than the demo allows");
    vi.unstubAllGlobals();
  });
});
