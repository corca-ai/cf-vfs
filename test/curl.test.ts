import { describe, expect, it } from "vitest";
import { curlCommand } from "../src/shell/commands/curl.js";
import type { ShellNetwork } from "../src/shell/network.js";
import { createBashHarness } from "./helpers/bash.js";

/**
 * A network the test owns.
 *
 * There is no Docker oracle for this command — a differential fixture would
 * need a network, which is the one thing every other fixture is pinned to avoid
 * — so the contract is asserted against a capability that records what it was
 * asked for. That is also the shape a host implements, so the tests exercise
 * the seam rather than a mock of it.
 */
function recordingNetwork(
  respond: (request: Request, hop: number) => Response | Promise<Response>,
): ShellNetwork & { readonly seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    async fetch(request) {
      seen.push(request);
      return respond(request, seen.length - 1);
    },
  };
}

/** `"unset"` leaves the policy out entirely, which is not the same as `"off"`. */
function harness(network: ShellNetwork | undefined, access: "off" | "allow" | "unset" = "allow") {
  return createBashHarness({
    extraCommands: [curlCommand],
    ...(network === undefined ? {} : { network }),
    ...(access === "unset" ? {} : { policy: { network: access } }),
  });
}

describe("curl", () => {
  it("refuses without the capability, before building a request", async () => {
    const result = await harness(undefined, "allow").run("curl https://example.test/");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("network access is not available");
    expect(result.stdout).toBe("");
  });

  it("refuses when the session policy does not allow it, even with the capability", async () => {
    const network = recordingNetwork(() => new Response("body"));
    const result = await harness(network, "off").run("curl https://example.test/");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("network access is not available");
    // The host having a network must not be the same as this session having one.
    expect(network.seen).toHaveLength(0);
  });

  it("defaults to off when the policy says nothing", async () => {
    const network = recordingNetwork(() => new Response("body"));
    const result = await harness(network, "unset").run("curl https://example.test/");
    expect(result.exitCode).not.toBe(0);
    expect(network.seen).toHaveLength(0);
  });

  it("writes the body to standard output and asks for the URL as given", async () => {
    const network = recordingNetwork(() => new Response("hello\n"));
    const result = await harness(network).run("curl https://example.test/thing");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(network.seen[0]?.url).toBe("https://example.test/thing");
    expect(network.seen[0]?.method).toBe("GET");
    // The contract the capability relies on to authorize every hop.
    expect(network.seen[0]?.redirect).toBe("manual");
  });

  it("sends headers, a body, and the method those imply", async () => {
    const network = recordingNetwork(() => new Response("ok"));
    const result = await harness(network).run(
      "curl -H 'X-One: 1' -H 'X-Two: 2' -d 'a=1' https://example.test/post",
    );
    expect(result.exitCode).toBe(0);
    const request = network.seen[0];
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("x-one")).toBe("1");
    expect(request?.headers.get("x-two")).toBe("2");
    expect(request?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(await request?.text()).toBe("a=1");
  });

  it("does not follow a redirect unless asked", async () => {
    const network = recordingNetwork(
      () => new Response("", { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    const result = await harness(network).run("curl https://example.test/");
    expect(result.exitCode).toBe(0);
    expect(network.seen).toHaveLength(1);
  });

  it("follows a redirect through the capability again, so each hop is authorized", async () => {
    const network = recordingNetwork((_request, hop) =>
      hop === 0
        ? new Response("", { status: 302, headers: { location: "/moved" } })
        : new Response("arrived"),
    );
    const result = await harness(network).run("curl -L https://example.test/start");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("arrived");
    expect(network.seen.map((request) => request.url)).toEqual([
      "https://example.test/start",
      "https://example.test/moved",
    ]);
  });

  it("lets a refusing host stop a redirect chain at the hop it disallows", async () => {
    const network = recordingNetwork((request) => {
      if (new URL(request.url).hostname !== "example.test") {
        throw new Error("origin is not allowed");
      }
      return new Response("", { status: 302, headers: { location: "https://evil.test/" } });
    });
    const result = await harness(network).run("curl -L https://example.test/");
    // A host that only allowlists the first origin would have been bypassed;
    // re-entering for the second hop is what gives it the chance to refuse.
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("origin is not allowed");
    expect(network.seen).toHaveLength(2);
  });

  it("turns a redirected POST into a GET without its body", async () => {
    const network = recordingNetwork((_request, hop) =>
      hop === 0
        ? new Response("", { status: 303, headers: { location: "/after" } })
        : new Response("done"),
    );
    await harness(network).run("curl -L -d 'a=1' https://example.test/submit");
    expect(network.seen[1]?.method).toBe("GET");
    expect(network.seen[1]?.headers.get("content-type")).toBeNull();
  });

  it("preserves the method and body across a 308", async () => {
    const network = recordingNetwork((_request, hop) =>
      hop === 0
        ? new Response("", { status: 308, headers: { location: "/kept" } })
        : new Response("done"),
    );
    await harness(network).run("curl -L -d 'a=1' https://example.test/submit");
    expect(network.seen[1]?.method).toBe("POST");
    expect(await network.seen[1]?.text()).toBe("a=1");
  });

  it("stops at the redirect limit and says so", async () => {
    const network = recordingNetwork(
      () => new Response("", { status: 302, headers: { location: "/again" } }),
    );
    const result = await harness(network).run("curl -L --max-redirs 2 https://example.test/");
    expect(result.exitCode).toBe(47);
    expect(network.seen).toHaveLength(3);
  });

  it("reports an HTTP failure only when asked to", async () => {
    const network = recordingNetwork(() => new Response("nope", { status: 404 }));
    const quiet = await harness(network).run("curl https://example.test/missing");
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stdout).toBe("nope");

    const failing = await harness(network).run("curl -f https://example.test/missing");
    expect(failing.exitCode).toBe(22);
    expect(failing.stderr).toContain("returned error: 404");
  });

  it("writes headers with -i and only headers with -I", async () => {
    const network = recordingNetwork(
      () => new Response("body", { status: 201, headers: { "x-kind": "test" } }),
    );
    const included = await harness(network).run("curl -i https://example.test/");
    expect(included.stdout).toContain("HTTP/1.1 201");
    expect(included.stdout).toContain("x-kind: test");
    expect(included.stdout.endsWith("body")).toBe(true);

    const headOnly = await harness(network).run("curl -I https://example.test/");
    expect(headOnly.stdout).toContain("HTTP/1.1 201");
    expect(headOnly.stdout).not.toContain("body");
    expect(network.seen[1]?.method).toBe("HEAD");
  });

  it("saves a body to a path and leaves standard output empty", async () => {
    const network = recordingNetwork(() => new Response("saved\n"));
    const shell = harness(network);
    const result = await shell.run("curl -o /out.txt https://example.test/");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await shell.readText("/out.txt")).toBe("saved\n");
  });

  it("rejects a malformed URL without asking the host about it", async () => {
    const network = recordingNetwork(() => new Response("body"));
    const result = await harness(network).run("curl not-a-url");
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("URL rejected");
    expect(network.seen).toHaveLength(0);
  });

  it("reports a usage error for a header with no colon", async () => {
    const network = recordingNetwork(() => new Response("body"));
    const result = await harness(network).run("curl -H nocolon https://example.test/");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("malformed header");
    expect(network.seen).toHaveLength(0);
  });

  it("is subject to the command allowlist like any other applet", async () => {
    const network = recordingNetwork(() => new Response("body"));
    const shell = createBashHarness({
      extraCommands: [curlCommand],
      network,
      policy: { network: "allow", allowedCommands: ["echo"] },
    });
    const result = await shell.run("curl https://example.test/");
    expect(result.exitCode).not.toBe(0);
    expect(network.seen).toHaveLength(0);
  });

  it("stops a redirect chain when the execution is cancelled", async () => {
    let hops = 0;
    const network: ShellNetwork = {
      async fetch() {
        hops += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response("", { status: 302, headers: { location: "/again" } });
      },
    };
    const shell = createBashHarness({
      extraCommands: [curlCommand],
      network,
      policy: { network: "allow" },
      limits: { deadlineMs: 60 },
    });
    const result = await shell.run("curl -L --max-redirs 9007199254740991 https://example.test/");
    expect(result.exitCode).not.toBe(0);
    // Without the deadline reaching the loop this runs until the number ends.
    expect(hops).toBeLessThan(500);
  });

  it("does not wait forever on a host that never answers", async () => {
    const network: ShellNetwork = { fetch: () => new Promise<Response>(() => undefined) };
    const shell = createBashHarness({
      extraCommands: [curlCommand],
      network,
      policy: { network: "allow" },
      limits: { deadlineMs: 60 },
    });
    const result = await shell.run("curl https://example.test/");
    expect(result.exitCode).not.toBe(0);
  });

  it("returns a status rather than rejecting when the host throws on abort", async () => {
    const network: ShellNetwork = {
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new DOMException("aborted", "AbortError");
      },
    };
    // A foreign rejection escaping `executeText` would be a broken invariant
    // rather than a command that failed.
    const shell = createBashHarness({
      extraCommands: [curlCommand],
      network,
      policy: { network: "allow" },
      limits: { deadlineMs: 20 },
    });
    const result = await shell.run("curl https://example.test/");
    expect(typeof result.exitCode).toBe("number");
  });

  it("charges a saved body to the execution's transfer budget", async () => {
    const network = recordingNetwork(() => new Response(new Uint8Array(64 * 1024)));
    const shell = createBashHarness({
      extraCommands: [curlCommand],
      network,
      policy: { network: "allow" },
      limits: { maxTotalIoBytes: 32 * 1024 },
    });
    // `writeFile` accounts for a mutation and not for bytes, so without
    // charging here a saved body would be transfer nobody paid for.
    const result = await shell.run("curl -o /a.bin https://example.test/");
    expect(result.exitCode).not.toBe(0);
  });

  it("refuses a scheme that is not http or https, and a redirect into one", async () => {
    const network = recordingNetwork(
      () => new Response("", { status: 302, headers: { location: "file:///etc/passwd" } }),
    );
    const direct = await harness(network).run("curl file:///etc/passwd");
    expect(direct.exitCode).not.toBe(0);
    expect(network.seen).toHaveLength(0);

    const redirected = await harness(network).run("curl -L https://example.test/");
    expect(redirected.exitCode).not.toBe(0);
    expect(redirected.stderr).toContain("unsupported scheme");
    expect(network.seen).toHaveLength(1);
  });

  it("drops credentials when a redirect changes origin, and keeps them when it does not", async () => {
    const away = recordingNetwork((_request, hop) =>
      hop === 0
        ? new Response("", { status: 302, headers: { location: "https://elsewhere.test/x" } })
        : new Response("ok"),
    );
    await harness(away).run(
      "curl -L -H 'Authorization: Bearer AGENT' -H 'X-Kind: keep' https://example.test/",
    );
    expect(away.seen[1]?.headers.get("authorization")).toBeNull();
    expect(away.seen[1]?.headers.get("x-kind")).toBe("keep");

    const within = recordingNetwork((_request, hop) =>
      hop === 0
        ? new Response("", { status: 302, headers: { location: "/moved" } })
        : new Response("ok"),
    );
    await harness(within).run("curl -L -H 'Authorization: Bearer AGENT' https://example.test/");
    expect(within.seen[1]?.headers.get("authorization")).toBe("Bearer AGENT");
  });

  it("writes headers into the output path with -i, the way curl does", async () => {
    const network = recordingNetwork(() => new Response("body", { status: 201 }));
    const shell = harness(network);
    await shell.run("curl -i -o /out.txt https://example.test/");
    const saved = await shell.readText("/out.txt");
    expect(saved).toContain("HTTP/1.1 201");
    expect(saved.endsWith("body")).toBe(true);
  });

  it("rejects a redirect limit that is not a number, with or without -L", async () => {
    const network = recordingNetwork(() => new Response("body"));
    const result = await harness(network).run("curl --max-redirs abc https://example.test/");
    expect(result.exitCode).toBe(2);
    expect(network.seen).toHaveLength(0);
  });

  it("refuses an output path outside the write roots before transferring", async () => {
    const network = recordingNetwork(() => new Response("body"));
    const shell = createBashHarness({
      extraCommands: [curlCommand],
      network,
      policy: { network: "allow", writeRoots: ["/allowed"] },
    });
    const result = await shell.run("curl -o /elsewhere.txt https://example.test/");
    expect(result.exitCode).not.toBe(0);
  });
});
