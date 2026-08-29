import { isVfsError, VfsError } from "../../core/errors.js";
import { encodeUtf8 } from "../../core/unicode.js";
import type { ShellRequest } from "../network.js";
import { fetchThrough, redirectTarget } from "../network.js";
import type { ShellCommandContext, ShellFileDescriptors } from "../types.js";
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

interface CurlInvocation {
  readonly url: string;
  readonly head: boolean;
  readonly include: boolean;
  readonly fail: boolean;
  readonly silent: boolean;
  readonly location: boolean;
  readonly output: string | undefined;
  readonly request: ShellRequest;
  readonly maxRedirects: number;
}

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

function curlBody(
  method: string,
  data: readonly string[],
  headers: Array<readonly [string, string]>,
): string | undefined {
  const body = data.length === 0 ? undefined : data.join("&");
  const normalizedMethod = method.toUpperCase();
  if (body !== undefined && (normalizedMethod === "GET" || normalizedMethod === "HEAD")) {
    throw new VfsError(
      "ENOTSUP",
      `curl: a request body with ${normalizedMethod} is not supported by the Fetch request capability`,
    );
  }
  if (body !== undefined && !headers.some(([name]) => name.toLowerCase() === "content-type")) {
    headers.push(["content-type", "application/x-www-form-urlencoded"]);
  }
  return body;
}

function curlInvocation(argv: readonly string[]): CurlInvocation {
  const parsed = parseAppletOptions(CURL, argv);
  const has = (name: string): boolean => parsed.options.some((option) => option.name === name);
  const argumentsFor = (name: string): string[] =>
    parsed.options.flatMap((option) =>
      option.name === name && "argument" in option ? [option.argument] : [],
    );
  const url = parsed.operands[0];
  if (url === undefined) throw appletUsageError(CURL, "missing URL");
  if (parsed.operands.length > 1) throw appletUsageError(CURL, "one URL at a time in this profile");
  const head = has("head");
  const data = argumentsFor("data");
  const requestedMethod = argumentsFor("request")[0];
  const method = requestedMethod ?? (head ? "HEAD" : data.length > 0 ? "POST" : "GET");
  const headers = argumentsFor("header").map(parseHeader);
  const body = curlBody(method, data, headers);
  const declaredRedirects = argumentsFor("max-redirs")[0];
  const redirectLimit =
    declaredRedirects === undefined
      ? DEFAULT_MAX_REDIRECTS
      : parseInteger(declaredRedirects, "curl: redirect limit");
  const location = has("location");
  return {
    url,
    head,
    include: has("include"),
    fail: has("fail"),
    silent: has("silent"),
    location,
    output: argumentsFor("output")[0],
    maxRedirects: location ? redirectLimit : 0,
    request: {
      url,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(requestedMethod === undefined ? {} : { preserveMethodOnRedirect: true }),
    },
  };
}

async function curlFetch(
  context: ShellCommandContext,
  invocation: CurlInvocation,
  fds: ShellFileDescriptors,
): Promise<{ readonly response: Response } | { readonly status: number }> {
  try {
    const response = await fetchThrough(
      context.network,
      context.policy.network,
      invocation.request,
      {
        maxRedirects: invocation.maxRedirects,
        signal: context.signal,
        account: () => context.budget.command(),
      },
    );
    return { response };
  } catch (error) {
    if (isVfsError(error)) throw error;
    if (context.signal.aborted)
      throw new VfsError("ECANCELED", "execution was cancelled", invocation.url);
    const message = error instanceof Error ? error.message : String(error);
    await writeText(fds[2], `curl: (${COULD_NOT_CONNECT}) ${message}\n`);
    return { status: COULD_NOT_CONNECT };
  }
}

async function curlResponseFailure(
  response: Response,
  invocation: CurlInvocation,
  fds: ShellFileDescriptors,
): Promise<number | undefined> {
  if (invocation.location && redirectTarget(response) !== null) {
    await response.body?.cancel().catch(() => undefined);
    await writeText(fds[2], `curl: (${TOO_MANY_REDIRECTS}) maximum redirects followed\n`);
    return TOO_MANY_REDIRECTS;
  }
  if (!invocation.fail || response.status < 400) return undefined;
  await response.body?.cancel().catch(() => undefined);
  if (!invocation.silent) {
    await writeText(
      fds[2],
      `curl: (${HTTP_RETURNED_ERROR}) the requested URL returned error: ${response.status}\n`,
    );
  }
  return HTTP_RETURNED_ERROR;
}

async function writeCurlResponse(
  context: ShellCommandContext,
  response: Response,
  invocation: CurlInvocation,
  fds: ShellFileDescriptors,
): Promise<void> {
  const rendered = invocation.head || invocation.include ? statusLine(response) : "";
  if (invocation.output === undefined) {
    if (rendered !== "") await writeText(fds[1], rendered);
    if (invocation.head) await response.body?.cancel().catch(() => undefined);
    else if (response.body !== null) await pipeToSink(context, response.body, fds[1]);
    return;
  }
  const path = commandPath(context, invocation.output);
  context.fileSystem.assertWritable(path);
  if (invocation.head) {
    await response.body?.cancel().catch(() => undefined);
    await context.fileSystem.writeFile(path, rendered);
    return;
  }
  await context.fileSystem.writeFile(path, await collectBody(context, response, rendered));
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
  const invocation = curlInvocation(argv);
  try {
    // Rejecting here rather than at the capability keeps a typo a usage error
    // instead of something the host has to have an opinion about.
    new URL(invocation.url);
  } catch {
    await writeText(fds[2], `curl: (${URL_MALFORMED}) URL rejected: ${invocation.url}\n`);
    return URL_MALFORMED;
  }
  const fetched = await curlFetch(context, invocation, fds);
  if ("status" in fetched) return fetched.status;
  const failure = await curlResponseFailure(fetched.response, invocation, fds);
  if (failure !== undefined) return failure;
  await writeCurlResponse(context, fetched.response, invocation, fds);
  return 0;
});
