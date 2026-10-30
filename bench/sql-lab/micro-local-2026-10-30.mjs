const BODY = new TextEncoder().encode("x".repeat(5000));
async function drain(stream) {
  const r = stream.getReader();
  let b = 0;
  for (let n = await r.read(); !n.done; n = await r.read()) b += n.value.byteLength;
  return b;
}
async function* counting(n) {
  for (let i = 0; i < n; i++) yield i;
}
const owned = (chunk) => {
  let done = false;
  return new ReadableStream({
    type: "bytes",
    pull(c) {
      if (done) {
        c.close();
        return;
      }
      done = true;
      c.enqueue(chunk);
    },
  });
};
const M = {
  "sync-call": [
    1e6,
    (n) => {
      let t = 0;
      for (let i = 0; i < n; i++) t += String(i).slice(1).length;
      return t;
    },
  ],
  "await-resolved": [
    1e6,
    async (n) => {
      let t = 0;
      for (let i = 0; i < n; i++) t += await Promise.resolve(1);
      return t;
    },
  ],
  "async-generator": [
    1e6,
    async (n) => {
      let t = 0;
      for await (const v of counting(n)) t += v;
      return t;
    },
  ],
  "date-now": [
    1e6,
    (n) => {
      let t = 0;
      for (let i = 0; i < n; i++) t += Date.now() & 1;
      return t;
    },
  ],
  "abort-listener": [
    1e5,
    (n) => {
      const s = new AbortController().signal,
        l = () => {};
      for (let i = 0; i < n; i++) {
        s.addEventListener("abort", l, { once: true });
        s.removeEventListener("abort", l);
      }
    },
  ],
  "text-decode": [
    1e5,
    (n) => {
      const d = new TextDecoder("utf-8", { fatal: true });
      let t = 0;
      for (let i = 0; i < n; i++) t += d.decode(BODY, { stream: true }).length;
      return t;
    },
  ],
  "copy-body": [
    1e4,
    (n) => {
      let t = 0;
      for (let i = 0; i < n; i++) t += BODY.slice().byteLength;
      return t;
    },
  ],
  "owned-stream": [
    1e4,
    async (n) => {
      let t = 0;
      for (let i = 0; i < n; i++) t += await drain(owned(BODY.slice()));
      return t;
    },
  ],
  "default-stream": [
    1e4,
    async (n) => {
      let t = 0;
      for (let i = 0; i < n; i++)
        t += await drain(
          new ReadableStream({
            start(c) {
              c.enqueue(BODY.slice());
              c.close();
            },
          }),
        );
      return t;
    },
  ],
  "blob-stream": [
    1e4,
    async (n) => {
      let t = 0;
      for (let i = 0; i < n; i++) t += await drain(new Blob([BODY.slice()]).stream());
      return t;
    },
  ],
};
for (const [k, [n, f]] of Object.entries(M)) {
  const s = [];
  for (let r = 0; r < 5; r++) {
    const a = performance.now();
    await f(n);
    s.push(performance.now() - a);
  }
  s.sort((a, b) => a - b);
  console.log(k.padEnd(16), ((s[2] * 1000) / n).toFixed(3), "µs/op");
}
