import { isVfsError, VfsError } from "../../core/errors.js";
import { encodeUtf8 } from "../../core/unicode.js";
import type { ShellRequest } from "../network.js";
import { fetchThrough, redirectTarget } from "../network.js";
import type { ShellCommandContext } from "../types.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { commandPath, parseInteger, pipeToSink, readWithAbort, writeText } from "./helpers.js";

const CURL = {
  name: "curl",
  usage: "[-sSifIL] [-X METHOD] [-H HEADER] [-d DATA] [-o PATH] [--max-redirs N] URL",
  summary: "transfers one URL through the host's network capability",
  options: {
    short: {
      s: { name: "silent" },
      S: { name: "show-error" },
      i: { name: "include" },
      I: { name: "head" },
      f: { name: "fail" },
      L: { name: "location" },
      X: { name: "request", argument: true },
      H: { name: "header", argument: true },
      d: { name: "data", argument: true },
      o: { name: "output", argument: true },
    },
    long: {
      silent: { name: "silent" },
      "show-error": { name: "show-error" },
      include: { name: "include" },
      head: { name: "head" },
      fail: { name: "fail" },
      location: { name: "location" },
      request: { name: "request", argument: true },
      header: { name: "header", argument: true },
      data: { name: "data", argument: true },
      output: { name: "output", argument: true },
      "max-redirs": { name: "max-redirs", argument: true },
    },
  },
} as const satisfies AppletSpecWithOptions<
  | "silent"
  | "show-error"
  | "include"
  | "head"
  | "fail"
  | "location"
  | "request"
  | "header"
  | "data"
  | "output"
  | "max-redirs"
>;

/** curl's own exit codes, for the failures this profile can produce. */
const URL_MALFORMED = 3;
const COULD_NOT_CONNECT = 7;
const HTTP_RETURNED_ERROR = 22;
const TOO_MANY_REDIRECTS = 47;

const DEFAULT_MAX_REDIRECTS = 20;

