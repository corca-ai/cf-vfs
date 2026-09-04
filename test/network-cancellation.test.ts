import { expect, it } from "vitest";
import { fetchThrough } from "../src/shell/network.js";

const request = { url: "https://example.test/", method: "GET", headers: [] } as const;

it("does not dispatch a request after cancellation", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchThrough(
      {
        async fetch() {
          calls += 1;
          return new Response("unused");
        },
      },
      "allow",
      request,
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "ECANCELED" });
  expect(calls).toBe(0);
});

it("releases a response if the host cancels synchronously while starting a request", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(
    fetchThrough(
      {
        async fetch() {
          controller.abort();
          return response;
        },
      },
      "allow",
      request,
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "ECANCELED" });
  expect(cancelled).toBe(true);
});
