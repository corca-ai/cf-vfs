import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

export function connect(base) {
  const wsUrl = new URL("/ws", base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(wsUrl, { origin: base.origin });
  const messages = [];
  socket.on("message", (bytes) => messages.push(JSON.parse(String(bytes))));
  const client = {
    socket,
    messages,
    send(message) {
      socket.send(JSON.stringify(message));
    },
    async wait(predicate, from = 0, timeout = 60000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const found = messages.slice(from).find(predicate);
        if (found) return found;
        await delay(10);
      }
      throw new Error("Timed out waiting for protocol response");
    },
    async run(line) {
      if (process.env.EVALUATION_TRACE === "1") console.error("shell", line);
      const start = messages.length;
      this.send({ type: "line", line });
      const result = await this.wait(
        (message) => message.type === "complete" || message.type === "error",
        start,
      );
      assert.equal(result.type, "complete", JSON.stringify(result));
      assert.equal(result.exitCode, 0, JSON.stringify(messages.slice(start)));
      return messages
        .slice(start)
        .filter((message) => message.type === "output" && message.stream === "stdout")
        .map((message) => message.data)
        .join("");
    },
  };
  return client;
}