function parseHeader(value: string): readonly [string, string] {
  const separator = value.indexOf(":");
  if (separator <= 0) throw appletUsageError(CURL, `malformed header: ${value}`);
  return [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
}

function statusLine(response: Response): string {
  const text = response.statusText === "" ? "" : ` ${response.statusText}`;
  const lines = [`HTTP/1.1 ${response.status}${text}`];
  for (const [name, value] of response.headers) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Reads a body into memory, charging it to the execution as it arrives.
 *
 * `writeFile` accounts for a mutation and not for the bytes moved, so a body
 * written to a path would otherwise be transfer this execution never paid for.
 * Charging on the way through is also what stops one: the budget throws, and
 * the stream is dropped.
 */
async function collectBody(
  context: ShellCommandContext,
  response: Response,
  prefix: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const encoded = encodeUtf8(prefix);
  if (encoded.byteLength > 0) {
    chunks.push(encoded);
    total = encoded.byteLength;
    context.budget.io(encoded.byteLength);
  }
  const body = response.body;
  if (body !== null) {
    const reader = body.getReader();
    try {
      for (;;) {
        const next = await readWithAbort(reader, context.signal);
        if (next.done) break;
        context.budget.io(next.value.byteLength);
        chunks.push(next.value);
        total += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
      await body.cancel().catch(() => undefined);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Transfers one URL.
 *
 * A deliberately small profile: enough for an agent to read an endpoint, post a
 * payload, save a body, and branch on failure. It reaches the network only
 * through the capability the host supplied, so what is reachable, what a
 * credential is, and whether there is a network at all are the host's answers
 * and not this command's. Options that would contradict that are absent rather
 * than approximated — there is no `-u`, because a credential the session can
 * spell is a credential the session can send somewhere else.
 *
 * Redirects are not followed unless `-L` says so, and each hop is a new request
 * through the same capability, so an origin that is refused stays refused no
 * matter which allowed origin pointed at it.
 */
export const curlCommand = /* @__PURE__ */ defineApplet(CURL, async (context, argv, fds) => {
  const parsed = parseAppletOptions(CURL, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const argumentsFor = (name: string): string[] =>
    parsed.options.flatMap((option) =>
      option.name === name && "argument" in option ? [option.argument] : [],
    );

  const url = parsed.operands[0];
  if (url === undefined) throw appletUsageError(CURL, "missing URL");
  if (parsed.operands.length > 1) {
    throw appletUsageError(CURL, "one URL at a time in this profile");
  }
  try {
    // Rejecting here rather than at the capability keeps a typo a usage error
    // instead of something the host has to have an opinion about.
    new URL(url);
  } catch {
    await writeText(fds[2], `curl: (${URL_MALFORMED}) URL rejected: ${url}\n`);
    return URL_MALFORMED;
  }

  const head = has("head");
  const data = argumentsFor("data");
  const requestedMethod = argumentsFor("request")[0];
  const method = requestedMethod ?? (head ? "HEAD" : data.length > 0 ? "POST" : "GET");
  const normalizedMethod = method.toUpperCase();
  const headers = argumentsFor("header").map(parseHeader);
  const body = data.length === 0 ? undefined : data.join("&");
  if (body !== undefined && (normalizedMethod === "GET" || normalizedMethod === "HEAD")) {
    throw new VfsError(
      "ENOTSUP",
      `curl: a request body with ${normalizedMethod} is not supported by the Fetch request capability`,
    );
  }
  if (body !== undefined && !headers.some(([name]) => name.toLowerCase() === "content-type")) {
    headers.push(["content-type", "application/x-www-form-urlencoded"]);
  }
  // Validated whether or not `-L` is present, so a typo is a usage error rather
  // than something silently ignored.
  const declaredRedirects = argumentsFor("max-redirs")[0];
  const redirectLimit =
    declaredRedirects === undefined
      ? DEFAULT_MAX_REDIRECTS
      : parseInteger(declaredRedirects, "curl: redirect limit");
  const maxRedirects = has("location") ? redirectLimit : 0;

  const request: ShellRequest = {
    url,
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(requestedMethod === undefined ? {} : { preserveMethodOnRedirect: true }),
  };

  let response: Response;
  try {
    response = await fetchThrough(context.network, context.policy.network, request, {
      maxRedirects,
      signal: context.signal,
      // Each hop is work the execution asked for, so each meets the same
      // ceiling every other command does.
      account: () => context.budget.command(),
    });
  } catch (error) {
    // A refusal and a cancellation are the shell's own errors and carry their
    // own handling. Anything else is a transfer that did not happen, and it has
    // to become a status here: a host's rejection escaping `executeText` would
    // be a broken invariant rather than a command that failed.
    if (isVfsError(error)) throw error;
    if (context.signal.aborted) {
      throw new VfsError("ECANCELED", "execution was cancelled", url);
    }
    const message = error instanceof Error ? error.message : String(error);
    await writeText(fds[2], `curl: (${COULD_NOT_CONNECT}) ${message}\n`);
    return COULD_NOT_CONNECT;
  }

  const discard = async (): Promise<void> => {
    await response.body?.cancel().catch(() => undefined);
  };

  if (has("location") && redirectTarget(response) !== null) {
    await discard();
    await writeText(fds[2], `curl: (${TOO_MANY_REDIRECTS}) maximum redirects followed\n`);
    return TOO_MANY_REDIRECTS;
  }

  if (has("fail") && response.status >= 400) {
    await discard();
    if (!has("silent")) {
      await writeText(
        fds[2],
        `curl: (${HTTP_RETURNED_ERROR}) the requested URL returned error: ${response.status}\n`,
      );
    }
    return HTTP_RETURNED_ERROR;
  }

  const output = argumentsFor("output")[0];
  const rendered = head || has("include") ? statusLine(response) : "";
  if (output === undefined) {
    if (rendered !== "") await writeText(fds[1], rendered);
    if (head) {
      await discard();
      return 0;
    }
    if (response.body !== null) await pipeToSink(context, response.body, fds[1]);
    return 0;
  }

  const path = commandPath(context, output);
  // Refuse before reading. A body pulled and then discarded because the path
  // was never writable is bytes spent on nothing.
  context.fileSystem.assertWritable(path);
  if (head) {
    await discard();
    await context.fileSystem.writeFile(path, rendered);
    return 0;
  }
  const bytes = await collectBody(context, response, rendered);
  await context.fileSystem.writeFile(path, bytes);
  return 0;
});
