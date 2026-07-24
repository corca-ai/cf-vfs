import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const DEFAULT_URL = "https://vfs.borca.ai";
const LOCAL_SECRET_PATH = new URL("../.dev.vars.benchmark", import.meta.url);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function localToken() {
  try {
    const contents = await readFile(LOCAL_SECRET_PATH, "utf8");
    for (const line of contents.split(/\r?\n/u)) {
      const match = line.match(/^\s*BENCHMARK_TOKEN\s*=\s*(.+?)\s*$/u);
      if (match === null) continue;
      const value = match[1] ?? "";
      return value.replace(/^(["'])(.*)\1$/u, "$2");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return undefined;
}

function atPath(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || !(part in current)) {
      throw new Error(`benchmark result is missing ${path}`);
    }
    current = current[part];
  }
  return current;
}

function checkResult(result, baseline) {
  if (
    result.schemaVersion !== baseline.schemaVersion
    || result.profile !== baseline.profile
    || result.timing !== baseline.timing
  ) {
    throw new Error(
      "remote benchmark result schema, profile, or timing model does not match baseline",
    );
  }
  const exactPaths = [
    "point.statCost.statements",
    "point.statCost.rowsRead",
    "point.statCost.rowsWritten",
    "point.statCost.nextCalls",
    "point.statCost.toArrayCalls",
    "point.statCost.oneCalls",
    "point.overwriteCost.statements",
    "point.overwriteCost.rowsRead",
    "point.overwriteCost.rowsWritten",
    "point.populatedStatCost.statements",
    "point.populatedStatCost.rowsRead",
    "point.populatedStatCost.rowsWritten",
    "append.1MiB.maxRowsWritten",
    "append.8MiB.maxRowsWritten",
    "subtree.100.statements.copy",
    "subtree.100.statements.move",
    "subtree.100.statements.remove",
    "subtree.1000.statements.copy",
    "subtree.1000.statements.move",
    "subtree.1000.statements.remove",
  ];
  const timingPaths = [
    "point.stat.medianMs",
    "point.overwrite.medianMs",
    "point.findPage.medianMs",
    "point.warmInitialize.medianMs",
    "append.1MiB.duration.medianMs",
    "append.8MiB.duration.medianMs",
    "subtree.100.copy.medianMs",
    "subtree.100.move.medianMs",
    "subtree.100.remove.medianMs",
    "subtree.1000.copy.medianMs",
    "subtree.1000.move.medianMs",
    "subtree.1000.remove.medianMs",
  ];
  const failures = [];
  for (const path of exactPaths) {
    const actual = atPath(result, path);
    const expected = atPath(baseline, path);
    if (actual !== expected) failures.push(`${path}: expected ${expected}, got ${actual}`);
  }
  for (const path of timingPaths) {
    const actual = atPath(result, path);
    const expected = atPath(baseline, path);
    const ceiling = Math.max(expected * 3, expected + 2);
    if (actual > ceiling) {
      failures.push(
        `${path}: ${actual.toFixed(3)}ms exceeds ${ceiling.toFixed(3)}ms ceiling`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(`remote benchmark regression:\n${failures.join("\n")}`);
  }
}

async function requestBenchmark(endpoint, token, timeoutMs) {
  const resolveAddress = process.env.CF_VFS_BENCHMARK_RESOLVE;
  if (resolveAddress === undefined) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.text(),
    };
  }

  const family = isIP(resolveAddress);
  if (family === 0) {
    throw new Error("CF_VFS_BENCHMARK_RESOLVE must be an IPv4 or IPv6 address");
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      lookup(_hostname, options, callback) {
        if (typeof options === "object" && options.all === true) {
          callback(null, [{ address: resolveAddress, family }]);
        } else {
          callback(null, resolveAddress, family);
        }
      },
    }, (response) => {
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          request.destroy(new Error("benchmark response exceeded 1 MiB"));
        }
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, body });
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`benchmark request exceeded ${timeoutMs}ms`));
    });
    request.on("error", reject);
    request.end();
  });
}

const profile = argumentValue("--profile") ?? "quick";
if (profile !== "quick" && profile !== "full") {
  throw new Error("--profile must be quick or full");
}
const endpoint = new URL("/benchmark", process.env.CF_VFS_BENCHMARK_URL ?? DEFAULT_URL);
endpoint.searchParams.set("profile", profile);
const token = process.env.CF_VFS_BENCHMARK_TOKEN ?? await localToken();
if (token === undefined || token.length === 0) {
  throw new Error(
    "set CF_VFS_BENCHMARK_TOKEN or create ignored .dev.vars.benchmark",
  );
}

const started = performance.now();
const response = await requestBenchmark(
  endpoint,
  token,
  profile === "full" ? 300_000 : 120_000,
);
const body = response.body;
if (!response.ok) {
  throw new Error(`benchmark request failed (${response.status}): ${body}`);
}
const result = JSON.parse(body);
const clientRoundTripMs = Number((performance.now() - started).toFixed(3));
const checkPath = argumentValue("--check");
if (checkPath !== undefined) {
  const baseline = JSON.parse(await readFile(checkPath, "utf8"));
  checkResult(result, baseline);
}

console.log(JSON.stringify({ ...result, clientRoundTripMs }, null, 2));
if (checkPath !== undefined) console.error(`remote benchmark check passed: ${checkPath}`);
