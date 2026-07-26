import { isVfsError } from "../../core/errors.js";
import type { ShellRequest } from "../network.js";
import { fetchThrough, redirectTarget } from "../network.js";
import {
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { commandPath, parseInteger, pipeToSink, writeText } from "./helpers.js";

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
  const method = argumentsFor("request")[0] ?? (head ? "HEAD" : data.length > 0 ? "POST" : "GET");
  const headers = argumentsFor("header").map(parseHeader);
  const body = data.length === 0 ? undefined : data.join("&");
  if (body !== undefined && !headers.some(([name]) => name.toLowerCase() === "content-type")) {
    headers.push(["content-type", "application/x-www-form-urlencoded"]);
  }
  const maxRedirects = has("location")
    ? (() => {
        const declared = argumentsFor("max-redirs")[0];
        return declared === undefined
          ? DEFAULT_MAX_REDIRECTS
          : parseInteger(declared, "curl: redirect limit");
      })()
    : 0;

  const request: ShellRequest = {
    url,
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  };

  let response: Response;
  try {
    response = await fetchThrough(context.network, context.policy.network, request, {
      maxRedirects,
      signal: context.signal,
    });
  } catch (error) {
    // A refusal is the host's answer and belongs to the caller as one; anything
    // else the capability throws is a transfer that did not happen.
    if (isVfsError(error) && error.code === "ENOTSUP") throw error;
    if (context.signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await writeText(fds[2], `curl: (${COULD_NOT_CONNECT}) ${message}\n`);
    return COULD_NOT_CONNECT;
  }

  if (maxRedirects > 0 && redirectTarget(response) !== null) {
    await writeText(fds[2], `curl: (${TOO_MANY_REDIRECTS}) maximum redirects followed\n`);
    return TOO_MANY_REDIRECTS;
  }

  if (has("fail") && response.status >= 400) {
    if (!has("silent")) {
      await writeText(
        fds[2],
        `curl: (${HTTP_RETURNED_ERROR}) the requested URL returned error: ${response.status}\n`,
      );
    }
    return HTTP_RETURNED_ERROR;
  }

  const output = argumentsFor("output")[0];
  if (head || has("include")) {
    const rendered = statusLine(response);
    if (output === undefined) await writeText(fds[1], rendered);
    else if (head) {
      await context.fileSystem.writeFile(commandPath(context, output), rendered);
      return 0;
    }
  }
  if (head) return 0;

  const stream = response.body;
  if (output !== undefined) {
    await context.fileSystem.writeFile(commandPath(context, output), stream ?? new Uint8Array(0));
    return 0;
  }
  if (stream !== null) await pipeToSink(context, stream, fds[1]);
  return 0;
});
