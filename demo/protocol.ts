import { VfsError } from "../src/core/errors.js";

/** The largest client message this protocol accepts, in bytes. */
export const MAX_MESSAGE_BYTES = 128 * 1024 + 1024;

/**
 * The wire protocol between the browser client and this Worker.
 *
 * Kept apart from the Durable Object so the parsing — the part with rules
 * worth getting wrong — can be tested without a workerd binding. A message
 * arriving from a browser is untrusted input like any other.
 */
export type ClientMessage =
  | { readonly type: "line"; readonly line: string }
  | { readonly type: "signal"; readonly signal: "SIGINT" }
  | {
      readonly type: "complete";
      readonly line: string;
      readonly cursor: number;
      /** Echoed back, so a client can drop an answer to a stale keystroke. */
      readonly token: number;
    }
  | {
      /** Presentation only: nothing here claims a terminal mode or an ioctl. */
      readonly type: "resize";
      readonly columns: number;
      readonly rows: number;
    }
  | { readonly type: "doc-open"; readonly path: string }
  | {
      readonly type: "doc-edit";
      readonly path: string;
      /**
       * The version this text was typed against.
       *
       * The same shape the filesystem uses one level down: a writer that was
       * working from something already replaced is told so rather than allowed
       * to overwrite, and asks for the current state instead.
       */
      readonly base: number;
      readonly text: string;
    }
  | { readonly type: "doc-close"; readonly path: string }
  | { readonly type: "ping" };

/**
 * What the server tells a client about itself on connect.
 *
 * Machine-readable on purpose: an agent or a UI should be able to discover
 * what this session supports without a version-sniffing table, and should be
 * able to see plainly that only files survive a reconnect.
 */
export interface HelloMessage {
  readonly type: "hello";
  readonly cwd: string;
  readonly protocol: 1;
  readonly features: readonly string[];
  readonly limits: {
    /** The largest message this session accepts, which is what rejects one. */
    readonly maxMessageBytes: number;
    readonly maxSourceBytes: number;
    readonly maxCompletionCandidates: number;
  };
  /** The shared room this session joined, as `country-KR`. */
  readonly workspace: string;
  /**
   * What survives a reconnect, said outright.
   *
   * Files are in the Durable Object and durable. The shell session — working
   * directory, environment, functions, history — lives in memory for as long
   * as the socket does. A client that reconnects gets a new session and must
   * not present it as a resumed one.
   */
  readonly durability: {
    readonly files: "durable";
    readonly session: "connection";
  };
}

export type ServerMessage =
  | HelloMessage
  | {
      readonly type: "output";
      readonly stream: "stdout" | "stderr";
      readonly data: string;
    }
  | {
      readonly type: "prompt";
      readonly cwd: string;
      readonly continuation: boolean;
      readonly exitCode: number;
    }
  | { readonly type: "running" }
  | { readonly type: "complete"; readonly cwd: string; readonly exitCode: number }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly exitCode: number }
  | {
      readonly type: "candidates";
      readonly token: number;
      readonly start: number;
      readonly end: number;
      readonly commonPrefix: string;
      readonly truncated: boolean;
      readonly values: readonly { readonly value: string; readonly kind: string }[];
    }
  | {
      /** The whole document, on open and whenever a client has fallen behind. */
      readonly type: "doc";
      readonly path: string;
      readonly version: number;
      readonly text: string;
    }
  | {
      /** The namespace took the document away, from a `mv` or an `rm`. */
      readonly type: "doc-gone";
      readonly path: string;
      readonly to?: string;
    }
  | { readonly type: "pong" };

export function parseClientMessage(message: string | ArrayBuffer): ClientMessage {
  if (typeof message !== "string") {
    throw new VfsError("EINVAL", "binary WebSocket messages are not supported");
  }
  if (new TextEncoder().encode(message).byteLength > MAX_MESSAGE_BYTES) {
    throw new VfsError("E2BIG", "WebSocket message is too large");
  }

  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    throw new VfsError("EINVAL", "WebSocket message must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VfsError("EINVAL", "WebSocket message must be an object");
  }

  const input = value as Readonly<Record<string, unknown>>;
  if (input["type"] === "ping") return { type: "ping" };
  if (input["type"] === "signal" && input["signal"] === "SIGINT") {
    return { type: "signal", signal: "SIGINT" };
  }
  if (input["type"] === "line" && typeof input["line"] === "string") {
    return { type: "line", line: input["line"] };
  }
  if (input["type"] === "complete" && typeof input["line"] === "string") {
    const line = input["line"];
    const cursor = input["cursor"];
    const token = input["token"];
    // A cursor is an offset into the line, so anything that is not a whole
    // number inside it is a malformed request rather than one to clamp: `NaN`
    // would otherwise travel back out as a `null` offset the client splices on.
    if (
      !Number.isInteger(cursor) ||
      !Number.isInteger(token) ||
      (cursor as number) < 0 ||
      (cursor as number) > line.length
    ) {
      throw new VfsError("EINVAL", "completion cursor must be an offset into the line");
    }
    return { type: "complete", line, cursor: cursor as number, token: token as number };
  }
  if (
    (input["type"] === "doc-open" || input["type"] === "doc-close") &&
    typeof input["path"] === "string"
  ) {
    return { type: input["type"], path: input["path"] };
  }
  if (
    input["type"] === "doc-edit" &&
    typeof input["path"] === "string" &&
    typeof input["text"] === "string"
  ) {
    const base = input["base"];
    // A version is a counter the server issued, so anything that is not a
    // whole number is a malformed request rather than one to coerce: a `NaN`
    // base would compare unequal forever and resynchronize on every keystroke.
    if (!Number.isInteger(base) || (base as number) < 0) {
      throw new VfsError("EINVAL", "document base must be a version this session was given");
    }
    return {
      type: "doc-edit",
      path: input["path"],
      base: base as number,
      text: input["text"],
    };
  }
  if (input["type"] === "resize") {
    const columns = input["columns"];
    const rows = input["rows"];
    if (!Number.isInteger(columns) || !Number.isInteger(rows)) {
      throw new VfsError("EINVAL", "resize dimensions must be whole numbers");
    }
    return { type: "resize", columns: columns as number, rows: rows as number };
  }
  throw new VfsError("EINVAL", "unsupported WebSocket message");
}
