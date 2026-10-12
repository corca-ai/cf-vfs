// src/core/errors.ts
var VFS_ERROR_CODES = [
  "EACCES",
  "EBADF",
  "EMFILE",
  "EAGAIN",
  "E2BIG",
  "EEXIST",
  "EFBIG",
  "EINVAL",
  "EIO",
  "EISDIR",
  "ENAMETOOLONG",
  "ENOTDIR",
  "ELOOP",
  "ENOTEMPTY",
  "ENOENT",
  "ENOEXEC",
  "ENOSPC",
  "ENOSYS",
  "ENOTSUP",
  "EPIPE",
  "EPERM",
  "ETIMEDOUT",
  "ECANCELED",
  "EREVISION"
];
var RECOGNIZED_CODES = new Set(VFS_ERROR_CODES);
var VfsError = class extends Error {
  code;
  path;
  constructor(code, message, path) {
    super(message);
    this.name = "VfsError";
    this.code = code;
    this.path = path;
  }
};
function isVfsError(error) {
  if (error instanceof VfsError) return true;
  if (!(error instanceof Error)) return false;
  try {
    if (error.name !== "VfsError") return false;
    const code = Reflect.get(error, "code");
    return typeof code === "string" && RECOGNIZED_CODES.has(code);
  } catch {
    return false;
  }
}

// src/vfs/handle-port.ts
var factory;
function installHandleFactory(value) {
  factory ??= value;
}
function createHandleProvider(port) {
  if (factory === void 0)
    throw new VfsError("ENOTSUP", "load the promise filesystem adapter to use handles");
  return factory(port);
}

// src/vfs/types.ts
var MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;
var MAX_SYMLINK_HOPS = 40;
var MAX_SYMLINK_TARGET_BYTES = 4096;
var NO_ENTRY_IDENTITY = 0;

// src/vfs/config.ts
var DIRECTORY_MODE = 16877;
var FILE_MODE = 33188;
var SYMLINK_MODE = 41471;
var DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1e3;
var DEFAULT_VERIFY_LEASE_MS = 6e4;
var DEFAULT_UPLOAD_SETTLEMENT_GRACE_MS = 6e4;
var DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_READ_LEASE_MS = 5 * 60 * 1e3;
var MAX_READ_LEASE_MS = 60 * 60 * 1e3;
var NEVER_MUTATED_TOKEN = "vfs:never-mutated";
var DEFAULT_CHUNK_BYTES = 256 * 1024;
var DEFAULT_MAX_INLINE_LOGICAL_BYTES = 512 * 1024 * 1024;
var DEFAULT_MAX_ENTRIES = 1e5;
var DEFAULT_MAX_IN_FLIGHT_BYTES = 32 * 1024 * 1024;
function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VfsError("EINVAL", `${name} must be a positive safe integer`);
  }
}
function resolveLimit(value, fallback, name) {
  if (typeof value === "function") {
    return () => {
      const resolved = value();
      validatePositiveInteger(resolved, name);
      return resolved;
    };
  }
  const fixed = value ?? fallback;
  validatePositiveInteger(fixed, name);
  return () => fixed;
}
function resolveFileSystemLimits(options) {
  const fixed = {
    chunkBytes: options.chunkBytes ?? DEFAULT_CHUNK_BYTES,
    maxInlineFileBytes: options.maxInlineFileBytes ?? MAX_INLINE_FILE_BYTES,
    maxInFlightBufferedBytes: options.maxInFlightBufferedBytes ?? DEFAULT_MAX_IN_FLIGHT_BYTES,
    uploadSettlementGraceMs: options.uploadSettlementGraceMs ?? DEFAULT_UPLOAD_SETTLEMENT_GRACE_MS,
    receiptRetentionMs: options.receiptRetentionMs ?? DEFAULT_RECEIPT_RETENTION_MS
  };
  for (const [name, value] of Object.entries(fixed)) validatePositiveInteger(value, name);
  if (fixed.maxInlineFileBytes > MAX_INLINE_FILE_BYTES) {
    throw new VfsError("EINVAL", `maxInlineFileBytes cannot exceed ${MAX_INLINE_FILE_BYTES}`);
  }
  return {
    ...fixed,
    maxInlineLogicalBytes: resolveLimit(
      options.maxInlineLogicalBytes,
      DEFAULT_MAX_INLINE_LOGICAL_BYTES,
      "maxInlineLogicalBytes"
    ),
    maxEntries: resolveLimit(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries")
  };
}

// src/vfs/events.ts
function emitVfsEvent(sink, event) {
  if (sink === void 0) return;
  try {
    sink(event);
  } catch {
  }
}

// src/vfs/sql-model.ts
function invalidColumn(column, expected) {
  throw new VfsError("EIO", `invalid SQLite row: ${column} must be ${expected}`);
}
function stringColumn(row, column) {
  const value = row[column];
  return typeof value === "string" ? value : invalidColumn(column, "text");
}
function nullableStringColumn(row, column) {
  const value = row[column];
  return value === null || typeof value === "string" ? value : invalidColumn(column, "text or null");
}
function integerColumn(row, column) {
  const value = row[column];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : invalidColumn(column, "a safe integer");
}
function nullableIntegerColumn(row, column) {
  const value = row[column];
  return value === null || typeof value === "number" && Number.isSafeInteger(value) ? value : invalidColumn(column, "a safe integer or null");
}
function invalidReceipt(path) {
  throw new VfsError("EIO", "invalid committed upload receipt", path);
}
function isReceiptRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function receiptRecord(value, path) {
  return isReceiptRecord(value) ? value : invalidReceipt(path);
}
function receiptString(receipt, field, path) {
  const value = receipt[field];
  return typeof value === "string" ? value : invalidReceipt(path);
}
function optionalReceiptString(receipt, field, path) {
  const value = receipt[field];
  if (value === void 0 || typeof value === "string") return value;
  return invalidReceipt(path);
}
function receiptInteger(receipt, field, minimum, path) {
  const value = receipt[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum ? value : invalidReceipt(path);
}
function parseOpaqueReceipt(value, path) {
  const receipt = receiptRecord(value, path);
  if (receipt["kind"] !== "file" || receipt["contentClass"] !== "opaque") {
    return invalidReceipt(path);
  }
  const contentType = optionalReceiptString(receipt, "contentType", path);
  const verifiedSha256 = optionalReceiptString(receipt, "verifiedSha256", path);
  return {
    kind: "file",
    contentClass: "opaque",
    path: receiptString(receipt, "path", path),
    parentPath: receiptString(receipt, "parentPath", path),
    name: receiptString(receipt, "name", path),
    ino: receiptInteger(receipt, "ino", 1, path),
    ...receipt["nlink"] === void 0 ? {} : { nlink: receiptInteger(receipt, "nlink", 0, path) },
    sizeBytes: receiptInteger(receipt, "sizeBytes", 0, path),
    mode: receiptInteger(receipt, "mode", 0, path),
    uid: receiptInteger(receipt, "uid", 0, path),
    gid: receiptInteger(receipt, "gid", 0, path),
    createdAtMs: receiptInteger(receipt, "createdAtMs", 0, path),
    modifiedAtMs: receiptInteger(receipt, "modifiedAtMs", 0, path),
    ...receipt["changedAtMs"] === void 0 ? {} : { changedAtMs: receiptInteger(receipt, "changedAtMs", 0, path) },
    revision: receiptInteger(receipt, "revision", 1, path),
    mutationToken: receiptString(receipt, "mutationToken", path),
    ...contentType === void 0 ? {} : { contentType },
    ...verifiedSha256 === void 0 ? {} : { verifiedSha256 }
  };
}
function blobColumn(row, column) {
  const value = row[column];
  return value instanceof ArrayBuffer ? value : invalidColumn(column, "a blob");
}
function firstRow(cursor) {
  return cursor.toArray()[0];
}
function formatMutationToken(epoch, version) {
  return `${epoch}:${version}`;
}
function parseEntry(row, mutationEpoch) {
  const kind = stringColumn(row, "kind");
  const contentClass = nullableStringColumn(row, "content_class");
  const opaqueObjectId = nullableIntegerColumn(row, "opaque_object_id");
  const linkTarget = nullableStringColumn(row, "link_target");
  const path = stringColumn(row, "path");
  if (kind !== "directory" && kind !== "file" && kind !== "symlink") {
    invalidColumn("kind", "directory, file, or symlink");
  }
  if (contentClass !== null && contentClass !== "inline" && contentClass !== "opaque") {
    invalidColumn("content_class", "inline, opaque, or null");
  }
  const mutationVersion = integerColumn(row, "mutation_version");
  const common = {
    id: integerColumn(row, "id"),
    path,
    parentPath: stringColumn(row, "parent_path"),
    name: stringColumn(row, "name"),
    sizeBytes: integerColumn(row, "size_bytes"),
    mode: integerColumn(row, "mode"),
    uid: integerColumn(row, "uid"),
    gid: integerColumn(row, "gid"),
    createdAtMs: integerColumn(row, "created_at_ms"),
    modifiedAtMs: integerColumn(row, "modified_at_ms"),
    changedAtMs: integerColumn(row, "changed_at_ms"),
    linkIdentity: nullableIntegerColumn(row, "link_identity"),
    linkCount: integerColumn(row, "link_count"),
    revision: integerColumn(row, "revision"),
    mutationVersion,
    mutationToken: formatMutationToken(mutationEpoch, mutationVersion)
  };
  if (kind === "directory" && contentClass === null && opaqueObjectId === null && linkTarget === null) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  if (kind === "symlink" && contentClass === null && opaqueObjectId === null && linkTarget !== null) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  if (kind === "file" && contentClass === "inline" && opaqueObjectId === null && linkTarget === null) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  if (kind === "file" && contentClass === "opaque" && opaqueObjectId !== null && linkTarget === null) {
    return { ...common, kind, contentClass, opaqueObjectId, linkTarget };
  }
  throw new VfsError("EIO", "invalid SQLite entry state", path);
}
function rowToStat(row) {
  const common = {
    path: row.path,
    parentPath: row.parentPath,
    name: row.name,
    // Already on the row every entry query reads, so reporting it costs no
    // column, no index, and no statement.
    ino: row.linkIdentity ?? row.id,
    nlink: row.linkCount ?? 1,
    sizeBytes: row.sizeBytes,
    mode: row.mode,
    uid: row.uid,
    gid: row.gid,
    createdAtMs: row.createdAtMs,
    modifiedAtMs: row.modifiedAtMs,
    changedAtMs: row.changedAtMs,
    revision: row.revision,
    mutationToken: row.mutationToken
  };
  if (row.kind === "directory") return { ...common, kind: "directory", contentClass: null };
  if (row.kind === "symlink") {
    return { ...common, kind: "symlink", contentClass: null, linkTarget: row.linkTarget };
  }
  if (row.contentClass === "inline") return { ...common, kind: "file", contentClass: "inline" };
  return { ...common, kind: "file", contentClass: "opaque" };
}
function parseOpaqueObject(row) {
  return {
    id: integerColumn(row, "id"),
    key: stringColumn(row, "r2_key"),
    sizeBytes: integerColumn(row, "size_bytes"),
    etag: stringColumn(row, "etag"),
    version: stringColumn(row, "r2_version"),
    verifiedSha256: nullableStringColumn(row, "verified_sha256"),
    contentType: nullableStringColumn(row, "content_type"),
    retainUntilMs: integerColumn(row, "retain_until_ms")
  };
}
function parseUpload(row) {
  const state = stringColumn(row, "state");
  if (state !== "open" && state !== "verifying" && state !== "committed" && state !== "garbage") {
    invalidColumn("state", "a valid upload state");
  }
  return {
    id: stringColumn(row, "id"),
    path: stringColumn(row, "path"),
    expectedMutationToken: stringColumn(row, "expected_mutation_token"),
    objectKey: stringColumn(row, "r2_key"),
    state,
    writtenPath: nullableStringColumn(row, "written_path"),
    traversalToken: nullableStringColumn(row, "traversal_token"),
    verificationToken: nullableStringColumn(row, "verification_token"),
    expectedSizeBytes: nullableIntegerColumn(row, "expected_size_bytes"),
    expiresAtMs: integerColumn(row, "expires_at_ms"),
    verificationLeaseUntilMs: nullableIntegerColumn(row, "verification_lease_until_ms"),
    createParents: integerColumn(row, "create_parents") === 1,
    mode: nullableIntegerColumn(row, "mode"),
    contentType: nullableStringColumn(row, "content_type"),
    receiptJson: nullableStringColumn(row, "receipt_json")
  };
}
function metadataFromObject(row) {
  return {
    key: row.key,
    sizeBytes: row.sizeBytes,
    etag: row.etag,
    version: row.version,
    ...row.contentType === null ? {} : { contentType: row.contentType },
    ...row.verifiedSha256 === null ? {} : { verifiedSha256: row.verifiedSha256 }
  };
}

// src/core/unicode.ts
var UTF8_ENCODER = new TextEncoder();
function encodeUtf8(value) {
  return UTF8_ENCODER.encode(value);
}
function utf8ByteLength(value) {
  if (value.length <= 128 && !/[\u0080-\u{10ffff}]/u.test(value)) return value.length;
  return encodeUtf8(value).byteLength;
}
function firstCodePoint(value) {
  return value.codePointAt(0) ?? 0;
}
function codePointLength(value) {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

// src/core/path.ts
var MAX_PATH_BYTES = 4096;
var MAX_NAME_BYTES = 255;
var DOT_COMPONENT = /(?:^|\/)\.\.?(?:\/|$)/u;
var NON_CANONICAL_ASCII = /\/\/|\/\.\.?(?:\/|$)|[^\x01-\x7f]/;
function compareUtf8(left, right) {
  if (left === right) return 0;
  if (!/[\ud800-\udfff]/.test(left) && !/[\ud800-\udfff]/.test(right)) return left < right ? -1 : 1;
  if (left.length <= 128 && right.length <= 128) return compareShortUtf8(left, right);
  const leftBytes = encodeUtf8(left);
  const rightBytes = encodeUtf8(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index];
    const rightByte = rightBytes[index];
    if (leftByte === void 0 || rightByte === void 0) break;
    if (leftByte !== rightByte) return leftByte - rightByte;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}
function utf8OrderPoint(point) {
  return point >= 55296 && point <= 57343 ? 65533 : point;
}
function compareShortUtf8(left, right) {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftPoint = left.codePointAt(leftOffset) ?? 0;
    const rightPoint = right.codePointAt(rightOffset) ?? 0;
    leftOffset += leftPoint > 65535 ? 2 : 1;
    rightOffset += rightPoint > 65535 ? 2 : 1;
    const order = utf8OrderPoint(leftPoint) - utf8OrderPoint(rightPoint);
    if (order !== 0) return order;
  }
  return (leftOffset < left.length ? 1 : 0) - (rightOffset < right.length ? 1 : 0);
}
function validatePath(path) {
  if (path.includes("\0")) {
    throw new VfsError("EINVAL", "paths cannot contain NUL bytes", path);
  }
  if (utf8ByteLength(path) > MAX_PATH_BYTES) {
    throw new VfsError("ENAMETOOLONG", `path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`, path);
  }
}
function normalizePath(path, cwd = "/") {
  if (typeof path !== "string" || path.length === 0) {
    throw new VfsError("EINVAL", "path must be a non-empty string");
  }
  if (path === "/") return path;
  if (path.length <= MAX_NAME_BYTES && path.startsWith("/") && !path.endsWith("/") && !NON_CANONICAL_ASCII.test(path))
    return path;
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  const segments = [];
  for (const segment of absolute.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    if (utf8ByteLength(segment) > MAX_NAME_BYTES) {
      throw new VfsError(
        "ENAMETOOLONG",
        `path segment exceeds ${MAX_NAME_BYTES} UTF-8 bytes`,
        path
      );
    }
    segments.push(segment);
  }
  const normalized = `/${segments.join("/")}`;
  validatePath(normalized);
  return normalized;
}
function hasDotSegments(path) {
  return (path.includes("/.") || path.startsWith(".")) && DOT_COMPONENT.test(path);
}
function normalizeResolutionPath(path, cwd = "/") {
  const normalized = normalizePath(path, cwd);
  const absolute = path.startsWith("/") ? path : `${cwd}/${path}`;
  if (!hasDotSegments(absolute)) return normalized;
  validatePath(absolute);
  return absolute;
}
function normalizeFileSystemPath(path, cwd = "/") {
  if (hasDotSegments(path) || !path.startsWith("/") && hasDotSegments(cwd))
    return normalizeResolutionPath(path, cwd);
  return normalizePathPreservingTrailingSlash(path, cwd);
}
function pathRequiresDirectory(path) {
  return path.length > 1 && path.endsWith("/");
}
function normalizePathPreservingTrailingSlash(path, cwd = "/") {
  const normalized = normalizePath(path, cwd);
  return normalized !== "/" && pathRequiresDirectory(path) ? `${normalized}/` : normalized;
}
function dirname(path) {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const separator = normalized.lastIndexOf("/");
  return separator === 0 ? "/" : normalized.slice(0, separator);
}
function basename(path) {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
function depthFrom(root, path) {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (normalizedRoot === normalizedPath) return 0;
  const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) {
    throw new VfsError("EINVAL", `${normalizedPath} is not below ${normalizedRoot}`);
  }
  return normalizedPath.slice(prefix.length).split("/").length;
}
function isDescendant(root, path) {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (normalizedRoot === "/") return normalizedPath !== "/";
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}
function descendantRange(root) {
  const normalized = normalizePath(root);
  if (normalized === "/") return { lower: "/", upper: "0" };
  return { lower: `${normalized}/`, upper: `${normalized}0` };
}

// src/vfs/sql-posix.ts
var MAX_POSIX_ID = 4294967295;
var DEFAULT_UMASK = 18;
var READ_PERMISSION = 4;
var WRITE_PERMISSION = 2;
var EXECUTE_PERMISSION = 1;
var SETGID_BIT = 1024;
var STICKY_BIT = 512;
function posixId(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POSIX_ID) {
    throw new VfsError("EINVAL", `${name} must be an integer between 0 and ${MAX_POSIX_ID}`);
  }
  return value;
}
function posixContext(credentials, options = {}) {
  const uid = posixId(credentials.uid, "credentials.uid");
  const gid = posixId(credentials.gid, "credentials.gid");
  const supplementaryGids = [...new Set(credentials.supplementaryGids ?? [])].map(
    (value) => posixId(value, "credentials.supplementaryGids")
  );
  const umask = options.umask ?? DEFAULT_UMASK;
  if (!Number.isSafeInteger(umask) || umask < 0 || umask > 511) {
    throw new VfsError("EINVAL", "umask must be an integer between 000 and 777");
  }
  return Object.freeze({
    credentials: Object.freeze({
      uid,
      gid,
      supplementaryGids: Object.freeze(supplementaryGids)
    }),
    groups: /* @__PURE__ */ new Set([gid, ...supplementaryGids]),
    umask
  });
}
function posixPermissions(entry, access) {
  if (access.credentials.uid === 0) return 7;
  if (entry.uid === access.credentials.uid) return entry.mode >> 6 & 7;
  if (access.groups.has(entry.gid)) return entry.mode >> 3 & 7;
  return entry.mode & 7;
}

// src/vfs/digest.ts
function contiguousBody(chunks, sizeBytes) {
  const first = chunks[0];
  if (first === void 0) return void 0;
  let end = first.byteOffset;
  for (const chunk of chunks) {
    if (chunk.buffer !== first.buffer || chunk.byteOffset !== end) return void 0;
    end += chunk.byteLength;
  }
  return end - first.byteOffset === sizeBytes ? new Uint8Array(first.buffer, first.byteOffset, sizeBytes) : void 0;
}
async function sha256Hex(chunks, sizeBytes) {
  let source;
  if (chunks.length === 1 && chunks[0] !== void 0) {
    source = chunks[0];
  } else {
    const contiguous = contiguousBody(chunks, sizeBytes);
    source = contiguous ?? new Uint8Array(sizeBytes);
    if (contiguous === void 0) {
      let offset = 0;
      for (const chunk of chunks) {
        source.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
  }
  const digestInput = source.buffer instanceof ArrayBuffer ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// src/vfs/range.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validRange(name, value) {
  const minimum = name === "offset" ? 0 : 1;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function validateByteRange(range, path) {
  if (range === void 0) return;
  if (!isRecord(range)) throw new VfsError("EINVAL", "byte range must be an object", path);
  for (const name of Object.getOwnPropertyNames(range)) {
    const known = ["offset", "length", "suffix"].includes(name);
    if (!known) throw new VfsError("EINVAL", `unknown byte range field: ${name}`, path);
    if (!validRange(name, range[name])) {
      const constraint = name === "offset" ? "a non-negative" : "a positive";
      throw new VfsError("EINVAL", `${name} must be ${constraint} integer`, path);
    }
  }
  const hasOffset = Object.hasOwn(range, "offset");
  const hasLength = Object.hasOwn(range, "length");
  const hasSuffix = Object.hasOwn(range, "suffix");
  if (!hasOffset && !hasLength && !hasSuffix) {
    throw new VfsError("EINVAL", "byte range must use offset/length or suffix", path);
  }
  if (hasSuffix && (hasOffset || hasLength)) {
    throw new VfsError("EINVAL", "byte range must use offset/length or suffix", path);
  }
}
function byteRangeBounds(range, sizeBytes, path) {
  validateByteRange(range, path);
  if (range === void 0) return { offset: 0, length: sizeBytes };
  const suffix = Object.hasOwn(range, "suffix") ? range.suffix : void 0;
  if (suffix !== void 0) {
    const length = Math.min(suffix, sizeBytes);
    return { offset: sizeBytes - length, length };
  }
  const offset = Math.min(Object.hasOwn(range, "offset") ? range.offset ?? 0 : 0, sizeBytes);
  return {
    offset,
    length: Math.min(
      Object.hasOwn(range, "length") ? range.length ?? sizeBytes - offset : sizeBytes - offset,
      sizeBytes - offset
    )
  };
}

// src/core/bracket.ts
function bracketRanges(elements) {
  const ranges = [];
  for (let offset = 0; offset < elements.length; offset += 1) {
    const start = elements[offset];
    if (start === void 0) continue;
    const separator = elements[offset + 1];
    const end = elements[offset + 2];
    if (separator?.value === "-" && !separator.escaped && end !== void 0) {
      const left = firstCodePoint(start.value);
      const right = firstCodePoint(end.value);
      if (left <= right) ranges.push([left, right]);
      offset += 2;
      continue;
    }
    const point = firstCodePoint(start.value);
    ranges.push([point, point]);
  }
  return ranges;
}
function parseBracketExpression(characters, open) {
  let index = open + 1;
  let negated = false;
  if ((characters[index] === "!" || characters[index] === "^") && characters[index] !== void 0) {
    negated = true;
    index += 1;
  }
  const elements = [];
  if (characters[index] === "]") {
    elements.push({ value: "]", escaped: false });
    index += 1;
  }
  while (index < characters.length) {
    const value = characters[index] ?? "";
    if (value === "]") {
      return elements.length === 0 ? void 0 : { close: index, negated, ranges: bracketRanges(elements) };
    }
    if (value === "\\" && characters[index + 1] !== void 0) {
      elements.push({ value: characters[index + 1] ?? "", escaped: true });
      index += 2;
      continue;
    }
    elements.push({ value, escaped: false });
    index += 1;
  }
  return void 0;
}

// src/core/glob.ts
function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}
function bracketRegex(expression) {
  if (expression.ranges.length === 0) return expression.negated ? "[^/]" : "(?!)";
  const body = expression.ranges.map(([start, end]) => {
    const left = `\\u{${start.toString(16)}}`;
    const right = `\\u{${end.toString(16)}}`;
    return start === end ? left : `${left}-${right}`;
  }).join("");
  return `(?=[^/])[${expression.negated ? "^" : ""}${body}]`;
}
function globParts(pattern) {
  if (pattern.length > 16384) throw new VfsError("E2BIG", "glob pattern length limit exceeded");
  const characters = [...pattern];
  const parts = [];
  let source = "";
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    switch (character) {
      case "\\":
        source += escapeRegex(characters[++index] ?? "\\");
        break;
      case "*":
        parts.push(source);
        source = "";
        break;
      case "?":
        source += "[^/]";
        break;
      case "[": {
        const expression = parseBracketExpression(characters, index);
        source += expression === void 0 ? "\\[" : bracketRegex(expression);
        if (expression !== void 0) index = expression.close;
        break;
      }
      default:
        source += escapeRegex(character);
    }
  }
  parts.push(source);
  return parts.filter((part, index) => index === 0 || part !== "" || index === parts.length - 1);
}
function globToRegExp(pattern) {
  const parts = globParts(pattern);
  let expression = `^${parts[0] ?? ""}`;
  for (let index = 1; index < parts.length; index += 1) {
    const fixed = parts[index] ?? "";
    expression += index === parts.length - 1 ? `[^/]*${fixed}` : `(?=(?<g${index}>[^/]*?${fixed}))\\k<g${index}>`;
  }
  return new RegExp(`${expression}$`, "u");
}
function matchesGlob(value, pattern) {
  return pattern === void 0 || globToRegExp(pattern).test(value);
}

// src/vfs/streams.ts
function validateChunkBytes(chunkBytes) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1)
    throw new VfsError("EINVAL", "chunkBytes must be a positive safe integer");
}
function validateMaximumBytes(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new VfsError("EINVAL", "maximumBytes must be a non-negative safe integer");
}
function rawBodyBytes(body) {
  if (typeof body === "string") return encodeUtf8(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}
function copyView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
}
function bodyToStream(body) {
  if (body instanceof ReadableStream) return body;
  const bytes2 = typeof body === "string" ? encodeUtf8(body) : copyView(body);
  return streamFromChunks(bytes2.byteLength === 0 ? [] : [bytes2]);
}
function streamFromChunks(chunks, onFinalize) {
  return chunkStream(chunks, (chunk) => chunk.slice(), onFinalize);
}
function streamFromOwnedChunks(chunks, onFinalize) {
  return chunkStream(chunks, (chunk) => chunk, onFinalize);
}
function chunkStream(chunks, take, onFinalize) {
  let index = 0;
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    onFinalize?.();
  };
  return new ReadableStream({
    type: "bytes",
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === void 0) {
        finalize();
        controller.close();
        return;
      }
      controller.enqueue(take(chunk));
    },
    cancel() {
      finalize();
    }
  });
}
async function collectBytes(body, maximumBytes, account) {
  validateMaximumBytes(maximumBytes);
  const reader = bodyToStream(body).getReader();
  const chunks = [];
  let sizeBytes = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const chunk = read.value.slice();
      sizeBytes += chunk.byteLength;
      account?.(chunk.byteLength);
      if (sizeBytes > maximumBytes) {
        throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
      }
      if (chunk.byteLength > 0) chunks.push(chunk);
    }
    return { chunks, sizeBytes };
  } catch (error) {
    await reader.cancel(error).catch(() => void 0);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
function collectMaterialized(body, materialized, maximumBytes, chunkBytes, account) {
  if (materialized.byteLength > chunkBytes && materialized.byteLength <= maximumBytes) {
    return void 0;
  }
  const sizeBytes = materialized.byteLength;
  account?.(sizeBytes);
  if (sizeBytes > maximumBytes) {
    throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
  }
  return {
    chunks: sizeBytes === 0 ? [] : [typeof body === "string" ? materialized : materialized.slice()],
    sizeBytes
  };
}
async function consumeByteStream(stream, append2) {
  const reader = stream.getReader();
  try {
    for (; ; ) {
      const read = await reader.read();
      if (read.done) return;
      append2(read.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => void 0);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
async function collectRechunkedBytes(body, maximumBytes, chunkBytes, account) {
  validateMaximumBytes(maximumBytes);
  validateChunkBytes(chunkBytes);
  const chunks = [];
  let sizeBytes = 0;
  let materialized;
  if (!(body instanceof ReadableStream)) {
    materialized = rawBodyBytes(body);
    const collected = collectMaterialized(body, materialized, maximumBytes, chunkBytes, account);
    if (collected !== void 0) return collected;
  }
  let current = new Uint8Array(chunkBytes);
  let used = 0;
  const append2 = (input) => {
    sizeBytes += input.byteLength;
    account?.(input.byteLength);
    if (sizeBytes > maximumBytes) {
      throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
    }
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(current.byteLength - used, input.byteLength - offset);
      current.set(input.subarray(offset, offset + copied), used);
      offset += copied;
      used += copied;
      if (used === current.byteLength) {
        chunks.push(current);
        current = new Uint8Array(chunkBytes);
        used = 0;
      }
    }
  };
  if (!(body instanceof ReadableStream)) {
    if (materialized === void 0) throw new TypeError("materialized body is missing");
    append2(materialized);
    if (used > 0) chunks.push(current.slice(0, used));
    return { chunks, sizeBytes };
  }
  await consumeByteStream(body, append2);
  if (used > 0) chunks.push(current.slice(0, used));
  return { chunks, sizeBytes };
}
function rechunk(chunks, chunkBytes) {
  validateChunkBytes(chunkBytes);
  const output = [];
  let current = new Uint8Array(chunkBytes);
  let used = 0;
  for (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const copied = Math.min(chunkBytes - used, chunk.byteLength - offset);
      current.set(chunk.subarray(offset, offset + copied), used);
      used += copied;
      offset += copied;
      if (used === chunkBytes) {
        output.push(current);
        current = new Uint8Array(chunkBytes);
        used = 0;
      }
    }
  }
  if (used > 0) output.push(current.slice(0, used));
  return output;
}
async function readAllBytes(stream, maximumBytes) {
  const collected = await collectBytes(stream, maximumBytes);
  const only = collected.chunks[0];
  if (only !== void 0 && collected.chunks.length === 1) return only;
  const output = new Uint8Array(collected.sizeBytes);
  let offset = 0;
  for (const chunk of collected.chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

// src/vfs/buffering.ts
function leasedChunks(chunks, sizeBytes, budget, accounted) {
  let released = false;
  return {
    chunks,
    sizeBytes,
    release: () => {
      if (released) return;
      released = true;
      budget.release(accounted);
    }
  };
}
var InFlightByteBudget = class {
  constructor(maximumBytes, onEvent) {
    this.maximumBytes = maximumBytes;
    this.onEvent = onEvent;
    validatePositiveInteger(maximumBytes, "maxInFlightBufferedBytes");
  }
  maximumBytes;
  onEvent;
  usedBytes = 0;
  get remainingBytes() {
    return this.maximumBytes - this.usedBytes;
  }
  /**
   * Reserves `bytes`, or refuses in a way the caller can act on.
   *
   * `heldByCaller` is what this same call already holds, and it is the whole
   * difference between the two refusals. A call whose own demand fits the
   * budget and is refused anyway lost a race with concurrent work -- a read
   * snapshot, another batch -- and would succeed once that work finishes, so
   * it gets `EAGAIN`. A call demanding more than the budget can ever hold gets
   * `ENOSPC`, because retrying it is work with no outcome: it has to ask for
   * less. Reporting both as `ENOSPC` leaves a caller unable to tell "try again"
   * from "split the batch", which matters most exactly where a call holds
   * several bodies at once.
   *
   * Nothing waits here. A queue would deadlock rather than delay: the capacity
   * a waiter needs is held by work that may itself be waiting on this object's
   * single thread.
   */
  acquire(bytes2, heldByCaller = 0) {
    if (this.usedBytes + bytes2 > this.maximumBytes) {
      emitVfsEvent(this.onEvent, {
        type: "vfs.quota",
        limit: "maxInFlightBufferedBytes",
        requested: bytes2,
        used: this.usedBytes,
        max: this.maximumBytes
      });
      throw heldByCaller + bytes2 > this.maximumBytes ? new VfsError("ENOSPC", "request exceeds the whole runtime in-flight byte budget") : new VfsError("EAGAIN", "runtime in-flight byte budget is temporarily exhausted");
    }
    this.usedBytes += bytes2;
  }
  release(bytes2) {
    this.usedBytes -= bytes2;
  }
};
async function collectInlineBytes(body, maximumBytes, chunkBytes, budget, heldByCaller = 0) {
  let accounted = 0;
  try {
    const collected = await collectRechunkedBytes(body, maximumBytes, chunkBytes, (delta) => {
      budget.acquire(delta, heldByCaller + accounted);
      accounted += delta;
    });
    return leasedChunks(collected.chunks, collected.sizeBytes, budget, accounted);
  } catch (error) {
    budget.release(accounted);
    throw error;
  }
}
function collectInlineBytesSync(body, maximumBytes, chunkBytes, budget, heldByCaller = 0) {
  validatePositiveInteger(chunkBytes, "chunkBytes");
  const input = encodeUtf8(body);
  const sizeBytes = input.byteLength;
  budget.acquire(sizeBytes, heldByCaller);
  if (sizeBytes > maximumBytes) {
    budget.release(sizeBytes);
    throw new VfsError("EFBIG", `stream exceeds the ${maximumBytes}-byte limit`);
  }
  const chunks = [];
  for (let offset = 0; offset < sizeBytes; offset += chunkBytes) {
    chunks.push(input.subarray(offset, offset + chunkBytes));
  }
  return leasedChunks(chunks, sizeBytes, budget, sizeBytes);
}

// src/vfs/sql-schema.ts
var ENTRIES_SCHEMA = `
        CREATE TABLE vfs_entries (
          -- Assigned from vfs_usage.next_ino rather than left to SQLite,
          -- because this number is published as ino and a caller may key
          -- durable state to it. A bare rowid is max(rowid) + 1, so deleting
          -- the newest entry frees its number for the next one, and a recycled
          -- identity is worse than none: an absent one is known to be
          -- unusable while a recycled one looks correct. POSIX permits reuse;
          -- nothing requires it, so never reusing is a strengthening.
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL,
          parent_path TEXT NOT NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('directory', 'file', 'symlink')),
          content_class TEXT CHECK (content_class IN ('inline', 'opaque')),
          opaque_object_id INTEGER,
          link_target TEXT,
          size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
          mode INTEGER NOT NULL,
          uid INTEGER NOT NULL CHECK (uid >= 0 AND uid <= 4294967295),
          gid INTEGER NOT NULL CHECK (gid >= 0 AND gid <= 4294967295),
          created_at_ms INTEGER NOT NULL,
          modified_at_ms INTEGER NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          CHECK (
            (kind = 'directory' AND content_class IS NULL AND opaque_object_id IS NULL
              AND link_target IS NULL)
            OR (kind = 'file' AND content_class = 'inline' AND opaque_object_id IS NULL
              AND link_target IS NULL)
            OR (kind = 'file' AND content_class = 'opaque' AND opaque_object_id IS NOT NULL
              AND link_target IS NULL)
            OR (kind = 'symlink' AND content_class IS NULL AND opaque_object_id IS NULL
              AND link_target IS NOT NULL AND length(link_target) > 0)
          )
        );
        CREATE UNIQUE INDEX vfs_entries_path
          ON vfs_entries(path);
        CREATE UNIQUE INDEX vfs_entries_parent_name
          ON vfs_entries(parent_path, name);
        CREATE INDEX vfs_entries_opaque_object
          ON vfs_entries(opaque_object_id) WHERE opaque_object_id IS NOT NULL;
        -- Resolution asks only for links, and only ever by path. A partial
        -- index keeps that query proportional to the number of links rather
        -- than to the size of the namespace.
        CREATE INDEX vfs_entries_symlink
          ON vfs_entries(path) WHERE kind = 'symlink';`;
var ENTRY_TRIGGERS = `
        CREATE TRIGGER vfs_opaque_entry_insert_guard
          BEFORE INSERT ON vfs_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER vfs_opaque_entry_update_guard
          BEFORE UPDATE OF content_class, opaque_object_id ON vfs_entries
          WHEN NEW.content_class = 'opaque' AND NOT EXISTS (
            SELECT 1 FROM vfs_opaque_objects WHERE id = NEW.opaque_object_id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object does not exist'); END;
        CREATE TRIGGER vfs_inline_entry_delete_guard
          BEFORE DELETE ON vfs_entries
          WHEN EXISTS (
            SELECT 1 FROM vfs_inline_chunks WHERE entry_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;
        CREATE TRIGGER vfs_inline_entry_update_guard
          BEFORE UPDATE OF content_class ON vfs_entries
          WHEN OLD.content_class = 'inline' AND NEW.content_class <> 'inline'
            AND EXISTS (
              SELECT 1 FROM vfs_inline_chunks WHERE entry_id = OLD.id
            )
          BEGIN SELECT RAISE(ABORT, 'inline entry still has chunks'); END;
        CREATE TRIGGER vfs_opaque_object_delete_guard
          BEFORE DELETE ON vfs_opaque_objects
          WHEN EXISTS (
            SELECT 1 FROM vfs_entries WHERE opaque_object_id = OLD.id
          )
          BEGIN SELECT RAISE(ABORT, 'opaque object is still referenced'); END;
        CREATE TRIGGER vfs_inline_chunk_insert_guard
          BEFORE INSERT ON vfs_inline_chunks
          WHEN NOT EXISTS (
            SELECT 1 FROM vfs_entries
            WHERE id = NEW.entry_id AND content_class = 'inline'
          )
          BEGIN SELECT RAISE(ABORT, 'inline chunk has no inline entry'); END;`;
var DROP_ENTRY_TRIGGERS = `
        DROP TRIGGER IF EXISTS vfs_opaque_entry_insert_guard;
        DROP TRIGGER IF EXISTS vfs_opaque_entry_update_guard;
        DROP TRIGGER IF EXISTS vfs_inline_entry_delete_guard;
        DROP TRIGGER IF EXISTS vfs_inline_entry_update_guard;
        DROP TRIGGER IF EXISTS vfs_opaque_object_delete_guard;
        DROP TRIGGER IF EXISTS vfs_inline_chunk_insert_guard;`;
var fields = "id,path,parent_path,name,kind,content_class,opaque_object_id,link_target,size_bytes,mode,uid,gid,created_at_ms,link_identity,link_count,modified_at_ms,changed_at_ms,revision,mutation_version".split(",").map(
  (key) => [
    key,
    key === "changed_at_ms" ? "COALESCE(e.changed_at_ms, e.modified_at_ms)" : `e.${key}`
  ]
);
var ENTRY_COLUMNS = fields.map(([key, sql]) => `${sql} AS ${key}`).join(",");
var ENTRY_JSON = `json_object(${fields.map(([key, sql]) => `'${key}',${sql}`).join(",")})`;

// src/vfs/sql-migrate.ts
function migrateSql(context) {
  let migrated = false;
  const mutationEpoch = context.transaction(
    () => migrateTransaction(context, () => {
      migrated = true;
    })
  );
  if (migrated) context.sql.exec("PRAGMA optimize");
  return mutationEpoch;
}
function migrateTransaction(context, markMigrated) {
  context.sql.exec(`
      CREATE TABLE IF NOT EXISTS vfs_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
    `);
  const currentVersion = integerColumn(
    context.sql.exec("SELECT COALESCE(MAX(version), 0) AS version FROM vfs_schema_migrations").one(),
    "version"
  );
  const now = context.now();
  if (currentVersion < 1) {
    context.execBatch(`
      CREATE TABLE vfs_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        mutation_epoch TEXT NOT NULL
      );
      CREATE TABLE vfs_path_versions (
        path TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      ) WITHOUT ROWID;
      CREATE TABLE vfs_opaque_objects (
        id INTEGER PRIMARY KEY,
        r2_key TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        etag TEXT NOT NULL,
        r2_version TEXT NOT NULL,
        verified_sha256 TEXT,
        content_type TEXT,
        retain_until_ms INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL
      );
${ENTRIES_SCHEMA}
      CREATE TABLE vfs_inline_chunks (
        entry_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        body BLOB NOT NULL,
        PRIMARY KEY (entry_id, chunk_index)
      ) WITHOUT ROWID;
      CREATE TABLE vfs_upload_sessions (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        expected_mutation_token TEXT NOT NULL,
        r2_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('open', 'verifying', 'committed', 'garbage')),
        verification_token TEXT,
        expected_size_bytes INTEGER,
        expires_at_ms INTEGER NOT NULL,
        verification_lease_until_ms INTEGER,
        create_parents INTEGER NOT NULL CHECK (create_parents IN (0, 1)),
        mode INTEGER,
        content_type TEXT,
        receipt_json TEXT
      ) WITHOUT ROWID;
      CREATE INDEX vfs_upload_expiry
        ON vfs_upload_sessions(state, expires_at_ms);
      CREATE TABLE vfs_gc_queue (
        r2_key TEXT PRIMARY KEY,
        not_before_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL,
        last_error TEXT
      ) WITHOUT ROWID;
      CREATE INDEX vfs_gc_due
        ON vfs_gc_queue(next_attempt_at_ms, not_before_ms);
      CREATE TABLE vfs_usage (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        inline_bytes INTEGER NOT NULL CHECK (inline_bytes >= 0),
        entries INTEGER NOT NULL CHECK (entries >= 1)
      );
${ENTRY_TRIGGERS}
      `);
    const now2 = context.now();
    context.sql.exec(
      `INSERT INTO vfs_state (singleton, mutation_epoch)
         VALUES (1, ?)`,
      context.newToken()
    );
    context.sql.exec("INSERT INTO vfs_path_versions (path, version) VALUES ('/', 1)");
    context.sql.exec(
      `INSERT INTO vfs_entries (
           path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
         ) VALUES ('/', '/', '/', 'directory', NULL, NULL, 0, ?, 0, 0, 0, 0, 1)`,
      DIRECTORY_MODE
    );
    context.sql.exec("INSERT INTO vfs_usage (singleton, inline_bytes, entries) VALUES (1, 0, 1)");
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (1, ?)",
      now2
    );
    markMigrated();
  }
  if (currentVersion < 2) {
    if (currentVersion === 1) {
      context.execBatch(`
${DROP_ENTRY_TRIGGERS}
      ALTER TABLE vfs_entries RENAME TO vfs_entries_v1;
      DROP INDEX vfs_entries_path;
      DROP INDEX vfs_entries_parent_name;
      DROP INDEX vfs_entries_opaque_object;
${ENTRIES_SCHEMA}
      INSERT INTO vfs_entries (
        id, path, parent_path, name, kind, content_class, opaque_object_id,
        link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision
      )
      SELECT
        id, path, parent_path, name, kind, content_class, opaque_object_id,
        NULL, size_bytes, mode, 0, 0, created_at_ms, modified_at_ms, revision
      FROM vfs_entries_v1;
      DROP TABLE vfs_entries_v1;
${ENTRY_TRIGGERS}
    `);
    }
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (2, ?)",
      now
    );
    markMigrated();
  }
  if (currentVersion < 3) {
    if (currentVersion === 2) {
      context.execBatch(`
      ALTER TABLE vfs_entries
        ADD COLUMN uid INTEGER NOT NULL DEFAULT 0
        CHECK (uid >= 0 AND uid <= 4294967295);
      ALTER TABLE vfs_entries
        ADD COLUMN gid INTEGER NOT NULL DEFAULT 0
        CHECK (gid >= 0 AND gid <= 4294967295);
    `);
    }
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (3, ?)",
      now
    );
    markMigrated();
  }
  if (currentVersion < 4) {
    context.execBatch(`
      ALTER TABLE vfs_path_versions
        ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX vfs_path_changes
        ON vfs_path_versions(change_seq) WHERE change_seq > 0;
    `);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (4, ?)",
      now
    );
    markMigrated();
  }
  if (currentVersion < 5) {
    context.execBatch(`
      ALTER TABLE vfs_usage
        ADD COLUMN next_ino INTEGER NOT NULL DEFAULT 1;
    `);
    context.sql.exec(
      `UPDATE vfs_usage
           SET next_ino = (SELECT COALESCE(MAX(id), 0) + 1 FROM vfs_entries)
         WHERE singleton = 1`
    );
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (5, ?)",
      now
    );
    markMigrated();
  }
  if (currentVersion < 6) {
    context.execBatch(`
      ALTER TABLE vfs_entries ADD COLUMN body_digest TEXT;
      ALTER TABLE vfs_entries ADD COLUMN body_digest_revision INTEGER;
    `);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (6, ?)",
      now
    );
    markMigrated();
  }
  if (currentVersion < 7) {
    context.execBatch(`
      ALTER TABLE vfs_entries
        ADD COLUMN mutation_version INTEGER NOT NULL DEFAULT 1
        CHECK (mutation_version >= 1);
      UPDATE vfs_entries
         SET mutation_version = (
           SELECT version FROM vfs_path_versions WHERE path = vfs_entries.path
         );
      DROP INDEX vfs_path_changes;
      CREATE TABLE vfs_path_tombstones (
        path TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 1)
      ) WITHOUT ROWID;
      INSERT INTO vfs_path_tombstones (path, version)
      SELECT versions.path, versions.version
        FROM vfs_path_versions versions
       WHERE NOT EXISTS (
         SELECT 1 FROM vfs_entries entries WHERE entries.path = versions.path
       );
      CREATE TABLE vfs_path_changes (
        path TEXT PRIMARY KEY,
        change_seq INTEGER NOT NULL CHECK (change_seq >= 1),
        present INTEGER NOT NULL CHECK (present IN (0, 1))
      ) WITHOUT ROWID;
      INSERT INTO vfs_path_changes (path, change_seq, present)
      SELECT versions.path, versions.change_seq,
             EXISTS (SELECT 1 FROM vfs_entries entries WHERE entries.path = versions.path)
        FROM vfs_path_versions versions
       WHERE versions.change_seq > 0;
      CREATE INDEX vfs_path_changes_sequence
        ON vfs_path_changes(change_seq, path);
      DROP TABLE vfs_path_versions;
    `);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (7, ?)",
      now
    );
    markMigrated();
  }
  migrateMaintenance(context, currentVersion, now, markMigrated);
  migrateInodeStorage(context, currentVersion, now, markMigrated);
  return stringColumn(
    context.sql.exec("SELECT mutation_epoch FROM vfs_state WHERE singleton = 1").one(),
    "mutation_epoch"
  );
}
function migrateMaintenanceIndexes(context, now) {
  context.execBatch(`
      CREATE INDEX vfs_gc_earliest
        ON vfs_gc_queue(MAX(not_before_ms, next_attempt_at_ms));
      CREATE INDEX vfs_upload_verification_expiry
        ON vfs_upload_sessions(verification_lease_until_ms) WHERE state = 'verifying';
    `);
  context.sql.exec("INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (8, ?)", now);
}
function migrateInodeStorage(context, currentVersion, now, markMigrated) {
  if (currentVersion < 9) {
    context.execBatch(`ALTER TABLE vfs_entries ADD COLUMN changed_at_ms INTEGER;
      ALTER TABLE vfs_upload_sessions ADD COLUMN written_path TEXT;
      ALTER TABLE vfs_upload_sessions ADD COLUMN traversal_token TEXT;
      CREATE TABLE vfs_detached_inodes (
        id INTEGER PRIMARY KEY, entry_json TEXT NOT NULL,
        inline_bytes INTEGER NOT NULL CHECK(inline_bytes >= 0), opaque_object_id INTEGER
      );
      CREATE INDEX vfs_detached_opaque ON vfs_detached_inodes(opaque_object_id) WHERE opaque_object_id IS NOT NULL;
      CREATE TABLE vfs_detached_chunks (
        entry_id INTEGER NOT NULL, chunk_index INTEGER NOT NULL, body BLOB NOT NULL,
        PRIMARY KEY(entry_id, chunk_index)
      ) WITHOUT ROWID;
      CREATE TRIGGER vfs_detached_object_guard BEFORE DELETE ON vfs_opaque_objects
      WHEN EXISTS (SELECT 1 FROM vfs_detached_inodes WHERE opaque_object_id = OLD.id)
      BEGIN SELECT RAISE(ABORT, 'opaque object has an open inode'); END;
    `);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (9, ?)",
      now
    );
    markMigrated();
  }
  if (currentVersion < 10) {
    context.execBatch(`ALTER TABLE vfs_entries ADD COLUMN link_identity INTEGER;
      ALTER TABLE vfs_entries ADD COLUMN link_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE vfs_entries ADD COLUMN unlinking INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE vfs_entries ADD COLUMN mirroring INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX vfs_entries_link_identity ON vfs_entries(link_identity) WHERE link_identity IS NOT NULL;
      CREATE INDEX vfs_entries_child_directories ON vfs_entries(parent_path) WHERE kind = 'directory' AND path <> '/';
      UPDATE vfs_entries SET link_count = 2 + (SELECT COUNT(*) FROM vfs_entries child WHERE child.parent_path = vfs_entries.path AND child.kind = 'directory' AND child.path <> '/') WHERE kind = 'directory';`);
    context.sql.exec(
      "INSERT INTO vfs_schema_migrations (version, applied_at_ms) VALUES (10, ?)",
      now
    );
    markMigrated();
  }
}
function migrateMaintenance(context, version, now, mark) {
  if (version >= 8) return;
  migrateMaintenanceIndexes(context, now);
  mark();
}

// src/vfs/traversal.ts
function canonicalAncestors(path) {
  if (path === "/") return [];
  const parents = [];
  let slash = path.lastIndexOf("/");
  while (slash > 0) {
    parents.push(path.slice(0, slash));
    slash = path.lastIndexOf("/", slash - 1);
  }
  parents.push("/");
  return parents;
}
function traversalAncestors(path, followed) {
  if (followed.length === 0) return canonicalAncestors(path);
  const ancestors = /* @__PURE__ */ new Set();
  for (const candidate of [path, ...followed]) {
    const first = candidate.endsWith("/") ? normalizePath(candidate) : dirname(candidate);
    for (let parent = first; ; parent = dirname(parent)) {
      ancestors.add(parent);
      if (parent === "/") break;
    }
  }
  return [...ancestors];
}

// src/vfs/sql-base.ts
var TRAVERSAL_STATES = /* @__PURE__ */ new WeakMap();
function traversalState(sql) {
  let state = TRAVERSAL_STATES.get(sql);
  if (state === void 0) {
    state = { generation: 0, depth: 0, stableTraversalDepth: 0 };
    TRAVERSAL_STATES.set(sql, state);
  }
  return state;
}
var DEFAULT_MAX_DATABASE_BYTES = 1e10;
var DEFAULT_DATABASE_HEADROOM_BYTES = 64 * 1024 * 1024;
var SqlBase = class {
  recoveredDetached = false;
  storage;
  sql;
  chunkBytes;
  maxInlineFileBytes;
  maxInlineLogicalBytes;
  maxEntries;
  inFlightBytes;
  maxDatabaseBytes;
  minDatabaseHeadroomBytes;
  uploadSettlementGraceMs;
  receiptRetentionMs;
  opaqueStore;
  clock;
  createId;
  workspaceId;
  onEvent;
  mutationEpoch;
  /** Non-zero while a transaction body is on the stack. */
  transactionDepth = 0;
  traversalParents;
  traversalState;
  traversalGeneration = -1;
  /**
   * `vfs_usage` as the running transaction has it.
   *
   * The row is a singleton that only this transaction can be changing, and a
   * transaction body never yields, so reading it once and applying each delta
   * in memory answers exactly what re-reading would — for the capacity checks
   * a single write makes twice, and for the total an observer is handed.
   */
  transactionUsage;
  /** Set inside a transaction, reported once the commit is durable. */
  pendingUsage;
  /**
   * Namespace changes this transaction has made, held until it commits.
   *
   * Only ever appended to when a sink is attached, so an unobserved workspace
   * allocates nothing rather than building events it will discard.
   */
  pendingMutations = [];
  pendingParents;
  /** Only directory namespace changes can alter a parent's nlink. */
  directoryParentsChanged = false;
  /** Exact single-directory changes; subtree and wide parent sets still recount. */
  directoryParentDeltas;
  sharedInodes = false;
  retainOpenInodes;
  noteDirectoryChange(entry) {
    if (entry.kind === "directory") this.directoryParentsChanged = true;
  }
  noteDirectoryDelta(parent, delta) {
    this.directoryParentDeltas ??= /* @__PURE__ */ new Map();
    this.directoryParentDeltas.set(parent, (this.directoryParentDeltas.get(parent) ?? 0) + delta);
  }
  flushParentTimes() {
    const deltas = this.directoryParentDeltas;
    this.directoryParentDeltas = void 0;
    const parents = this.pendingParents;
    this.pendingParents = void 0;
    if (parents === void 0) return;
    const recount = this.directoryParentsChanged;
    this.directoryParentsChanged = false;
    const now = this.now();
    const paths = [...parents];
    const direct = paths.length <= 2;
    const predicate = direct ? `path IN (${paths.map(() => "?").join(",")})` : "path IN (SELECT value FROM json_each(?))";
    const bindings = direct ? paths : [JSON.stringify(paths)];
    const linkCount = this.parentLinkCount(recount, deltas);
    const observed = this.onEvent !== void 0 || this.recordChanges;
    const rows = this.sql.exec(
      `UPDATE vfs_entries INDEXED BY vfs_entries_path SET modified_at_ms = ?, changed_at_ms = ?,
      revision = revision + 1, mutation_version = mutation_version + 1,
      link_count = ${linkCount.sql}
      WHERE ${predicate} AND kind = 'directory'
      ${observed ? "RETURNING path, mutation_version" : ""}`,
      now,
      now,
      ...linkCount.bindings,
      ...bindings
    ).toArray();
    for (const row of rows)
      this.publishToken(
        stringColumn(row, "path"),
        integerColumn(row, "mutation_version"),
        true,
        "metadata",
        null
      );
  }
  parentLinkCount(recount, deltas) {
    if (recount || (deltas?.size ?? 0) > 2)
      return {
        sql: "2 + (SELECT COUNT(*) FROM vfs_entries child INDEXED BY vfs_entries_child_directories WHERE child.parent_path = vfs_entries.path AND child.kind = 'directory' AND child.path <> '/')",
        bindings: []
      };
    if (deltas === void 0 || deltas.size === 0) return { sql: "link_count", bindings: [] };
    const entries = [...deltas];
    return {
      sql: `link_count + CASE path ${entries.map(() => "WHEN ? THEN ?").join(" ")} ELSE 0 END`,
      bindings: entries.flat()
    };
  }
  /**
   * How many links exist, so a namespace without any pays nothing for them.
   *
   * Resolution consults this before doing any extra work: at zero it is exactly
   * the single indexed lookup the filesystem made before links existed, which
   * is what keeps the common case from slowing down. The Durable Object owns
   * its database outright and runs single-threaded, so a cached count cannot go
   * stale behind another writer.
   */
  symlinkCount;
  /**
   * Set when a delete or a copy may have changed the link count.
   *
   * The count is only ever consulted to answer "are there any links?", so
   * over-counting merely does correct work that turns out to be unnecessary,
   * while under-counting to zero would skip resolution entirely. Recomputing on
   * demand keeps that impossible, and a namespace with no links never reaches
   * the recompute at all.
   */
  symlinkCountStale = false;
  recordChanges;
  /**
   * The last sequence handed out, read from SQLite once and then kept here.
   *
   * The Durable Object owns its database outright and runs single-threaded, so
   * an in-memory counter cannot race another writer, and reading the maximum
   * again on the next start is what makes it monotonic across eviction. Keeping
   * it here rather than in a row is what makes the feature cost no statement
   * per mutation: a counter row would be a second write on every change.
   *
   * A rolled-back transaction leaves its number unused. A gap is harmless
   * because a caller only ever compares against a sequence it was given.
   */
  lastChangeSeq;
  /** The next entry identity, read once per instance from `vfs_usage`. */
  nextIno;
  /** Metadata from the last direct inline read; never file-body bytes. */
  lastInlineRead;
  /** Stored layout from the last ranged body; keyed by immutable identity and revision. */
  lastInlineChunkLayout;
  constructor(storage, options = {}) {
    const limits = resolveFileSystemLimits(options);
    this.storage = storage;
    this.sql = storage.sql;
    this.traversalState = traversalState(this.sql);
    this.chunkBytes = limits.chunkBytes;
    this.maxInlineFileBytes = limits.maxInlineFileBytes;
    this.maxInlineLogicalBytes = limits.maxInlineLogicalBytes;
    this.maxEntries = limits.maxEntries;
    this.onEvent = options.onEvent;
    this.inFlightBytes = new InFlightByteBudget(limits.maxInFlightBufferedBytes, options.onEvent);
    this.maxDatabaseBytes = options.maxDatabaseBytes ?? DEFAULT_MAX_DATABASE_BYTES;
    this.minDatabaseHeadroomBytes = options.minDatabaseHeadroomBytes ?? DEFAULT_DATABASE_HEADROOM_BYTES;
    this.uploadSettlementGraceMs = limits.uploadSettlementGraceMs;
    this.receiptRetentionMs = limits.receiptRetentionMs;
    this.opaqueStore = options.opaqueStore;
    this.clock = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.workspaceId = options.workspaceId ?? "workspace";
    this.recordChanges = options.recordChanges ?? false;
    for (const [name, value] of [
      ["maxDatabaseBytes", this.maxDatabaseBytes],
      ["minDatabaseHeadroomBytes", this.minDatabaseHeadroomBytes]
    ])
      validatePositiveInteger(value, name);
    this.mutationEpoch = migrateSql({
      sql: this.sql,
      transaction: (callback) => this.transaction(callback),
      execBatch: (query) => this.execBatch(query),
      now: () => this.now(),
      newToken: () => this.newToken()
    });
    const detached = this.sql.exec(
      "SELECT COUNT(*) AS count, COALESCE(SUM(inline_bytes), 0) AS bytes, EXISTS(SELECT 1 FROM vfs_entries WHERE link_identity IS NOT NULL) AS shared FROM vfs_detached_inodes"
    ).one();
    this.sharedInodes = integerColumn(detached, "shared") !== 0;
    if (integerColumn(detached, "count") !== 0) {
      this.recoveredDetached = true;
      this.transaction(() => {
        const now = this.now();
        this.sql.exec(
          `INSERT INTO vfs_gc_queue(r2_key, not_before_ms, next_attempt_at_ms)
        SELECT r2_key, MAX(?, retain_until_ms), MAX(?, retain_until_ms) FROM vfs_opaque_objects o
        WHERE EXISTS (SELECT 1 FROM vfs_detached_inodes d WHERE d.opaque_object_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM vfs_entries e WHERE e.opaque_object_id = o.id)
        ON CONFLICT(r2_key) DO NOTHING`,
          now,
          now
        );
        this.sql.exec("DELETE FROM vfs_detached_chunks");
        this.sql.exec("DELETE FROM vfs_detached_inodes");
        this.sql.exec(
          "UPDATE vfs_usage SET inline_bytes = inline_bytes - ? WHERE singleton = 1",
          integerColumn(detached, "bytes")
        );
        this.sql.exec(`DELETE FROM vfs_opaque_objects WHERE NOT EXISTS (SELECT 1 FROM vfs_entries e WHERE e.opaque_object_id = vfs_opaque_objects.id)
        AND EXISTS (SELECT 1 FROM vfs_gc_queue q WHERE q.r2_key = vfs_opaque_objects.r2_key)`);
      });
    }
    this.symlinkCount = this.countSymlinks();
    this.nextIno = integerColumn(
      this.sql.exec("SELECT next_ino FROM vfs_usage WHERE singleton = 1").one(),
      "next_ino"
    );
  }
  countSymlinks() {
    return integerColumn(
      this.sql.exec("SELECT COUNT(*) AS links FROM vfs_entries WHERE kind = 'symlink'").one(),
      "links"
    );
  }
  /** How many links exist, recomputed only when a mutation may have changed it. */
  links() {
    if (this.symlinkCountStale) {
      this.symlinkCount = this.countSymlinks();
      this.symlinkCountStale = false;
    }
    return this.symlinkCount;
  }
  now() {
    return this.clock();
  }
  assertPermission(entry, access, required, path = entry.path) {
    if (access === void 0 || required === 0) return;
    if (access.credentials.uid === 0 && !(required === EXECUTE_PERMISSION && entry.kind === "file" && (entry.mode & 73) === 0))
      return;
    if ((posixPermissions(entry, access) & required) !== required) {
      throw new VfsError("EACCES", "permission denied", path);
    }
  }
  assertOwner(entry, access, path = entry.path) {
    if (access !== void 0 && access.credentials.uid !== 0 && access.credentials.uid !== entry.uid) {
      throw new VfsError("EPERM", "operation requires the file owner", path);
    }
  }
  assertStickyRemoval(parent, target, access, path = target.path) {
    if (access === void 0 || access.credentials.uid === 0 || (parent.mode & STICKY_BIT) === 0 || access.credentials.uid === parent.uid || access.credentials.uid === target.uid)
      return;
    throw new VfsError("EPERM", "sticky directory denies removing this entry", path);
  }
  /**
   * Checks execute permission on every directory used to reach a canonical
   * path, plus the written-side ancestors of each followed link.
   *
   * All ancestors are fetched by one indexed `IN` query. Depth therefore adds
   * rows, not statements, and the no-credentials path never calls this helper.
   */
  assertTraverse(path, followed, access) {
    if (access === void 0) return;
    const ordered = traversalAncestors(path, followed);
    if (ordered.length === 0) return;
    if (this.cachedTraversalParents(ordered, path, access)) return;
    const rows = this.sql.exec(
      `SELECT path, kind, mode, uid, gid
         FROM vfs_entries INDEXED BY vfs_entries_path
         WHERE path IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ordered)
    ).toArray();
    if (rows.length !== ordered.length) {
      throw new VfsError("ENOENT", "an ancestor directory does not exist", path);
    }
    for (const row of rows) {
      const kind = stringColumn(row, "kind");
      const parent = stringColumn(row, "path");
      if (kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent);
      const directory = {
        path: parent,
        kind: "directory",
        mode: integerColumn(row, "mode"),
        uid: integerColumn(row, "uid"),
        gid: integerColumn(row, "gid")
      };
      this.assertPermission(directory, access, EXECUTE_PERMISSION, path);
      this.rememberTraversalParent(directory);
    }
  }
  /** Cache metadata, never a principal's authorization decision. */
  rememberTraversalParent({ path, kind, mode, uid, gid }) {
    if (!this.refreshTraversalParents()) return;
    this.traversalParents ??= /* @__PURE__ */ new Map();
    if (this.traversalParents.size >= 256 && !this.traversalParents.has(path))
      this.traversalParents.clear();
    this.traversalParents.set(path, { path, kind, mode, uid, gid });
  }
  tryCachedTraversal(path, followed, access) {
    if (!this.refreshTraversalParents() || this.traversalParents === void 0) return false;
    return this.cachedTraversalParents(traversalAncestors(path, followed), path, access);
  }
  cachedTraversalParents(ordered, path, access) {
    if (!this.refreshTraversalParents() || this.traversalParents === void 0) return false;
    const parents = [];
    for (const ancestor of ordered) {
      const parent = this.traversalParents.get(ancestor);
      if (parent === void 0) return false;
      parents.push(parent);
    }
    for (const parent of parents) this.assertPermission(parent, access, EXECUTE_PERMISSION, path);
    return true;
  }
  refreshTraversalParents() {
    if (this.traversalState.depth !== this.traversalState.stableTraversalDepth) return false;
    if (this.traversalGeneration !== this.traversalState.generation) {
      this.traversalParents?.clear();
      this.traversalGeneration = this.traversalState.generation;
    }
    return true;
  }
  creationMode(mode, access, parent, directory, intermediate = false) {
    if (access === void 0) return mode;
    let permissions = mode & 4095 & ~access.umask;
    if (directory && intermediate) permissions |= 192;
    if (directory && (parent.mode & SETGID_BIT) !== 0) permissions |= SETGID_BIT;
    const type = directory ? 16384 : 32768;
    return type | permissions;
  }
  creationOwner(parent, access) {
    if (access === void 0) return { uid: 0, gid: 0 };
    return {
      uid: access.credentials.uid,
      gid: (parent.mode & SETGID_BIT) !== 0 ? parent.gid : access.credentials.gid
    };
  }
  permissionExpression(alias, access) {
    const groups = [...access.groups];
    return {
      sql: `CASE
        WHEN ${alias}.uid = ? THEN ((${alias}.mode >> 6) & 7)
        WHEN ${alias}.gid IN (SELECT value FROM json_each(?))
          THEN ((${alias}.mode >> 3) & 7)
        ELSE (${alias}.mode & 7)
      END`,
      bindings: [access.credentials.uid, JSON.stringify(groups)]
    };
  }
  /**
   * Conservative recursive semantics: a set operation is atomic, so an
   * inaccessible descendant rejects the whole operation instead of exposing
   * or mutating a partial prefix. SQLite performs the preflight in one range
   * scan and returns at most the first denied path.
   */
  assertSubtreePermissions(path, access, filePermissions, directoryPermissions) {
    if (access === void 0 || access.credentials.uid === 0) return;
    const range = descendantRange(path);
    const expression = this.permissionExpression("e", access);
    const denied = firstRow(
      this.sql.exec(
        `SELECT e.path
         FROM vfs_entries e INDEXED BY vfs_entries_path
         WHERE (e.path = ? OR (e.path >= ? AND e.path < ?))
           AND (
             (e.kind = 'directory' AND ((${expression.sql}) & ?) <> ?)
             OR
             (e.kind = 'file' AND ((${expression.sql}) & ?) <> ?)
           )
         ORDER BY e.path
         LIMIT 1`,
        path,
        range.lower,
        range.upper,
        ...expression.bindings,
        directoryPermissions,
        directoryPermissions,
        ...expression.bindings,
        filePermissions,
        filePermissions
      )
    );
    if (denied !== void 0) {
      throw new VfsError("EACCES", "permission denied", stringColumn(denied, "path"));
    }
  }
  assertSubtreeSticky(path, access) {
    if (access === void 0 || access.credentials.uid === 0) return;
    const range = descendantRange(path);
    const denied = firstRow(
      this.sql.exec(
        `SELECT child.path
         FROM vfs_entries child INDEXED BY vfs_entries_path
         JOIN vfs_entries parent INDEXED BY vfs_entries_path
           ON parent.path = child.parent_path
         WHERE (child.path > ? AND child.path >= ? AND child.path < ?)
           AND (parent.mode & ?) <> 0
           AND ? <> parent.uid
           AND ? <> child.uid
         ORDER BY child.path
         LIMIT 1`,
        path,
        range.lower,
        range.upper,
        STICKY_BIT,
        access.credentials.uid,
        access.credentials.uid
      )
    );
    if (denied !== void 0) {
      throw new VfsError(
        "EPERM",
        "sticky directory denies removing this entry",
        stringColumn(denied, "path")
      );
    }
  }
  newToken() {
    return this.createId();
  }
  transaction(callback, preservesTraversal = false) {
    if (!preservesTraversal) {
      this.traversalParents?.clear();
      this.traversalState.generation += 1;
    }
    try {
      const result = this.storage.transactionSync(() => {
        this.transactionDepth += 1;
        this.traversalState.depth += 1;
        if (preservesTraversal) this.traversalState.stableTraversalDepth += 1;
        try {
          const result2 = callback();
          if (this.transactionDepth === 1) this.flushParentTimes();
          return result2;
        } finally {
          this.transactionDepth -= 1;
          this.traversalState.depth -= 1;
          if (preservesTraversal) this.traversalState.stableTraversalDepth -= 1;
          else {
            this.traversalState.generation += 1;
            this.traversalParents?.clear();
          }
          if (this.transactionDepth === 0) this.transactionUsage = void 0;
        }
      });
      if (this.transactionDepth === 0) this.emitCommittedMutations();
      return result;
    } catch (error) {
      if (preservesTraversal) {
        this.traversalState.generation += 1;
        this.traversalParents?.clear();
      }
      this.pendingUsage = void 0;
      this.pendingMutations = [];
      this.pendingParents = void 0;
      this.directoryParentsChanged = false;
      this.directoryParentDeltas = void 0;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (/SQLITE_FULL|database or disk is full/iu.test(message)) {
        throw new VfsError("ENOSPC", "SQLite database capacity is exhausted");
      }
      throw error;
    }
  }
  emitCommittedMutations() {
    const usage = this.pendingUsage;
    if (usage !== void 0) {
      this.pendingUsage = void 0;
      emitVfsEvent(this.onEvent, { type: "vfs.usage", ...usage });
    }
    if (this.pendingMutations.length > 0) {
      const mutations = this.pendingMutations;
      this.pendingMutations = [];
      for (const mutation of mutations) {
        emitVfsEvent(this.onEvent, { type: "vfs.mutation", ...mutation });
      }
    }
  }
  execBatch(query) {
    if (this.storage.execBatch === void 0) this.sql.exec(query);
    else this.storage.execBatch(query);
  }
};

// src/vfs/sql-path-base.ts
function followsTerminalLink(row, follow) {
  return follow && row.kind === "symlink";
}
var SqlPath = class extends SqlBase {
  rows(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray().map((row) => parseEntry(row, this.mutationEpoch));
  }
  oneEntry(path) {
    const row = firstRow(
      this.sql.exec(
        `SELECT ${ENTRY_JSON} AS entry
       FROM vfs_entries e INDEXED BY vfs_entries_path
       WHERE e.path = ?`,
        path
      )
    );
    return row === void 0 ? null : parseEntry(JSON.parse(stringColumn(row, "entry")), this.mutationEpoch);
  }
  /**
   * Reads an entry and its tombstone token as one point lookup.
   *
   * Ordinary reads need only an entry and use `oneEntry`. A streamed write
   * also has to reserve the version of an absent path before it awaits its
   * body, then compare that version inside the commit transaction. A UNION
   * lets one statement answer both questions without making the live
   * row join anything: a removed path returns only its tombstone, and a path
   * never used returns no row at all.
   */
  pathState(path) {
    const row = firstRow(
      this.sql.exec(
        `SELECT ${ENTRY_COLUMNS}
         FROM vfs_entries e INDEXED BY vfs_entries_path
         WHERE e.path = ?
         UNION ALL
         SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, version
         FROM vfs_path_tombstones
         WHERE path = ?
         LIMIT 1`,
        path,
        path
      )
    );
    if (row === void 0) return { entry: null, mutationToken: NEVER_MUTATED_TOKEN };
    if (nullableIntegerColumn(row, "id") === null) {
      return {
        entry: null,
        mutationToken: formatMutationToken(
          this.mutationEpoch,
          integerColumn(row, "mutation_version")
        )
      };
    }
    const entry = parseEntry(row, this.mutationEpoch);
    return { entry, mutationToken: entry.mutationToken };
  }
  /**
   * The absolute form of a link target, read from the link's own parent.
   *
   * POSIX resolves a relative target against the directory holding the link,
   * not the working directory of whoever is looking, so a tree keeps meaning
   * the same thing wherever it is read from.
   */
  linkDestination(row) {
    return normalizeResolutionPath(
      pathRequiresDirectory(row.linkTarget) ? `${row.linkTarget}.` : row.linkTarget,
      row.parentPath
    );
  }
  /**
   * Finds the outermost link on the way to `path`, if there is one.
   *
   * A path that is not in the table either does not exist or lies under a
   * link, and only the second case needs more work. Asking for the ancestors
   * by exact path uses the partial link index and costs one query, rather than
   * one query per component.
   */
  linkAncestor(path) {
    const ancestors = [];
    for (let at = dirname(path); at !== "/"; at = dirname(at)) ancestors.push(at);
    if (ancestors.length === 0) return null;
    const row = firstRow(
      this.sql.exec(
        `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e
       WHERE e.kind = 'symlink'
         AND e.path IN (SELECT value FROM json_each(?))
       ORDER BY length(e.path) ASC
       LIMIT 1`,
        JSON.stringify(ancestors)
      )
    );
    if (row === void 0) return null;
    const entry = parseEntry(row, this.mutationEpoch);
    if (entry.kind !== "symlink") {
      throw new VfsError("EIO", "invalid SQLite entry state", entry.path);
    }
    return entry;
  }
  /**
   * Resolves a pathname, following links in every component.
   *
   * This is the only place a link is ever followed. Everything that reads or
   * writes an entry goes through it, so a policy check, a loop bound, and the
   * rule that a relative target reads from the link's parent cannot be skipped
   * by a caller that has not thought about links.
   *
   * `follow` governs the final component only, which is the difference between
   * `stat` and `lstat`: the components leading up to it are always followed,
   * because a link in the middle of a path is not a thing a caller can act on.
   *
   * When the namespace holds no links at all this is one lookup, the same query
   * the filesystem made before links existed.
   */
  resolveEntry(input, follow, context) {
    let path = input;
    const followed = context?.followed ?? [];
    for (let hops = context?.hops ?? 0; hops <= MAX_SYMLINK_HOPS; hops += 1) {
      if (context !== void 0) context.hops = hops;
      if (hasDotSegments(path))
        return this.resolveDottedEntry(path, follow, context ?? { followed, hops });
      const row = this.oneEntry(path);
      if (row === null) {
        const ancestor = this.missingAncestorLink(path);
        if (ancestor === null) return { path, row: null, followed };
        followed.push(ancestor.path);
        path = normalizeResolutionPath(
          `${this.linkDestination(ancestor)}/${path.slice(ancestor.path.length)}`
        );
        continue;
      }
      if (!followsTerminalLink(row, follow)) return { path, row, followed };
      followed.push(row.path);
      path = this.linkDestination(row);
    }
    throw new VfsError("ELOOP", "too many levels of symbolic links", input);
  }
  missingAncestorLink(path) {
    return this.links() === 0 ? null : this.linkAncestor(path);
  }
  resolveDottedEntry(input, follow, context) {
    let path = "/";
    for (const segment of input.split("/").filter(Boolean)) {
      if (segment !== "." && segment !== "..") {
        path = `${path}/${segment}`;
        continue;
      }
      if (path === "/") {
        context.followed.push("/");
        continue;
      }
      const prefix = this.resolveEntry(normalizePath(path), true, context);
      if (prefix.row === null) throw new VfsError("ENOENT", "no such directory", prefix.path);
      if (prefix.row.kind !== "directory")
        throw new VfsError("ENOTDIR", "not a directory", prefix.path);
      context.followed.push(`${prefix.path}/`);
      path = segment === ".." ? dirname(prefix.path) : prefix.path;
    }
    return this.resolveEntry(normalizePath(path), follow, context);
  }
  /**
   * The mutation token for `path`, taken from a row already resolved for it.
   *
   * `oneEntry` reads the live version and `parseEntry` builds the token from
   * that column, so a row in hand carries exactly what `tokenFor` would read.
   * Callers pass a row only when it was fetched at the same point as the
   * decision being made — never across an `await`, where re-reading is the
   * guard rather than a repeat of it.
   */
  tokenOf(path, entry) {
    return entry != null && entry.path === path ? entry.mutationToken : this.tokenFor(path);
  }
  /**
   * The token a guard is taken and checked against.
   *
   * A path that crosses a link means whatever the link currently says, so each
   * link's own version is part of what the caller reserved. Without them,
   * repointing a link between the read and the write is invisible whenever the
   * old and new targets happen to share a version — the exact ABA the token
   * exists to catch.
   */
  guardToken(path, entry) {
    const normalized = normalizeResolutionPath(path);
    if (this.links() === 0 && !hasDotSegments(normalized)) return this.tokenOf(normalized, entry);
    const resolved = this.resolveEntry(normalized, true);
    const base = this.tokenFor(resolved.path);
    if (resolved.followed.length === 0) return base;
    return [
      base,
      ...resolved.followed.map(
        (link) => this.tokenFor(link.endsWith("/") ? normalizePath(link) : link)
      )
    ].join("|");
  }
  /**
   * Canonicalizes a path, keeping a final component that does not exist.
   *
   * A caller canonicalizing the destination of a write it has not made yet
   * needs an answer, and refusing would make the policy check below depend on
   * whether the file happened to be there already.
   */
  realpath(path, options = {}, access) {
    const normalized = normalizeResolutionPath(path);
    if (this.links() === 0 && !hasDotSegments(normalized)) {
      this.assertTraverse(normalized, [], access);
      return normalized;
    }
    const resolved = this.resolveEntry(normalized, options.follow !== false);
    this.assertTraverse(resolved.path, resolved.followed, access);
    return resolved.path;
  }
  oneResolved(path, follow = true) {
    return this.resolveEntry(path, follow).row;
  }
  requireEntry(path, follow = true) {
    const row = this.symlinkCount === 0 && !this.symlinkCountStale && !hasDotSegments(path) ? this.oneEntry(path) : this.oneResolved(path, follow);
    if (row === null) throw new VfsError("ENOENT", "no such file or directory", path);
    return row;
  }
  requireDirectory(path, resolved) {
    const row = resolved ?? this.requireEntry(path);
    if (row.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", path);
    return row;
  }
  requireInline(path, resolved) {
    const row = resolved ?? this.requireEntry(path);
    if (row.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (row.contentClass !== "inline") {
      throw new VfsError("ENOTSUP", "opaque R2 content is not available to shell commands", path);
    }
    return row;
  }
  /**
   * Normalizes a path and resolves every link in it to a canonical one.
   *
   * Every operation goes through here, so the paths that reach the table are
   * always canonical: a link can never end up as the parent of an entry, which
   * is what lets an exact-path hit be trusted without walking the components.
   *
   * `followTerminal` is false for the operations that act on a link rather than
   * through it — `rm`, `mv`, `cp`, and `mkdir` name the link itself.
   */
  /**
   * Resolves a path to a canonical one and keeps the entry it landed on.
   *
   * Returning the row rather than only the path is what lets a caller act on a
   * link it asked not to follow. Looking the path up again afterwards would
   * resolve it a second time — with the follow flag lost — and a `rm` of a
   * dangling or cyclic link would fail on the target that is not there.
   *
   * `followTerminal` is false for the operations that name a link rather than
   * reach through it: `rm`, `mv`, `cp -P`, `mkdir`, and `ln -sf`.
   */
  resolveAccess(path, allowMissingDirectory = false, followTerminal = true) {
    const requiresDirectory = pathRequiresDirectory(path);
    const dotted = hasDotSegments(path);
    const normalized = dotted ? normalizeResolutionPath(path) : normalizePath(path);
    const resolved = this.links() === 0 && !dotted ? { path: normalized, row: null, followed: [] } : this.resolveEntry(normalized, followTerminal || requiresDirectory);
    if (requiresDirectory && resolved.row === null && resolved.path !== "/") {
      resolved.row = this.oneEntry(resolved.path);
    }
    if (!requiresDirectory || resolved.path === "/") return resolved;
    if (resolved.row === null) {
      if (allowMissingDirectory) return resolved;
      throw new VfsError("ENOENT", "no such directory", resolved.path);
    }
    if (resolved.row.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", resolved.path);
    }
    return resolved;
  }
  normalizeAccessPath(path, allowMissingDirectory = false, followTerminal = true) {
    return this.resolveAccess(path, allowMissingDirectory, followTerminal).path;
  }
  tokenFor(path) {
    const current = firstRow(
      this.sql.exec(
        `SELECT mutation_version AS version FROM vfs_entries INDEXED BY vfs_entries_path
         WHERE path = ?
         UNION ALL
         SELECT version FROM vfs_path_tombstones WHERE path = ?
         LIMIT 1`,
        path,
        path
      )
    );
    if (current !== void 0) {
      return formatMutationToken(this.mutationEpoch, integerColumn(current, "version"));
    }
    return NEVER_MUTATED_TOKEN;
  }
  /**
   * The sequence to stamp the change being published with.
   *
   * Zero when the cursor is off, which is also the value every row already
   * carries, so the stamped statement is the same statement either way and the
   * feature adds no work to a workspace that has not asked for it.
   *
   * Read from SQLite once per instance and then kept in memory. One number is
   * handed out per publication rather than per row, so every path a set-based
   * mutation touches shares a sequence and a reader sees one change rather
   * than a burst that has to be reassembled.
   */
  nextChangeSeq() {
    if (!this.recordChanges) return 0;
    if (this.lastChangeSeq === void 0) {
      this.lastChangeSeq = integerColumn(
        this.sql.exec("SELECT COALESCE(MAX(change_seq), 0) AS seq FROM vfs_path_changes").one(),
        "seq"
      );
    }
    this.lastChangeSeq += 1;
    return this.lastChangeSeq;
  }
  recordPathChange(path, present, changeSeq) {
    if (!this.recordChanges) return;
    this.sql.exec(
      `INSERT INTO vfs_path_changes (path, change_seq, present) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         change_seq = excluded.change_seq,
         present = excluded.present`,
      path,
      changeSeq ?? this.nextChangeSeq(),
      present ? 1 : 0
    );
  }
  /**
   * Publishes a new token for one path and records what changed it.
   *
   * The operation is a parameter rather than something inferred here because
   * this is the single place an ordinary mutation publishes a token, and
   * making it required is what turns "did every mutation report itself" into a
   * question the type checker answers instead of a review does.
   */
  publishToken(path, version, present, op, knownEntry) {
    const linkIdentity = knownEntry === void 0 ? void 0 : knownEntry?.linkIdentity ?? null;
    this.recordPathChange(path, present);
    const token = formatMutationToken(this.mutationEpoch, version);
    this.recordMutation({ op, path, mutationToken: token });
    if (this.sharedInodes && linkIdentity !== null && present && (op === "write" || op === "metadata")) {
      for (const row of this.sql.exec(
        `SELECT path, mutation_version FROM vfs_entries WHERE path <> ? AND link_identity = ${linkIdentity === void 0 ? "(SELECT link_identity FROM vfs_entries WHERE path = ?)" : "?"}`,
        path,
        linkIdentity ?? path
      ).toArray()) {
        const alias = stringColumn(row, "path");
        this.recordPathChange(alias, true);
        this.recordMutation({
          op,
          path: alias,
          mutationToken: formatMutationToken(
            this.mutationEpoch,
            integerColumn(row, "mutation_version")
          )
        });
      }
    }
    return token;
  }
  publishLinkedMetadata(identities) {
    if (identities.length === 0) return;
    for (const row of this.sql.exec(
      "SELECT path, mutation_version FROM vfs_entries WHERE link_identity IN (SELECT value FROM json_each(?))",
      JSON.stringify(identities)
    ).toArray()) {
      const path = stringColumn(row, "path");
      this.recordPathChange(path, true);
      this.recordMutation({
        op: "metadata",
        path,
        mutationToken: formatMutationToken(
          this.mutationEpoch,
          integerColumn(row, "mutation_version")
        )
      });
    }
  }
  /** Consumes an absent path's tombstone and returns its next live version. */
  nextEntryVersion(path, previousVersion = 0) {
    const tombstone = firstRow(
      this.sql.exec(
        "DELETE FROM vfs_path_tombstones WHERE path = ? RETURNING version",
        path
      )
    );
    return Math.max(previousVersion, tombstone === void 0 ? 0 : integerColumn(tombstone, "version")) + 1;
  }
  /**
   * Holds one change until its transaction commits.
   *
   * Guarded on the sink rather than inside `emitVfsEvent`, so an unobserved
   * workspace does not build an object it would only discard.
   */
  recordMutation(mutation) {
    if (mutation.op === "create" || mutation.op === "remove" || mutation.op === "move") {
      this.pendingParents ??= /* @__PURE__ */ new Set();
      this.pendingParents.add(dirname(mutation.path));
      if (mutation.subtree?.to !== void 0) this.pendingParents.add(dirname(mutation.subtree.to));
    }
    if (this.onEvent === void 0) return;
    this.pendingMutations.push(mutation);
  }
  validateGuard(path, entry, guard, written) {
    if (guard.ifMutationToken === void 0) return;
    const current = written === void 0 ? this.tokenOf(path, entry) : this.guardToken(written, entry);
    if (current !== guard.ifMutationToken) {
      throw new VfsError("EREVISION", "path mutation token does not match", path);
    }
  }
};

// src/vfs/sql-mutation-base.ts
var SqlMutation = class extends SqlPath {
  deferredUsage;
  /** Keep batch quota checks current while writing the singleton only once. */
  withDeferredUsage(callback) {
    if (this.deferredUsage !== void 0) return callback();
    const delta = { inlineBytes: 0, entries: 0, changed: false };
    this.deferredUsage = delta;
    try {
      const result = callback();
      if (delta.changed) this.writeUsage(delta.inlineBytes, delta.entries);
      return result;
    } finally {
      this.deferredUsage = void 0;
    }
  }
  usage() {
    if (this.transactionUsage !== void 0) return this.transactionUsage;
    const row = this.sql.exec("SELECT inline_bytes, entries FROM vfs_usage WHERE singleton = 1").one();
    const usage = {
      inlineBytes: integerColumn(row, "inline_bytes"),
      entries: integerColumn(row, "entries")
    };
    if (this.transactionDepth > 0) this.transactionUsage = usage;
    return usage;
  }
  /**
   * The next entry identity to hand out, and the one after it.
   *
   * Held in memory and made durable by riding the usage UPDATE that every
   * entry creation already performs, which is what makes never reusing an
   * identity cost nothing: no counter row of its own, no `sqlite_sequence`,
   * no extra statement. Seeded once per instance, and monotone across
   * eviction because the durable value is written with the entry that used it.
   *
   * A rolled-back transaction leaves its numbers unused. A gap is harmless —
   * nothing derives meaning from an identity being consecutive.
   */
  allocateIno(count = 1) {
    const first = this.nextIno;
    this.nextIno += count;
    return first;
  }
  updateUsage(inlineDelta, entryDelta) {
    if (inlineDelta === 0 && entryDelta === 0) {
      if (this.onEvent !== void 0) this.pendingUsage = this.transactionUsage ?? this.usage();
      return;
    }
    if (this.deferredUsage === void 0) this.writeUsage(inlineDelta, entryDelta);
    else {
      this.deferredUsage.inlineBytes += inlineDelta;
      this.deferredUsage.entries += entryDelta;
      this.deferredUsage.changed = true;
    }
    const cached = this.transactionUsage;
    if (cached !== void 0) {
      this.transactionUsage = {
        inlineBytes: cached.inlineBytes + inlineDelta,
        entries: cached.entries + entryDelta
      };
    }
    if (this.onEvent !== void 0) this.pendingUsage = this.usage();
  }
  writeUsage(inlineDelta, entryDelta) {
    this.sql.exec(
      `UPDATE vfs_usage SET
         inline_bytes = inline_bytes + ?, entries = entries + ?,
         next_ino = MAX(next_ino, ?)
       WHERE singleton = 1`,
      inlineDelta,
      entryDelta,
      this.nextIno
    );
  }
  /** Reports the storage limit that refused work, then fails. */
  quotaExceeded(limit, requested, used, max, message, path) {
    emitVfsEvent(this.onEvent, {
      type: "vfs.quota",
      limit,
      requested,
      used,
      max,
      ...path === void 0 ? {} : { path }
    });
    throw new VfsError("ENOSPC", message, path);
  }
  /**
   * Refuses work that would carry the workspace past a quota.
   *
   * Only growth is refused. Comparing the end state alone would also refuse a
   * mutation that holds steady or gives space back, which is wrong once usage
   * exceeds a limit: writing less is the way out of that state. The two agree
   * everywhere below a ceiling and at it, so this changes only what happens
   * above one -- which a limit that can move is what makes reachable.
   */
  assertCapacity(inlineDelta, entryDelta, path) {
    if (inlineDelta <= 0 && entryDelta <= 0) {
      this.maxInlineLogicalBytes();
      this.maxEntries();
      if (this.onEvent !== void 0) this.usage();
      this.assertDatabaseHeadroom(path);
      return;
    }
    this.assertCapacityFrom(this.usage(), inlineDelta, entryDelta, path);
  }
  assertDatabaseHeadroom(path) {
    const databaseSize = this.sql.databaseSize;
    if (databaseSize + this.minDatabaseHeadroomBytes > this.maxDatabaseBytes) {
      this.quotaExceeded(
        "databaseHeadroom",
        this.minDatabaseHeadroomBytes,
        databaseSize,
        this.maxDatabaseBytes,
        "SQLite database headroom is exhausted",
        path
      );
    }
  }
  /**
   * The same refusal, weighed against a stated starting point.
   *
   * A batch accumulates its entries' deltas and weighs them once against the
   * usage it began from, which `usage()` cannot report by then because every
   * entry has already moved it. Passing the base in is what lets one set be
   * judged as one thing, and that is the whole difference between refusing a
   * set that ends over a ceiling and refusing an entry that is momentarily
   * over one inside a set that ends under it.
   */
  assertCapacityFrom(usage, inlineDelta, entryDelta, path) {
    const maxInlineLogicalBytes = this.maxInlineLogicalBytes();
    if (inlineDelta > 0 && usage.inlineBytes + inlineDelta > maxInlineLogicalBytes) {
      this.quotaExceeded(
        "maxInlineLogicalBytes",
        inlineDelta,
        usage.inlineBytes,
        maxInlineLogicalBytes,
        "workspace inline-byte quota exceeded",
        path
      );
    }
    const maxEntries = this.maxEntries();
    if (entryDelta > 0 && usage.entries + entryDelta > maxEntries) {
      this.quotaExceeded(
        "maxEntries",
        entryDelta,
        usage.entries,
        maxEntries,
        "filesystem entry quota exceeded",
        path
      );
    }
    this.assertDatabaseHeadroom(path);
  }
  aggregateSubtree(path, single = false) {
    const range = descendantRange(path);
    const row = this.sql.exec(
      `SELECT COUNT(*) AS entries,
              COALESCE(SUM(CASE WHEN content_class = 'inline' THEN size_bytes ELSE 0 END), 0)
                AS inline_bytes,
              COALESCE(SUM(CASE WHEN kind = 'file' THEN size_bytes ELSE 0 END), 0)
                AS logical_file_bytes
       FROM vfs_entries
       WHERE path = ? ${single ? "" : "OR (path >= ? AND path < ?)"}`,
      path,
      ...single ? [] : [range.lower, range.upper]
    ).one();
    return {
      entries: integerColumn(row, "entries"),
      inlineBytes: integerColumn(row, "inline_bytes"),
      logicalFileBytes: integerColumn(row, "logical_file_bytes")
    };
  }
  publishSubtreeRemoval(path, changeSeq = this.nextChangeSeq(), single = false) {
    const range = descendantRange(path);
    this.sql.exec(
      `INSERT INTO vfs_path_tombstones (path, version)
       SELECT path, mutation_version + 1 FROM vfs_entries
       WHERE path = ? ${single ? "" : "OR (path >= ? AND path < ?)"}
       ON CONFLICT(path) DO UPDATE SET
         version = MAX(vfs_path_tombstones.version, excluded.version)`,
      path,
      ...single ? [] : [range.lower, range.upper]
    );
    this.recordSubtreeChange(path, false, changeSeq, single);
  }
  recordSubtreeChange(path, present, changeSeq, single = false) {
    if (!this.recordChanges) return;
    if (single) {
      this.recordPathChange(path, present, changeSeq);
      return;
    }
    const range = descendantRange(path);
    this.sql.exec(
      `INSERT INTO vfs_path_changes (path, change_seq, present)
       SELECT path, ?, ? FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)
       ON CONFLICT(path) DO UPDATE SET
         change_seq = excluded.change_seq,
         present = excluded.present`,
      changeSeq,
      present ? 1 : 0,
      path,
      range.lower,
      range.upper
    );
  }
  clearSubtreeTombstones(path) {
    const range = descendantRange(path);
    this.sql.exec(
      `DELETE FROM vfs_path_tombstones
       WHERE (path = ? OR (path >= ? AND path < ?))
         AND EXISTS (
           SELECT 1 FROM vfs_entries WHERE vfs_entries.path = vfs_path_tombstones.path
         )`,
      path,
      range.lower,
      range.upper
    );
  }
};

// src/vfs/sql-content-base.ts
function equalSpan(left, leftOffset, right, rightOffset, length) {
  for (let index = 0; index < length; index += 1) {
    if (left[leftOffset + index] !== right[rightOffset + index]) return false;
  }
  return true;
}
var StoredBodyCursor = class {
  constructor(rows) {
    this.rows = rows;
  }
  rows;
  index = -1;
  position = 0;
  body = new Uint8Array(0);
  matches(chunks) {
    for (const chunk of chunks) if (!this.matchesChunk(chunk)) return false;
    return true;
  }
  matchesChunk(chunk) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (!this.advanceBody()) return false;
      const span = Math.min(this.body.byteLength - this.position, chunk.byteLength - offset);
      if (!equalSpan(this.body, this.position, chunk, offset, span)) return false;
      this.position += span;
      offset += span;
    }
    return true;
  }
  advanceBody() {
    while (this.position >= this.body.byteLength) {
      this.index += 1;
      const row = this.rows[this.index];
      if (row === void 0) return false;
      this.body = new Uint8Array(blobColumn(row, "body"));
      this.position = 0;
    }
    return true;
  }
};
var SqlContent = class extends SqlMutation {
  createDirectory(path, now, mode = DIRECTORY_MODE, access, intermediate = false, knownParent) {
    const parent = access === void 0 ? void 0 : knownParent ?? this.requireDirectory(dirname(path));
    if (parent !== void 0) {
      this.assertPermission(parent, access, WRITE_PERMISSION | EXECUTE_PERMISSION, path);
    }
    const effectiveMode = parent === void 0 ? mode : this.creationMode(mode, access, parent, true, intermediate);
    const owner = parent === void 0 ? { uid: 0, gid: 0 } : this.creationOwner(parent, access);
    const mutationVersion = this.nextEntryVersion(path);
    const inserted = this.sql.exec(
      `INSERT INTO vfs_entries (
         id, path, parent_path, name, kind, content_class, opaque_object_id,
         size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
         mutation_version, link_count
       ) VALUES (?, ?, ?, ?, 'directory', NULL, NULL, 0, ?, ?, ?, ?, ?, 1, ?, 2)
       RETURNING id`,
      this.allocateIno(),
      path,
      dirname(path),
      basename(path),
      effectiveMode,
      owner.uid,
      owner.gid,
      now,
      now,
      mutationVersion
    ).one();
    this.noteDirectoryDelta(dirname(path), 1);
    const token = this.publishToken(path, mutationVersion, true, "create");
    const id = integerColumn(inserted, "id");
    this.updateUsage(0, 1);
    return {
      id,
      path,
      parentPath: dirname(path),
      name: basename(path),
      kind: "directory",
      linkCount: 2,
      contentClass: null,
      opaqueObjectId: null,
      linkTarget: null,
      sizeBytes: 0,
      mode: effectiveMode,
      uid: owner.uid,
      gid: owner.gid,
      createdAtMs: now,
      modifiedAtMs: now,
      changedAtMs: now,
      revision: 1,
      mutationVersion,
      mutationToken: token
    };
  }
  creationParents(path, recursive) {
    const missing = [];
    let current = dirname(path);
    let parent = this.oneResolved(current);
    while (parent === null) {
      missing.unshift(current);
      current = dirname(current);
      parent = this.oneResolved(current);
    }
    if (parent !== null && parent.path !== current) {
      throw new VfsError("ENOTDIR", "not a directory", current);
    }
    const existingParent = this.requireDirectory(current, parent);
    if (missing.length > 0 && !recursive) {
      throw new VfsError("ENOENT", "parent directory does not exist", dirname(path));
    }
    return { existing: existingParent, missing };
  }
  assertCreationAccess(path, followed, access, parent) {
    if (access === void 0) return;
    this.assertTraverse(parent.path, followed, access);
    this.assertPermission(parent, access, WRITE_PERMISSION | EXECUTE_PERMISSION, path);
  }
  prepareParents(path, recursive, now, followed, access) {
    const parents = this.creationParents(path, recursive);
    this.assertCreationAccess(path, followed, access, parents.existing);
    return this.createMissingParents(path, now, access, parents);
  }
  createMissingParents(path, now, access, parents) {
    if (parents.missing.length === 0) return parents.existing;
    this.assertCapacity(0, parents.missing.length, path);
    let parent = parents.existing;
    for (const missingParent of parents.missing) {
      parent = this.createDirectory(missingParent, now, DIRECTORY_MODE, access, true, parent);
    }
    return parent;
  }
  assertWriteAccess(path, entry, recursive, followed, access) {
    if (entry === null) {
      if (access === void 0) return;
      const parents = this.creationParents(path, recursive);
      this.assertCreationAccess(path, followed, access, parents.existing);
      return;
    }
    this.assertTraverse(path, followed, access);
    this.assertPermission(entry, access, WRITE_PERMISSION, path);
  }
  assertDestinationReplaceable(destination, target, replace) {
    if (destination === null) return;
    if (!replace) throw new VfsError("EEXIST", "destination exists", target);
    if (destination.kind !== "directory") return;
    const child = firstRow(
      this.sql.exec(
        "SELECT 1 AS present FROM vfs_entries WHERE parent_path = ? LIMIT 1",
        target
      )
    );
    if (child !== void 0) throw new VfsError("ENOTEMPTY", "directory is not empty", target);
  }
  async collectInline(body, heldByCaller = 0) {
    try {
      return await collectInlineBytes(
        body,
        this.maxInlineFileBytes,
        this.chunkBytes,
        this.inFlightBytes,
        heldByCaller
      );
    } catch (error) {
      this.throwInlineCollectionError(error);
    }
  }
  collectInlineSync(body, heldByCaller = 0) {
    try {
      return collectInlineBytesSync(
        body,
        this.maxInlineFileBytes,
        this.chunkBytes,
        this.inFlightBytes,
        heldByCaller
      );
    } catch (error) {
      this.throwInlineCollectionError(error);
    }
  }
  throwInlineCollectionError(error) {
    if (isVfsError(error) && error.code === "EFBIG") {
      emitVfsEvent(this.onEvent, {
        type: "vfs.quota",
        limit: "maxInlineFileBytes",
        used: this.maxInlineFileBytes,
        max: this.maxInlineFileBytes
      });
    }
    throw error;
  }
  useBuffered(buffered, operation) {
    try {
      return operation(buffered.chunks, buffered.sizeBytes);
    } finally {
      buffered.release();
    }
  }
  /**
   * The same release guarantee for a set of bodies held at once.
   *
   * A batch cannot release as it goes: nothing is published until the last
   * entry has been committed, so every body has to stay materialized until the
   * transaction closes, and every lease has to be given back whether it
   * committed or threw.
   */
  useBufferedSet(collected, operation) {
    try {
      return operation();
    } finally {
      for (const item of collected) item.lease.release();
    }
  }
  /**
   * The digest of a body about to be written, or undefined when none is wanted.
   *
   * Taken whenever the caller asked to skip an unchanged body, over slabs the
   * call is already holding and before the transaction opens, because
   * `crypto.subtle` is asynchronous and no cursor may cross an await.
   *
   * Deliberately not narrowed to the case that can skip. A digest is only ever
   * recorded by a call that computes one, so hashing only when the sizes
   * already match would leave a workspace that never publishes a differing
   * body -- the steady state of a debounced flush -- without one forever.
   */
  async incomingDigest(options, buffered) {
    try {
      if (options.skipIfUnchanged !== true) return void 0;
      return await sha256Hex(buffered.chunks, buffered.sizeBytes);
    } catch (error) {
      buffered.release();
      throw error;
    }
  }
  /**
   * The digest recorded for an entry, or null when there is none to trust.
   *
   * The stamp is compared in SQL rather than read back and checked here, so a
   * stale one returns no row and the caller falls through to reading the body.
   */
  storedDigest(entryId) {
    const row = firstRow(
      this.sql.exec(
        `SELECT body_digest FROM vfs_entries
       WHERE id = ? AND body_digest IS NOT NULL AND body_digest_revision = revision`,
        entryId
      )
    );
    return row === void 0 ? null : stringColumn(row, "body_digest");
  }
  /**
   * Whether the stored body is what is about to be written.
   *
   * A recorded digest answers it without reading the body at all. Without one
   * -- a first write, an entry from before the column existed, a stamp left by
   * an earlier revision -- the bodies are compared as before, and a match
   * records the digest so no later call has to read them again.
   *
   * That record is the only write this path performs. It leaves the revision,
   * the token, `modifiedAtMs`, the size, the identity and the usage totals
   * exactly as they were, so nothing a caller can observe about the entry
   * changes; without it a workspace whose body never differs would pay the
   * comparison forever.
   */
  bodyIsUnchanged(entryId, revision, chunks, digest) {
    if (digest !== void 0) {
      const stored = this.storedDigest(entryId);
      if (stored !== null) return stored === digest;
    }
    if (!this.inlineBodyMatches(entryId, chunks)) return false;
    if (digest !== void 0) {
      this.sql.exec(
        "UPDATE vfs_entries SET body_digest = ?, body_digest_revision = ? WHERE id = ?",
        digest,
        revision,
        entryId
      );
    }
    return true;
  }
  /**
   * Whether the stored inline body is byte-identical to the slabs about to
   * replace it.
   *
   * Callers must already have established that the recorded size matches, and
   * that ordering is the whole cost model: a body of a different length is
   * decided from a column already in hand, and only one of the same length
   * pays for this read of its own chunks. A write that is not asking to skip
   * never reaches here at all.
   *
   * Chunk boundaries are not assumed to line up. Both sides are walked as byte
   * sequences instead, so a body stored under a different `chunkBytes` than
   * this instance is configured with still compares correctly rather than
   * reporting a spurious difference.
   */
  inlineBodyMatches(entryId, chunks) {
    const stored = this.sql.exec(
      `SELECT body FROM vfs_inline_chunks
       WHERE entry_id = ? ORDER BY chunk_index`,
      entryId
    ).toArray();
    return new StoredBodyCursor(stored).matches(chunks);
  }
  /**
   * Uses at most 99 of Cloudflare's 100 bound parameters per statement:
   * three values for each of 33 chunk rows.
   */
  writeChunks(entryId, firstIndex, chunks, updateSingle = false) {
    const single = chunks[0];
    if (updateSingle && chunks.length === 1 && single !== void 0) {
      const updated = firstRow(
        this.sql.exec(
          `UPDATE vfs_inline_chunks SET body = ?
           WHERE entry_id = ? AND chunk_index = ? RETURNING entry_id`,
          single,
          entryId,
          firstIndex
        )
      );
      if (updated === void 0) throw new VfsError("EIO", "inline file is missing a stored chunk");
      return;
    }
    for (let offset = 0; offset < chunks.length; offset += 33) {
      const batch = chunks.slice(offset, offset + 33);
      this.sql.exec(
        `INSERT INTO vfs_inline_chunks(entry_id, chunk_index, body)
         VALUES ${batch.map(() => "(?, ?, ?)").join(", ")}
         ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body`,
        ...batch.flatMap((body, index) => [entryId, firstIndex + offset + index, body])
      );
    }
  }
};

// src/vfs/stat-many.ts
function statResult(read) {
  try {
    return { stat: read() };
  } catch (error) {
    if (!(error instanceof VfsError) || error.name !== "VfsError") throw error;
    return {
      error: {
        code: error.code,
        message: error.message,
        ...error.path === void 0 ? {} : { path: error.path }
      }
    };
  }
}
function validateStatPaths(paths) {
  if (!Array.isArray(paths) || paths.length > 1e3)
    throw new VfsError("E2BIG", "statMany accepts at most 1000 paths");
  for (const path of paths)
    if (typeof path !== "string") throw new VfsError("EINVAL", "statMany paths must be strings");
}
function canonicalStatPaths(paths) {
  const canonical = [];
  try {
    for (const path of paths) {
      if (hasDotSegments(path) || pathRequiresDirectory(path) || /[\uD800-\uDFFF]/u.test(path))
        return void 0;
      canonical.push(normalizePath(path));
    }
  } catch (error) {
    if (!(error instanceof VfsError)) throw error;
    return void 0;
  }
  return canonical;
}

// src/vfs/sql-query-base.ts
var DEFAULT_CHANGE_PAGE = 1e3;
var MAX_CHANGE_PAGE = 1e4;
function sqlNamePrefilter(name) {
  if (name === void 0 || name.includes("\0") || /[\\[]/u.test(name)) return void 0;
  const wildcard = name.search(/[?*]/u);
  const prefix = wildcard < 0 ? name : name.slice(0, wildcard);
  if (prefix.length > 49 || utf8ByteLength(prefix) > 49) return void 0;
  return prefix === "" ? void 0 : `${prefix}*`;
}
var SqlQuery = class extends SqlContent {
  stat(path, access) {
    return this.statEntry(path, true, access);
  }
  statMany(paths, options = {}, access) {
    validateStatPaths(paths);
    if (paths.length < 2)
      return paths.map(
        (path) => statResult(() => this.statEntry(path, options.follow !== false, access))
      );
    const follow = options.follow !== false;
    const canonical = canonicalStatPaths(paths);
    if (canonical === void 0 || this.links() !== 0)
      return paths.map((path) => statResult(() => this.statEntry(path, follow, access)));
    const entries = /* @__PURE__ */ new Map();
    for (let at = 0; at < canonical.length; at += 64) {
      const batch = canonical.slice(at, at + 64);
      const rows = this.sql.exec(
        `WITH requested(path) AS (VALUES ${batch.map(() => "(?)").join(",")})
         SELECT ${ENTRY_JSON} AS entry
         FROM requested CROSS JOIN vfs_entries e INDEXED BY vfs_entries_path
         ON e.path = requested.path`,
        ...batch
      ).toArray();
      for (const result of rows) {
        const row = parseEntry(
          JSON.parse(stringColumn(result, "entry")),
          this.mutationEpoch
        );
        entries.set(row.path, row);
      }
    }
    return canonical.map(
      (path) => statResult(() => {
        const row = entries.get(path);
        if (row?.contentClass === "opaque") return this.statEntry(path, follow, access);
        this.assertTraverse(path, [], access);
        if (row === void 0) throw new VfsError("ENOENT", "no such file or directory", path);
        if (access !== void 0 && row.kind === "directory") this.rememberTraversalParent(row);
        return rowToStat(row);
      })
    );
  }
  /** Reports a link as itself rather than as what it points at. */
  lstat(path, access) {
    return this.statEntry(path, false, access);
  }
  /**
   * Reports the entry holding an identity. See {@link VirtualFileSystem.statById}.
   *
   * One statement: seek the rowid and indexed hard-link identities separately,
   * select the lowest matching stored id, then fetch that row. An ordered OR
   * over both identities can scan the whole namespace.
   *
   * Takes no access context. The credential-bound view refuses the call rather
   * than filtering it, because an identity carries no path to check ancestors
   * of and because answering by one at all is what a dense counter makes
   * enumerable.
   */
  statById(ino) {
    if (!Number.isSafeInteger(ino) || ino < 1) {
      throw new VfsError("EINVAL", "entry identity must be a positive safe integer");
    }
    const row = firstRow(
      this.sql.exec(
        `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e
       WHERE e.id = (
         SELECT id FROM vfs_entries WHERE id = ? AND link_identity IS NULL
         UNION SELECT id FROM vfs_entries WHERE link_identity = ?
         ORDER BY id LIMIT 1
       )`,
        ino,
        ino
      )
    );
    if (row === void 0) throw new VfsError("ENOENT", "no entry holds that identity");
    return rowToStat(parseEntry(row, this.mutationEpoch));
  }
  readlink(path, access) {
    const resolved = this.accessEntry(path, false);
    this.assertTraverse(resolved.path, resolved.followed, access);
    const row = resolved.row;
    if (row === null) throw new VfsError("ENOENT", "no such file or directory", resolved.path);
    if (row.kind !== "symlink") {
      throw new VfsError("EINVAL", "not a symbolic link", row.path);
    }
    return row.linkTarget;
  }
  /**
   * Resolves a path once and keeps the row it landed on.
   *
   * Normalizing and then looking up would resolve the same path twice, which
   * would double what every read costs as soon as a single link exists
   * anywhere in the namespace.
   */
  accessEntry(path, follow) {
    const requiresDirectory = pathRequiresDirectory(path);
    const normalized = hasDotSegments(path) ? normalizeResolutionPath(path) : normalizePath(path);
    const resolved = this.resolveEntry(normalized, follow || requiresDirectory);
    if (requiresDirectory && resolved.row !== null && resolved.row.kind !== "directory") {
      throw new VfsError("ENOTDIR", "not a directory", resolved.path);
    }
    return resolved;
  }
  statEntry(path, follow, posix) {
    const checked = posix !== void 0 && !pathRequiresDirectory(path) && !hasDotSegments(path) && this.links() === 0 ? this.plainPosixEntry(path, posix) : null;
    const access = checked ?? this.accessEntry(path, follow);
    if (checked === null) this.assertTraverse(access.path, access.followed, posix);
    if (access.row === null) {
      throw new VfsError("ENOENT", "no such file or directory", access.path);
    }
    const row = access.row;
    if (posix !== void 0 && row.kind === "directory") this.rememberTraversalParent(row);
    const stat = rowToStat(row);
    if (row.contentClass !== "opaque") {
      return stat;
    }
    const object = this.opaqueObject(row.opaqueObjectId);
    if (object === null) throw new VfsError("EIO", "opaque object metadata is missing", row.path);
    return {
      ...stat,
      ...object.contentType === null ? {} : { contentType: object.contentType },
      ...object.verifiedSha256 === null ? {} : { verifiedSha256: object.verifiedSha256 }
    };
  }
  plainPosixEntry(path, posix) {
    const normalized = normalizePath(path);
    if (this.tryCachedTraversal(normalized, [], posix)) return this.accessEntry(normalized, true);
    return this.lookupPlainPosixEntry(normalized, posix);
  }
  lookupPlainPosixEntry(normalized, posix) {
    const ancestors = canonicalAncestors(normalized);
    const row = this.sql.exec(
      `SELECT ${ENTRY_COLUMNS},
          (SELECT json_group_array(json_array(path,kind,mode,uid,gid))
             FROM vfs_entries INDEXED BY vfs_entries_path
             WHERE path IN (SELECT value FROM json_each(?))) AS parents
       FROM (SELECT 1) seed
       LEFT JOIN vfs_entries e INDEXED BY vfs_entries_path ON e.path = ?`,
      JSON.stringify(ancestors),
      normalized
    ).one();
    const parents = JSON.parse(stringColumn(row, "parents"));
    if (!Array.isArray(parents) || parents.length !== ancestors.length)
      throw new VfsError("ENOENT", "an ancestor directory does not exist", normalized);
    for (const parent of parents) this.checkPlainParent(parent, normalized, posix);
    return {
      path: normalized,
      row: row["id"] === null ? null : parseEntry(row, this.mutationEpoch),
      followed: []
    };
  }
  checkPlainParent(value, path, posix) {
    if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "string" || typeof value[2] !== "number" || typeof value[3] !== "number" || typeof value[4] !== "number")
      throw new VfsError("EIO", "invalid ancestor metadata", path);
    const parent = value[0], kind = value[1], mode = value[2], uid = value[3], gid = value[4];
    if (![mode, uid, gid].every(Number.isSafeInteger))
      throw new VfsError("EIO", "invalid ancestor metadata", path);
    if (kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent);
    const directory = { path: parent, kind: "directory", mode, uid, gid };
    this.assertPermission(directory, posix, EXECUTE_PERMISSION, path);
    this.rememberTraversalParent(directory);
  }
  getMutationToken(path, options = {}, access) {
    if (access === void 0) {
      return this.transaction(
        () => options.follow === false ? this.tokenFor(this.normalizeAccessPath(path, true, false)) : this.guardToken(path),
        true
      );
    }
    return this.transaction(() => {
      const resolved = this.resolveAccess(path, true, options.follow !== false);
      this.assertTraverse(resolved.path, resolved.followed, access);
      return options.follow === false ? this.tokenFor(resolved.path) : this.guardToken(path);
    }, true);
  }
  list(path, posix) {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const directory = this.requireDirectory(normalized, access.row);
    this.assertPermission(directory, posix, READ_PERMISSION | EXECUTE_PERMISSION, normalized);
    if (posix !== void 0) this.rememberTraversalParent(directory);
    return this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_parent_name
       WHERE e.parent_path = ? AND e.path <> '/'
       ORDER BY e.name`,
      normalized
    ).map(rowToStat);
  }
  listPage(path, options = {}, posix) {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const directory = this.requireDirectory(normalized, access.row);
    this.assertPermission(directory, posix, READ_PERMISSION | EXECUTE_PERMISSION, normalized);
    if (posix !== void 0) this.rememberTraversalParent(directory);
    const limit = options.limit ?? 1e3;
    validatePositiveInteger(limit, "limit");
    const cursor = options.cursor ?? "";
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const cursorName = cursor.startsWith(prefix) ? cursor.slice(prefix.length) : "";
    const indexedCursorName = cursorName.includes("/") ? "" : cursorName;
    const rows = this.rows(
      `SELECT ${ENTRY_COLUMNS}
       FROM vfs_entries e INDEXED BY vfs_entries_parent_name
       WHERE e.parent_path = ? AND e.name > ? AND e.path <> '/' AND e.path > ?
       ORDER BY e.name LIMIT ?`,
      normalized,
      indexedCursorName,
      cursor,
      limit + 1
    );
    const page = rows.slice(0, limit);
    return {
      entries: page.map(rowToStat),
      nextCursor: rows.length > limit ? page.at(-1)?.path ?? null : null,
      scanned: page.length
    };
  }
  find(options, access) {
    const maximum = options.limit ?? 1e4;
    validatePositiveInteger(maximum, "limit");
    const result = [];
    let cursor = options.cursor;
    const context = this.findScanContext(options, access);
    do {
      const page = this.scanFindPage(
        context,
        {
          ...options,
          ...cursor === void 0 ? {} : { cursor },
          limit: Math.min(maximum - result.length, 1e3)
        },
        true
      );
      result.push(...page.entries);
      cursor = page.nextCursor ?? void 0;
    } while (cursor !== void 0 && result.length < maximum);
    return result;
  }
  findPage(options, posix) {
    const limit = options.limit ?? 1e3;
    validatePositiveInteger(limit, "limit");
    return this.scanFindPage(this.findScanContext(options, posix), options);
  }
  findScanContext(options, posix) {
    const access = this.resolveAccess(options.path);
    const root = access.path;
    const rootEntry = access.row ?? this.requireEntry(root);
    if (posix !== void 0) {
      this.assertTraverse(root, access.followed, posix);
      this.assertPermission(
        rootEntry,
        posix,
        rootEntry.kind === "directory" ? READ_PERMISSION | EXECUTE_PERMISSION : 0,
        root
      );
      if (rootEntry.kind === "directory") {
        this.assertSubtreePermissions(root, posix, 0, READ_PERMISSION | EXECUTE_PERMISSION);
      }
    }
    return {
      root,
      rootEntry,
      range: descendantRange(root),
      namePattern: options.name === void 0 ? void 0 : globToRegExp(options.name),
      pathPattern: options.pathGlob === void 0 ? void 0 : globToRegExp(options.pathGlob)
    };
  }
  findRows(context, options, limit, filterInSql) {
    const { root, rootEntry, range } = context;
    if (rootEntry.kind === "file") return [];
    if (filterInSql && options.maxDepth !== void 0 && options.maxDepth < 1) return [];
    const cursor = options.cursor ?? (root === "/" ? "" : root);
    const shallow = filterInSql && options.maxDepth === 1;
    const index = shallow ? "vfs_entries_parent_name" : "vfs_entries_path";
    let where = shallow ? "e.parent_path = ? AND e.path > ? AND e.path <> ?" : "e.path >= MAX(?, ?) AND e.path < ? AND e.path > ? AND e.path <> ?";
    const bindings = shallow ? [root, cursor, root] : [range.lower, cursor, range.upper, cursor, root];
    if (filterInSql && options.type !== void 0) {
      where += " AND e.kind = ?";
      bindings.push(options.type);
    }
    const name = filterInSql ? sqlNamePrefilter(options.name) : void 0;
    if (name !== void 0) {
      where += " AND e.name GLOB ?";
      bindings.push(name);
    }
    return this.rows(
      `SELECT ${ENTRY_COLUMNS} FROM vfs_entries e INDEXED BY ${index}
       WHERE ${where} ORDER BY ${shallow ? "e.name" : "e.path"} LIMIT ?`,
      ...bindings,
      limit
    );
  }
  scanFindPage(context, options, filterInSql = false) {
    const { root, rootEntry, namePattern, pathPattern } = context;
    const limit = options.limit ?? 1e3;
    const includeRoot = options.cursor === void 0 && (rootEntry.kind === "file" || (options.includeRoot ?? false));
    const descendants = this.findRows(context, options, limit + (includeRoot ? 0 : 1), filterInSql);
    const scannedRows = (includeRoot ? [rootEntry, ...descendants] : descendants).slice(0, limit);
    const entries = scannedRows.filter((row) => {
      if (options.maxDepth !== void 0 && depthFrom(root, row.path) > options.maxDepth)
        return false;
      if (options.type !== void 0 && row.kind !== options.type) return false;
      if (namePattern !== void 0 && !namePattern.test(row.name)) return false;
      if (pathPattern !== void 0 && !pathPattern.test(row.path)) return false;
      return true;
    }).map(rowToStat);
    const hasMore = descendants.length + (includeRoot ? 1 : 0) > limit;
    return {
      entries,
      nextCursor: hasMore ? scannedRows.at(-1)?.path ?? null : null,
      scanned: scannedRows.length
    };
  }
  subtreeSummary(path, posix) {
    const access = this.resolveAccess(path, false, false);
    this.assertTraverse(access.path, access.followed, posix);
    const entry = access.row ?? this.requireEntry(access.path, false);
    if (entry.kind === "symlink") return { entries: 1, inlineBytes: 0, logicalFileBytes: 0 };
    this.assertSubtreePermissions(access.path, posix, 0, READ_PERMISSION | EXECUTE_PERMISSION);
    return this.aggregateSubtree(access.path);
  }
  /**
   * Internal shell-budget preflight with the permission semantics of the
   * mutation it is charging. In particular, rename does not need read access
   * to a source subtree merely because its entry count is used as a limit.
   */
  countPosixMutationSubtree(path, operation, posix) {
    const access = this.resolveAccess(
      path,
      false,
      operation.kind === "copy" && operation.dereference
    );
    const entry = access.row ?? this.requireEntry(access.path, false);
    this.assertTraverse(access.path, access.followed, posix);
    if (operation.kind === "copy") {
      if (entry.kind === "file") {
        this.assertPermission(entry, posix, READ_PERMISSION, access.path);
      } else if (entry.kind === "directory") {
        this.assertSubtreePermissions(
          access.path,
          posix,
          READ_PERMISSION,
          READ_PERMISSION | EXECUTE_PERMISSION
        );
      }
    } else {
      const parent = this.requireDirectory(dirname(access.path));
      this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, access.path);
      this.assertStickyRemoval(parent, entry, posix, access.path);
      if (operation.kind === "remove-recursive" && entry.kind === "directory") {
        this.assertSubtreePermissions(access.path, posix, 0, WRITE_PERMISSION | EXECUTE_PERMISSION);
        this.assertSubtreeSticky(access.path, posix);
      }
    }
    return entry.kind === "symlink" ? 1 : this.aggregateSubtree(access.path).entries;
  }
  changesSince(since, options = {}) {
    if (!this.recordChanges) {
      throw new VfsError("ENOTSUP", "the change cursor is not enabled for this filesystem");
    }
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new VfsError("EINVAL", "since must be a non-negative safe integer");
    }
    const limit = options.limit ?? DEFAULT_CHANGE_PAGE;
    validatePositiveInteger(limit, "limit");
    const bounded = Math.min(limit, MAX_CHANGE_PAGE);
    const rows = this.sql.exec(
      `WITH cutoff AS (
           SELECT (
             SELECT change_seq
             FROM vfs_path_changes
             WHERE change_seq > ?
             ORDER BY change_seq, path
             LIMIT 1 OFFSET ?
           ) AS seq
         )
       SELECT v.path AS path, v.present AS present, v.change_seq AS seq,
              EXISTS (
                SELECT 1 FROM vfs_path_changes remaining
                WHERE cutoff.seq IS NOT NULL AND remaining.change_seq > cutoff.seq
              ) AS more
       FROM vfs_path_changes v
       CROSS JOIN cutoff
       WHERE v.change_seq > ? AND (cutoff.seq IS NULL OR v.change_seq <= cutoff.seq)
       ORDER BY v.change_seq, v.path`,
      since,
      bounded - 1,
      since
    ).toArray();
    const changes = rows.map((row) => ({
      path: stringColumn(row, "path"),
      present: integerColumn(row, "present") === 1
    }));
    const last = rows.at(-1);
    return {
      changes,
      cursor: last === void 0 ? since : integerColumn(last, "seq"),
      more: last === void 0 ? false : integerColumn(last, "more") === 1
    };
  }
};

// src/vfs/sql-read-base.ts
var MIN_INLINE_SQL_RANGE_BYTES = 16 * 1024;
function sliceChunkSequence(chunks, offset, length) {
  const selected = [];
  let skip = offset;
  let remaining = length;
  for (const chunk of chunks) {
    if (skip >= chunk.byteLength) {
      skip -= chunk.byteLength;
      continue;
    }
    const take = Math.min(remaining, chunk.byteLength - skip);
    selected.push(chunk.subarray(skip, skip + take));
    remaining -= take;
    skip = 0;
    if (remaining === 0) break;
  }
  return selected;
}
var SqlRead = class extends SqlQuery {
  get availableWriteBufferBytes() {
    return this.inFlightBytes.remainingBytes;
  }
  async digestFile(path, posix) {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const { entry, cachedDigest } = this.digestEntry(access.row, normalized);
    if (entry.kind === "directory") {
      throw new VfsError("EISDIR", "is a directory", normalized);
    }
    this.assertPermission(entry, posix, READ_PERMISSION, normalized);
    if (entry.contentClass === "opaque") return this.opaqueDigest(entry, normalized);
    if (entry.contentClass !== "inline") {
      throw new VfsError("EIO", "invalid SQLite entry state", normalized);
    }
    if (cachedDigest !== null) return cachedDigest;
    return await this.computeInlineDigest(entry, normalized);
  }
  digestEntry(resolved, path) {
    if (resolved !== null) {
      const cachedDigest2 = resolved.contentClass === "inline" ? this.storedDigest(resolved.id) : null;
      return { entry: resolved, cachedDigest: cachedDigest2 };
    }
    const row = firstRow(
      this.sql.exec(
        `SELECT ${ENTRY_COLUMNS}, e.body_digest AS body_digest,
                e.body_digest_revision AS body_digest_revision
         FROM vfs_entries e WHERE e.path = ?`,
        path
      )
    );
    if (row === void 0) throw new VfsError("ENOENT", "no such file or directory", path);
    const entry = parseEntry(row, this.mutationEpoch);
    const digestRevision = nullableIntegerColumn(row, "body_digest_revision");
    const cachedDigest = digestRevision === entry.revision ? nullableStringColumn(row, "body_digest") : null;
    return { entry, cachedDigest };
  }
  opaqueDigest(entry, path) {
    const object = this.opaqueObject(entry.opaqueObjectId);
    if (object === null) throw new VfsError("EIO", "opaque object metadata is missing", path);
    if (object.verifiedSha256 === null) {
      throw new VfsError("ENOTSUP", "opaque digest is not verified", path);
    }
    return object.verifiedSha256;
  }
  async computeInlineDigest(entry, path) {
    const rows = this.sql.exec(
      `SELECT body FROM vfs_inline_chunks
         WHERE entry_id = ? ORDER BY chunk_index`,
      entry.id
    ).toArray();
    const chunks = rows.map((row) => new Uint8Array(blobColumn(row, "body")));
    const materializedBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (materializedBytes !== entry.sizeBytes) {
      throw new VfsError("EIO", "inline file size does not match stored chunks", path);
    }
    this.inFlightBytes.acquire(materializedBytes);
    let digest;
    try {
      digest = await sha256Hex(chunks, materializedBytes);
    } finally {
      this.inFlightBytes.release(materializedBytes);
    }
    this.sql.exec(
      `UPDATE vfs_entries
       SET body_digest = ?, body_digest_revision = revision
       WHERE id = ? AND revision = ? AND content_class = 'inline'`,
      digest,
      entry.id,
      entry.revision
    );
    return digest;
  }
  readFile(path, options = {}, posix) {
    const direct = posix === void 0 && options.range === void 0 && !pathRequiresDirectory(path) && !hasDotSegments(path) && this.links() === 0 ? this.directRead(path) : null;
    const access = direct?.access ?? this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const entry = access.row ?? this.requireEntry(normalized);
    if (entry.kind === "directory") {
      throw new VfsError("EISDIR", "is a directory", normalized);
    }
    this.assertPermission(entry, posix, READ_PERMISSION, normalized);
    if (entry.contentClass !== "inline") {
      throw new VfsError(
        "ENOTSUP",
        "opaque R2 content is not available to shell commands",
        normalized
      );
    }
    const selected = byteRangeBounds(options.range, entry.sizeBytes, normalized);
    const readWholeBody = options.range === void 0 || selected.offset === 0 && selected.length === entry.sizeBytes || entry.sizeBytes <= MIN_INLINE_SQL_RANGE_BYTES && entry.sizeBytes <= this.chunkBytes;
    const rows = direct?.body !== void 0 && direct.body.byteLength === entry.sizeBytes ? [{ body: direct.body }] : this.readInlineRows(entry, selected, readWholeBody, normalized);
    const materialized = rows.map((row) => new Uint8Array(blobColumn(row, "body")));
    const chunks = readWholeBody && options.range !== void 0 && selected.length < entry.sizeBytes ? sliceChunkSequence(materialized, selected.offset, selected.length) : materialized;
    const materializedBytes = materialized.reduce((total, chunk) => total + chunk.byteLength, 0);
    this.inFlightBytes.acquire(materializedBytes);
    if (access.followed.length === 0) this.lastInlineRead = entry;
    return {
      stat: rowToStat(entry),
      stream: streamFromOwnedChunks(chunks, () => {
        this.inFlightBytes.release(materializedBytes);
      })
    };
  }
  /** One snapshot statement for metadata and a small whole inline body. */
  directRead(path) {
    const normalized = normalizePath(path);
    const row = firstRow(
      this.sql.exec(
        `SELECT ${ENTRY_COLUMNS},
        CASE WHEN e.content_class = 'inline' AND e.size_bytes BETWEEN 1 AND ?
          THEN (SELECT body FROM vfs_inline_chunks
                WHERE entry_id = e.id AND chunk_index = 0
                  AND NOT EXISTS (SELECT 1 FROM vfs_inline_chunks tail
                                  WHERE tail.entry_id = e.id AND tail.chunk_index > 0))
          ELSE NULL END AS first_body
       FROM vfs_entries e INDEXED BY vfs_entries_path WHERE e.path = ?`,
        this.chunkBytes,
        normalized
      )
    );
    if (row === void 0) throw new VfsError("ENOENT", "no such file or directory", normalized);
    return {
      access: { path: normalized, row: parseEntry(row, this.mutationEpoch), followed: [] },
      body: row["first_body"] === null ? void 0 : blobColumn(row, "first_body")
    };
  }
  readInlineRows(entry, selected, readWholeBody, path) {
    if (selected.length === 0) return [];
    if (readWholeBody) {
      return this.sql.exec(
        `SELECT body FROM vfs_inline_chunks
           WHERE entry_id = ? ORDER BY chunk_index`,
        entry.id
      ).toArray();
    }
    const storedChunkBytes = this.storedChunkBytes(entry, path);
    return this.sql.exec(
      `SELECT substr(
             body,
             max(0, ? - chunk_index * ?) + 1,
             min(length(body), ? - chunk_index * ?) -
               max(0, ? - chunk_index * ?)
           ) AS body
           FROM vfs_inline_chunks
           WHERE entry_id = ? AND chunk_index BETWEEN ? AND ?
           ORDER BY chunk_index`,
      selected.offset,
      storedChunkBytes,
      selected.offset + selected.length,
      storedChunkBytes,
      selected.offset,
      storedChunkBytes,
      entry.id,
      Math.floor(selected.offset / storedChunkBytes),
      Math.floor((selected.offset + selected.length - 1) / storedChunkBytes)
    ).toArray();
  }
  storedChunkBytes(entry, path) {
    const cached = this.lastInlineChunkLayout;
    const chunkBytes = cached !== void 0 && cached.id === entry.id && cached.revision === entry.revision ? cached.chunkBytes : integerColumn(
      this.sql.exec(
        `SELECT length(body) AS chunk_bytes
                 FROM vfs_inline_chunks
                 WHERE entry_id = ? ORDER BY chunk_index LIMIT 1`,
        entry.id
      ).one(),
      "chunk_bytes"
    );
    if (chunkBytes === 0) {
      throw new VfsError("EIO", "inline file contains an empty stored chunk", path);
    }
    this.lastInlineChunkLayout = { id: entry.id, revision: entry.revision, chunkBytes };
    return chunkBytes;
  }
};

// src/vfs/sql-write-plan-base.ts
var SqlWritePlan = class extends SqlRead {
  opaqueObject(id) {
    const row = firstRow(
      this.sql.exec(
        `SELECT id, r2_key, size_bytes, etag, r2_version, verified_sha256,
              content_type, retain_until_ms
       FROM vfs_opaque_objects WHERE id = ?`,
        id
      )
    );
    return row === void 0 ? null : parseOpaqueObject(row);
  }
  upload(id) {
    const row = firstRow(
      this.sql.exec(
        `SELECT id, path, expected_mutation_token, r2_key, state,
              verification_token, expected_size_bytes, expires_at_ms,
              verification_lease_until_ms, create_parents, mode,
              content_type, receipt_json, written_path, traversal_token
       FROM vfs_upload_sessions WHERE id = ?`,
        id
      )
    );
    return row === void 0 ? null : parseUpload(row);
  }
  queueGarbage(objectKey, notBeforeMs) {
    this.sql.exec(
      `INSERT INTO vfs_gc_queue (
         r2_key, not_before_ms, attempts, next_attempt_at_ms, last_error
       ) VALUES (?, ?, 0, ?, NULL)
       ON CONFLICT(r2_key) DO UPDATE SET
         not_before_ms = MAX(vfs_gc_queue.not_before_ms, excluded.not_before_ms),
         next_attempt_at_ms = MAX(vfs_gc_queue.next_attempt_at_ms, excluded.not_before_ms)`,
      objectKey,
      notBeforeMs,
      notBeforeMs
    );
  }
  queueUploadGarbage(session, now) {
    this.queueGarbage(
      session.objectKey,
      Math.max(now, session.expiresAtMs + this.uploadSettlementGraceMs)
    );
  }
  queueObjectIfUnreferenced(objectId, now) {
    const object = firstRow(
      this.sql.exec(
        "DELETE FROM vfs_opaque_objects WHERE id=? AND NOT EXISTS(SELECT 1 FROM vfs_entries WHERE opaque_object_id=?) AND NOT EXISTS(SELECT 1 FROM vfs_detached_inodes WHERE opaque_object_id=?) RETURNING r2_key,retain_until_ms",
        objectId,
        objectId,
        objectId
      )
    );
    if (object === void 0) return false;
    this.queueGarbage(
      stringColumn(object, "r2_key"),
      Math.max(now, integerColumn(object, "retain_until_ms"))
    );
    return true;
  }
  /**
   * Deletes one entry and accounts for it; the caller publishes its logical operation.
   * The usage write is this method's
   * own, so a caller that replaces an entry adds only what it inserted --
   * subtracting the removal again double-counts it.
   */
  removeExact(path, now, advanceVersion = true, resolved, preserveInode = false) {
    const entry = resolved ?? this.oneEntry(path);
    if (entry === null) return 0;
    if (entry.kind === "directory") this.noteDirectoryDelta(entry.parentPath, -1);
    const retained = preserveInode ? 0 : this.retainOpenInodes?.(path, false, entry) ?? 0;
    if (entry.linkIdentity != null)
      this.sql.exec(
        "UPDATE vfs_entries SET unlinking = 1, changed_at_ms = ?, revision = revision + 1, mutation_version = mutation_version + 1 WHERE id = ?",
        now,
        entry.id
      );
    if (entry.contentClass === "inline") {
      this.sql.exec("DELETE FROM vfs_inline_chunks WHERE entry_id = ?", entry.id);
    }
    this.sql.exec("DELETE FROM vfs_entries WHERE id = ?", entry.id);
    if (entry.linkIdentity != null && !preserveInode)
      this.publishLinkedMetadata([entry.linkIdentity]);
    if (entry.kind === "symlink") this.symlinkCountStale = true;
    const mutationVersion = entry.mutationVersion + (advanceVersion ? 1 : 0);
    this.sql.exec(
      `INSERT INTO vfs_path_tombstones (path, version) VALUES (?, ?)
       ON CONFLICT(path) DO UPDATE SET version = MAX(version, excluded.version)`,
      path,
      mutationVersion
    );
    this.updateUsage((entry.contentClass === "inline" ? -entry.sizeBytes : 0) + retained, -1);
    if (entry.contentClass === "opaque" && entry.opaqueObjectId !== null && this.queueObjectIfUnreferenced(entry.opaqueObjectId, now))
      return 1;
    return 0;
  }
  /**
   * Arms the maintenance alarm without taking the object's alarm away from its
   * host.
   *
   * One Durable Object has one alarm, and the documented composition — this
   * filesystem held by a host class that owns `alarm()` — means the slot is
   * shared. There is no way to ask whether the alarm currently set is this
   * filesystem's own, so the rule is earliest-wins in both directions: an
   * existing alarm is never moved later, and no alarm is ever deleted.
   *
   * Deleting is the one that has to go even though it looks safe. Maintenance
   * work disappears while a host timer is pending far more often than the
   * reverse, and clearing it there stops a timer whose owner has no way to
   * discover that it stopped. What it costs instead is one spurious wake-up:
   * the alarm fires, finds nothing due, and re-arms to whatever is next.
   *
   * Leaving an earlier host alarm in place also means maintenance is not armed
   * until something re-arms it, which is why every exit from `drainGarbage()`
   * calls this. A host that owns `alarm()` must run maintenance from it, as
   * `VfsDurableObject` does and the README shows.
   */
  async scheduleGarbageAlarm() {
    const garbageDue = this.opaqueStore === void 0 ? "SELECT NULL AS due" : "SELECT MIN(MAX(not_before_ms, next_attempt_at_ms)) AS due FROM vfs_gc_queue";
    const row = this.sql.exec(
      `SELECT MIN(due) AS due FROM (
         ${garbageDue}
         UNION ALL
         SELECT MIN(expires_at_ms) AS due FROM vfs_upload_sessions WHERE state = 'open'
         UNION ALL
         SELECT MIN(verification_lease_until_ms) AS due
         FROM vfs_upload_sessions INDEXED BY vfs_upload_verification_expiry WHERE state = 'verifying'
         UNION ALL
         SELECT MIN(expires_at_ms) AS due FROM vfs_upload_sessions WHERE state = 'committed'
       )`
    ).one();
    const due = nullableIntegerColumn(row, "due");
    if (due === null) return;
    const current = await this.storage.getAlarm();
    if (current === null || due < current) await this.storage.setAlarm(due);
  }
  /**
   * Everything a write can decide before it holds any bytes.
   *
   * Split out so that a batch is refused for a bad disposition, a stale guard,
   * or a permission on its twelfth entry without having buffered its first,
   * and so that both forms decide those questions in one place rather than
   * two. `entry` carries what describes the file and `options` what describes
   * the call; a single write passes its options as both, which is exactly the
   * split a batch makes explicit.
   */
  planInlineWrite(path, entry, options, posix, snapshot) {
    const access = snapshot === void 0 ? this.resolveAccess(path) : { path: snapshot.path, row: snapshot, followed: [] };
    const normalized = access.path;
    const state = access.row === null ? this.pathState(normalized) : { entry: access.row, mutationToken: access.row.mutationToken };
    const before = state.entry;
    const createParents = options.createParents ?? false;
    this.assertWriteAccess(normalized, before, createParents, access.followed, posix);
    const disposition = options.disposition ?? "upsert";
    if (disposition === "create" && before !== null) {
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    if (disposition === "replace" && before === null) {
      throw new VfsError("ENOENT", "no such file", normalized);
    }
    if (before?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    this.validateGuard(normalized, before, entry, path);
    return {
      written: path,
      path: normalized,
      followed: access.followed,
      createParents,
      disposition,
      skipIfUnchanged: options.skipIfUnchanged === true,
      mode: entry.mode,
      guard: entry,
      capturedToken: state.mutationToken,
      capturedEntry: before,
      ...snapshot === void 0 ? {} : { conditionalMutationVersion: snapshot.mutationVersion }
    };
  }
  /**
   * Publishes one collected body, inside a transaction the caller already owns.
   *
   * Split out of `writeFile` so that `writeFiles` commits this same step once
   * per entry rather than a second implementation of it. That is what makes
   * "a batch costs a single write nothing" structural rather than a promise:
   * the single-path form runs this code, so its statement, row-read, and
   * row-written counts cannot move because a batch exists.
   *
   * A single write validates its own growth before the insert it guards.
   * A batch checks cached usage after all files and parents are created,
   * weighing the whole set once, which is a
   * different answer rather than a cheaper one -- see `assertCapacityFrom`.
   * Ordering inside the transaction is free either way: whichever entry is
   * refused, every one of them rolls back.
   */
  commitInlineWrite(plan, chunks, sizeBytes, digest, now, posix, deferCapacity = false, revalidate = true) {
    let current = plan.capturedEntry;
    if (revalidate) {
      const state2 = this.pathState(plan.path);
      if (state2.mutationToken !== plan.capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", plan.path);
      }
      this.validateGuard(plan.path, state2.entry, plan.guard, plan.written);
      current = state2.entry;
    }
    if (current?.kind === "directory") throw new VfsError("EISDIR", "is a directory", plan.path);
    const parent = current === null && (posix !== void 0 || dirname(plan.path) !== "/") ? this.prepareParents(plan.path, plan.createParents, now, plan.followed, posix) : void 0;
    if (current !== null && revalidate) {
      this.assertWriteAccess(plan.path, current, false, plan.followed, posix);
    }
    const state = { current, parent };
    const unchanged = this.unchangedInlineWrite(plan, current, chunks, sizeBytes, digest);
    if (unchanged !== null) return unchanged;
    const mutation = this.inlineMutationPlan(plan, state, sizeBytes, posix, deferCapacity);
    const written = this.writeInlineEntry(plan, current, mutation, sizeBytes, digest, now);
    if (written === void 0) {
      this.planInlineWrite(
        plan.written,
        plan.guard,
        {
          createParents: plan.createParents,
          disposition: plan.disposition,
          skipIfUnchanged: plan.skipIfUnchanged
        },
        posix
      );
      throw new VfsError("EREVISION", "path changed after it was read", plan.path);
    }
    if (current?.contentClass === "inline") {
      const lastChunk = nullableIntegerColumn(written, "last_chunk_index");
      if (lastChunk !== null && lastChunk >= chunks.length)
        this.sql.exec(
          "DELETE FROM vfs_inline_chunks WHERE entry_id = ? AND chunk_index >= ?",
          current.id,
          chunks.length
        );
    }
    return this.finishInlineWrite(plan, current, mutation, written, chunks, sizeBytes, now);
  }
  /** Returns only after all failures that an unchanged write must still expose. */
  unchangedInlineWrite(plan, current, chunks, sizeBytes, digest) {
    if (!plan.skipIfUnchanged || current?.contentClass !== "inline") return null;
    if (current.sizeBytes !== sizeBytes) return null;
    if (plan.mode !== void 0 && plan.mode !== current.mode) return null;
    if (!this.bodyIsUnchanged(current.id, current.revision, chunks, digest)) return null;
    return {
      result: {
        path: plan.path,
        revision: current.revision,
        mutationToken: plan.capturedToken,
        sizeBytes,
        created: false
      },
      queuedGarbage: false
    };
  }
  inlineMutationPlan(plan, state, sizeBytes, posix, deferCapacity) {
    const { current, parent } = state;
    const owner = current !== null ? { uid: current.uid, gid: current.gid } : posix === void 0 ? { uid: 0, gid: 0 } : this.creationOwner(parent ?? this.requireDirectory(dirname(plan.path)), posix);
    const mode = this.inlineWriteMode(plan, current, parent, posix);
    const previousInlineBytes = current?.contentClass === "inline" ? current.sizeBytes : 0;
    const inlineDelta = (sizeBytes - previousInlineBytes) * (current?.linkCount ?? 1);
    const entryDelta = current === null ? 1 : 0;
    if (!deferCapacity) this.assertCapacity(inlineDelta, entryDelta, plan.path);
    const mutationVersion = current === null ? this.nextEntryVersion(plan.path) : current.mutationVersion + 1;
    return { owner, mode, inlineDelta, entryDelta, mutationVersion };
  }
  inlineWriteMode(plan, current, parent, posix) {
    if (current !== null) return posix === void 0 ? plan.mode ?? current.mode : current.mode;
    if (posix === void 0) return plan.mode ?? FILE_MODE;
    return this.creationMode(
      plan.mode ?? FILE_MODE,
      posix,
      parent ?? this.requireDirectory(dirname(plan.path)),
      false
    );
  }
  writeInlineEntry(plan, current, mutation, sizeBytes, digest, now) {
    if (current?.contentClass === "inline") {
      return firstRow(
        this.sql.exec(
          `UPDATE vfs_entries SET
             size_bytes = ?, mode = ?, modified_at_ms = ?, changed_at_ms = ?, revision = revision + 1,
             body_digest = ?, body_digest_revision = revision + 1, mutation_version = ?
           WHERE id = ? AND mutation_version = ?
           RETURNING id, revision,
             (SELECT MAX(chunk_index) FROM vfs_inline_chunks
              WHERE entry_id = vfs_entries.id) AS last_chunk_index`,
          sizeBytes,
          mutation.mode,
          now,
          now,
          digest ?? null,
          mutation.mutationVersion,
          current.id,
          plan.conditionalMutationVersion ?? current.mutationVersion
        )
      );
    }
    return this.sql.exec(
      `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           body_digest, body_digest_revision, mutation_version
         ) VALUES (?, ?, ?, ?, 'file', 'inline', NULL, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'inline', opaque_object_id = NULL,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms, changed_at_ms = excluded.modified_at_ms,
           revision = vfs_entries.revision + 1,
           body_digest = excluded.body_digest,
           body_digest_revision = vfs_entries.revision + 1,
           mutation_version = excluded.mutation_version
         RETURNING id, revision`,
      current?.id ?? this.allocateIno(),
      plan.path,
      dirname(plan.path),
      basename(plan.path),
      sizeBytes,
      mutation.mode,
      mutation.owner.uid,
      mutation.owner.gid,
      current?.createdAtMs ?? now,
      now,
      digest ?? null,
      mutation.mutationVersion
    ).one();
  }
  finishInlineWrite(plan, current, mutation, written, chunks, sizeBytes, now) {
    const token = this.publishToken(
      plan.path,
      mutation.mutationVersion,
      true,
      current === null ? "create" : "write",
      current
    );
    this.writeChunks(
      integerColumn(written, "id"),
      0,
      chunks,
      current?.contentClass === "inline" && current.sizeBytes > 0 && current.sizeBytes <= this.chunkBytes
    );
    this.updateUsage(mutation.inlineDelta, mutation.entryDelta);
    const queuedGarbage = current?.contentClass === "opaque" && current.opaqueObjectId !== null && this.queueObjectIfUnreferenced(current.opaqueObjectId, now);
    return {
      result: {
        path: plan.path,
        revision: integerColumn(written, "revision"),
        mutationToken: token,
        sizeBytes,
        created: current === null
      },
      queuedGarbage
    };
  }
  /** Publishes a collected set with one transaction and one aggregate quota decision. */
  commitInlineWriteSet(collected, posix) {
    let queuedGarbage = false;
    const results = this.useBufferedSet(
      collected,
      () => this.transaction(
        () => this.withDeferredUsage(() => {
          const before = this.usage();
          this.assertCapacityFrom(before, 0, 0);
          const now = this.now();
          const written = [];
          for (const item of collected) {
            const outcome = this.commitInlineWrite(
              item.plan,
              item.lease.chunks,
              item.lease.sizeBytes,
              item.digest,
              now,
              posix,
              true
            );
            if (outcome.queuedGarbage) queuedGarbage = true;
            written.push(outcome.result);
          }
          const after = this.usage();
          this.assertCapacityFrom(
            before,
            after.inlineBytes - before.inlineBytes,
            after.entries - before.entries
          );
          return written;
        }),
        posix !== void 0 && collected.every(({ plan }) => !plan.createParents || plan.capturedEntry !== null)
      )
    );
    return { results, queuedGarbage };
  }
};

// src/vfs/sql-write-base.ts
function matchesChunkTail(sizeBytes, width, index, tailBytes) {
  const expectedIndex = Math.floor((sizeBytes - 1) / width);
  return sizeBytes > 0 && index === expectedIndex && tailBytes === sizeBytes - expectedIndex * width;
}
var SqlWrite = class extends SqlWritePlan {
  /** Uses the same write planner as publication without changing storage. Returns the effective mode. */
  validateInlineWrite(path, options = {}, sizeBytes, additionalInlineBytes = 0, posix) {
    const plan = this.planInlineWrite(path, options, options, posix);
    const before = plan.capturedEntry;
    if (before?.contentClass !== "inline")
      throw new VfsError("ENOTSUP", "deferred writes require an existing inline file", path);
    if (sizeBytes !== void 0) {
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || !Number.isSafeInteger(additionalInlineBytes) || additionalInlineBytes < 0)
        throw new VfsError("EINVAL", "invalid deferred write size", path);
      this.assertAppendSize(before, path, sizeBytes);
      this.assertCapacity(sizeBytes - before.sizeBytes + additionalInlineBytes, 0, path);
    }
    return posix === void 0 ? options.mode ?? before.mode : before.mode;
  }
  async writeFile(path, body, options = {}, posix) {
    const materialized = options.skipIfUnchanged !== true && typeof body === "string";
    const snapshot = materialized && posix === void 0 && options.disposition !== "create" && !pathRequiresDirectory(path) && options.ifMutationToken !== void 0 && options.ifMutationToken === this.lastInlineRead?.mutationToken && normalizePath(path) === this.lastInlineRead.path ? this.lastInlineRead : void 0;
    const plan = this.planInlineWrite(path, options, options, posix, snapshot);
    const buffered = typeof body === "string" ? this.collectInlineSync(body) : await this.collectInline(body);
    const digest = materialized ? void 0 : await this.incomingDigest(options, buffered);
    let queued = false;
    const result = this.useBuffered(
      buffered,
      (chunks, sizeBytes) => this.transaction(
        () => {
          const outcome = this.commitInlineWrite(
            plan,
            chunks,
            sizeBytes,
            digest,
            this.now(),
            posix,
            false,
            !materialized
          );
          queued = outcome.queuedGarbage;
          return outcome.result;
        },
        posix !== void 0 && (!plan.createParents || plan.capturedEntry !== null)
      )
    );
    if (queued) await this.scheduleGarbageAlarm();
    return result;
  }
  /**
   * Writes several bodies to several paths as one change.
   *
   * The three phases are the whole design, and the order is what makes it
   * possible at all. Every entry is planned against SQLite synchronously, so
   * a batch that cannot succeed is refused before it holds a byte. Then every
   * body is collected; strings need no async boundary, while other bodies and
   * digests may yield. Entry accessors can still run caller code, so the set is
   * revalidated inside the transaction that publishes it. No cursor crosses
   * an await.
   *
   * An open transaction handed back to the host would be the other way to
   * offer this, and it is the reason this shape exists instead: it would hold
   * the storage lock across arbitrary caller code. What survives that
   * constraint is collect, then commit.
   */
  async writeFiles(entries, options = {}, posix) {
    if (entries.length === 0) return [];
    const plans = [];
    const claimed = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      const plan = this.planInlineWrite(entry.path, entry, options, posix);
      if (claimed.has(plan.path)) {
        throw new VfsError("EINVAL", "the batch names this path more than once", plan.path);
      }
      claimed.add(plan.path);
      plans.push(plan);
    }
    const collected = [];
    let held = 0;
    try {
      for (const [index, entry] of entries.entries()) {
        const plan = plans[index];
        if (plan === void 0) break;
        const body = entry.body;
        const lease = typeof body === "string" ? this.collectInlineSync(body, held) : await this.collectInline(body, held);
        held += lease.sizeBytes;
        const item = { plan, lease, digest: void 0 };
        collected.push(item);
        if (options.skipIfUnchanged === true) {
          collected[collected.length - 1] = {
            ...item,
            digest: await this.incomingDigest(options, lease)
          };
        }
      }
    } catch (error) {
      for (const item of collected) item.lease.release();
      throw error;
    }
    const committed = this.commitInlineWriteSet(collected, posix);
    if (committed.queuedGarbage) await this.scheduleGarbageAlarm();
    return committed.results;
  }
  async appendFile(path, body, options = {}, posix) {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    const before = this.requireInline(normalized, access.row);
    this.assertPermission(before, posix, WRITE_PERMISSION, normalized);
    this.validateGuard(normalized, before, options, path);
    const capturedToken = before.mutationToken;
    const materialized = typeof body === "string";
    const buffered = materialized ? this.collectInlineSync(body) : await this.collectInline(body);
    return this.useBuffered(
      buffered,
      (chunks, bytes2) => this.commitAppend(
        normalized,
        path,
        access.followed,
        capturedToken,
        chunks,
        bytes2,
        options,
        posix,
        materialized ? before : void 0
      )
    );
  }
  commitAppend(path, writtenPath, followed, capturedToken, suffixChunks, suffixBytes, options, posix, snapshot) {
    return this.transaction(() => {
      const current = snapshot === void 0 || suffixBytes === 0 ? this.requireInline(path) : snapshot;
      if (current.mutationToken !== capturedToken) {
        throw new VfsError("EREVISION", "path changed while the body was streaming", path);
      }
      this.validateGuard(path, current, options, writtenPath);
      this.assertTraverse(path, followed, posix);
      this.assertPermission(current, posix, WRITE_PERMISSION, path);
      if (suffixBytes === 0) {
        return {
          path,
          revision: current.revision,
          mutationToken: capturedToken,
          sizeBytes: current.sizeBytes,
          created: false
        };
      }
      return this.appendContent(current, path, suffixChunks, suffixBytes, snapshot !== void 0);
    }, posix !== void 0);
  }
  appendContent(current, path, suffixChunks, suffixBytes, conditional) {
    const sizeBytes = current.sizeBytes + suffixBytes;
    this.assertAppendSize(current, path, sizeBytes);
    this.assertCapacity(suffixBytes * (current.linkCount ?? 1), 0, path);
    const plan = this.appendChunkPlan(current, path, suffixChunks);
    const now = this.now();
    const mutationVersion = current.mutationVersion + 1;
    const written = this.sql.exec(
      `UPDATE vfs_entries SET size_bytes = ?, modified_at_ms = ?, changed_at_ms = ?, revision = revision + 1,
         mutation_version = ? WHERE id = ? ${conditional ? "AND mutation_version = ? RETURNING id" : ""}`,
      sizeBytes,
      now,
      now,
      mutationVersion,
      current.id,
      ...conditional ? [current.mutationVersion] : []
    );
    if (conditional && firstRow(written) === void 0)
      throw new VfsError("EREVISION", "path changed before append", path);
    if (plan.tailSuffix !== void 0)
      this.sql.exec(
        "UPDATE vfs_inline_chunks SET body = CAST(body || ? AS BLOB) WHERE entry_id = ? AND chunk_index = ?",
        plan.tailSuffix,
        current.id,
        plan.firstChunkIndex
      );
    else this.writeChunks(current.id, plan.firstChunkIndex, plan.chunks);
    const token = this.publishToken(path, mutationVersion, true, "write", current);
    this.updateUsage(suffixBytes * (current.linkCount ?? 1), 0);
    return {
      path,
      revision: current.revision + 1,
      mutationToken: token,
      sizeBytes,
      created: false
    };
  }
  assertAppendSize(current, path, sizeBytes) {
    if (sizeBytes <= this.maxInlineFileBytes) return;
    emitVfsEvent(this.onEvent, {
      type: "vfs.quota",
      limit: "maxInlineFileBytes",
      requested: sizeBytes,
      used: current.sizeBytes,
      max: this.maxInlineFileBytes,
      path
    });
    throw new VfsError(
      "EFBIG",
      `inline content exceeds the ${this.maxInlineFileBytes}-byte limit`,
      path
    );
  }
  appendChunkPlan(current, path, suffixChunks) {
    const suffix = suffixChunks[0];
    const compact = current.sizeBytes > 0 && suffixChunks.length === 1 && suffix !== void 0 && current.sizeBytes + suffix.byteLength <= this.chunkBytes;
    const lastChunk = firstRow(
      this.sql.exec(
        `SELECT chunk_index, ${compact ? "length(body) AS tail_bytes" : "body"} FROM vfs_inline_chunks
         WHERE entry_id = ? ORDER BY chunk_index DESC LIMIT 1`,
        current.id
      )
    );
    if (lastChunk === void 0) {
      if (current.sizeBytes !== 0) {
        throw new VfsError("EIO", "inline file is missing stored chunks", path);
      }
      return { firstChunkIndex: 0, chunks: suffixChunks };
    }
    const index = integerColumn(lastChunk, "chunk_index");
    if (compact && index === 0 && integerColumn(lastChunk, "tail_bytes") === current.sizeBytes)
      return { firstChunkIndex: 0, chunks: [], tailSuffix: suffix };
    if (compact) {
      return this.appendStoredChunks(current, path, suffixChunks);
    }
    return this.appendTail(current, path, suffixChunks, lastChunk);
  }
  appendStoredChunks(current, path, suffixChunks) {
    const lastChunk = this.sql.exec(
      `SELECT chunk_index, body FROM vfs_inline_chunks
      WHERE entry_id = ? ORDER BY chunk_index DESC LIMIT 1`,
      current.id
    ).one();
    return this.appendTail(current, path, suffixChunks, lastChunk);
  }
  appendTail(current, path, suffixChunks, lastChunk) {
    const index = integerColumn(lastChunk, "chunk_index");
    const tail = new Uint8Array(blobColumn(lastChunk, "body"));
    let width = this.chunkBytes;
    if (!matchesChunkTail(current.sizeBytes, width, index, tail.byteLength)) {
      width = this.storedChunkBytes(current, path);
      if (!matchesChunkTail(current.sizeBytes, width, index, tail.byteLength))
        throw new VfsError("EIO", "inline file chunks do not match its size", path);
    }
    return tail.byteLength === width ? {
      firstChunkIndex: index + 1,
      chunks: width === this.chunkBytes ? suffixChunks : rechunk(suffixChunks, width)
    } : { firstChunkIndex: index, chunks: rechunk([tail, ...suffixChunks], width) };
  }
};

// src/vfs/sql-metadata-base.ts
var SqlMetadata = class extends SqlWrite {
  setMetadata(path, options, posix, writtenFollowed = [], written = path) {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    const followed = writtenFollowed.length === 0 ? access.followed : [...writtenFollowed, ...access.followed];
    this.assertTraverse(normalized, followed, posix);
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      this.assertTraverse(normalized, followed, posix);
      if (options.mode !== void 0) this.assertOwner(entry, posix, normalized);
      else if (posix !== void 0 && posix.credentials.uid !== entry.uid) {
        this.assertPermission(entry, posix, WRITE_PERMISSION, normalized);
      }
      this.validateGuard(normalized, entry, options, written);
      const mutationVersion = entry.mutationVersion + 1;
      const changedAtMs = this.now();
      const modifiedAtMs = options.modifiedAtMs ?? (options.mode === void 0 ? changedAtMs : entry.modifiedAtMs);
      this.sql.exec(
        `UPDATE vfs_entries SET mode = ?, modified_at_ms = ?, changed_at_ms = ?, revision = revision + 1,
           mutation_version = ?
         WHERE id = ?`,
        options.mode ?? entry.mode,
        modifiedAtMs,
        changedAtMs,
        mutationVersion,
        entry.id
      );
      const token = this.publishToken(normalized, mutationVersion, true, "metadata", entry);
      return rowToStat({
        ...entry,
        mode: options.mode ?? entry.mode,
        modifiedAtMs,
        changedAtMs,
        revision: entry.revision + 1,
        mutationVersion,
        mutationToken: token
      });
    });
  }
  setOwnership(path, options, posix) {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    this.assertTraverse(normalized, access.followed, posix);
    if (options.uid === void 0 && options.gid === void 0) {
      throw new VfsError("EINVAL", "setOwnership requires uid or gid", normalized);
    }
    const uid = options.uid === void 0 ? void 0 : posixId(options.uid, "options.uid");
    const gid = options.gid === void 0 ? void 0 : posixId(options.gid, "options.gid");
    return this.transaction(
      () => this.commitOwnership(normalized, access.followed, options, uid, gid, posix, path)
    );
  }
  commitOwnership(path, followed, options, uid, gid, posix, written) {
    const entry = this.requireEntry(path);
    this.assertTraverse(path, followed, posix);
    if (posix !== void 0 && posix.credentials.uid !== 0) {
      if (uid !== void 0 && uid !== entry.uid) {
        throw new VfsError("EPERM", "only root may change a file owner", path);
      }
      this.assertOwner(entry, posix, path);
      if (gid !== void 0 && !posix.groups.has(gid)) {
        throw new VfsError("EPERM", "group is not in the current user's groups", path);
      }
    }
    this.validateGuard(path, entry, options, written);
    const mutationVersion = entry.mutationVersion + 1;
    const changedAtMs = this.now();
    const modifiedAtMs = entry.modifiedAtMs;
    const mode = posix !== void 0 && posix.credentials.uid !== 0 && (uid !== void 0 || gid !== void 0) ? entry.mode & ~3072 : entry.mode;
    this.sql.exec(
      `UPDATE vfs_entries
       SET uid = ?, gid = ?, mode = ?, modified_at_ms = ?, changed_at_ms = ?, revision = revision + 1,
           mutation_version = ? WHERE id = ?`,
      uid ?? entry.uid,
      gid ?? entry.gid,
      mode,
      modifiedAtMs,
      changedAtMs,
      mutationVersion,
      entry.id
    );
    const token = this.publishToken(path, mutationVersion, true, "metadata", entry);
    return rowToStat({
      ...entry,
      uid: uid ?? entry.uid,
      gid: gid ?? entry.gid,
      mode,
      modifiedAtMs,
      changedAtMs,
      revision: entry.revision + 1,
      mutationVersion,
      mutationToken: token
    });
  }
  touch(path, options = {}, posix) {
    const access = this.resolveAccess(path);
    const normalized = access.path;
    const existing = access.row ?? this.oneEntry(normalized);
    if (existing !== null) {
      return this.setMetadata(normalized, options, posix, access.followed, path);
    }
    if (options.create === false) {
      throw new VfsError("ENOENT", "no such file or directory", normalized);
    }
    return this.transaction(
      () => this.createTouchedFile(normalized, access.followed, options, posix, path)
    );
  }
  createTouchedFile(path, followed, options, posix, written) {
    const parents = posix === void 0 ? void 0 : this.creationParents(path, options.createParents ?? false);
    if (parents !== void 0) this.assertCreationAccess(path, followed, posix, parents.existing);
    this.validateGuard(path, null, options, written);
    const now = this.now();
    const parent = parents === void 0 ? this.prepareParents(path, options.createParents ?? false, now, followed, posix) : this.createMissingParents(path, now, posix, parents);
    const owner = posix === void 0 ? { uid: 0, gid: 0 } : this.creationOwner(parent, posix);
    const mode = posix === void 0 ? options.mode ?? FILE_MODE : this.creationMode(options.mode ?? FILE_MODE, posix, parent, false);
    this.assertCapacity(0, 1, path);
    const mutationVersion = this.nextEntryVersion(path);
    const inserted = this.sql.exec(
      `INSERT INTO vfs_entries (
         id, path, parent_path, name, kind, content_class, opaque_object_id,
         size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
         mutation_version, changed_at_ms
       ) VALUES (?, ?, ?, ?, 'file', 'inline', NULL, 0, ?, ?, ?, ?, ?, 1, ?, ?)
       RETURNING id`,
      this.allocateIno(),
      path,
      dirname(path),
      basename(path),
      mode,
      owner.uid,
      owner.gid,
      now,
      options.modifiedAtMs ?? now,
      mutationVersion,
      now
    ).one();
    const token = this.publishToken(path, mutationVersion, true, "create");
    this.updateUsage(0, 1);
    return {
      path,
      parentPath: dirname(path),
      name: basename(path),
      ino: integerColumn(inserted, "id"),
      kind: "file",
      contentClass: "inline",
      sizeBytes: 0,
      mode,
      uid: owner.uid,
      gid: owner.gid,
      createdAtMs: now,
      modifiedAtMs: options.modifiedAtMs ?? now,
      changedAtMs: now,
      revision: 1,
      mutationToken: token
    };
  }
  mkdir(path, recursive = false, mode = DIRECTORY_MODE, posix) {
    const access = this.resolveAccess(path, true, false);
    const normalized = access.path;
    const existing = access.row ?? this.oneEntry(normalized);
    if (existing !== null) {
      this.assertTraverse(normalized, access.followed, posix);
      if (recursive && existing.kind === "directory") {
        this.assertPermission(existing, posix, EXECUTE_PERMISSION, normalized);
        return rowToStat(existing);
      }
      throw new VfsError("EEXIST", "file or directory already exists", normalized);
    }
    return this.transaction(() => {
      const now = this.now();
      const parent = this.prepareParents(normalized, recursive, now, access.followed, posix);
      this.assertCapacity(0, 1, normalized);
      return rowToStat(this.createDirectory(normalized, now, mode, posix, false, parent));
    });
  }
  symlink(path, target, options = {}, posix) {
    const access = this.resolveAccess(path, false, false);
    const normalized = access.path;
    const parentPath = dirname(normalized);
    const name = basename(normalized);
    if (normalized === "/") throw new VfsError("EEXIST", "file or directory exists", normalized);
    if (target.length === 0) throw new VfsError("EINVAL", "link target is empty", normalized);
    const bytes2 = utf8ByteLength(target);
    if (bytes2 > MAX_SYMLINK_TARGET_BYTES) {
      throw new VfsError("ENAMETOOLONG", "link target is too long", normalized);
    }
    return this.transaction(
      () => this.commitSymlink(
        normalized,
        parentPath,
        name,
        target,
        bytes2,
        options,
        posix,
        access.followed,
        access.row
      )
    );
  }
  commitSymlink(path, parentPath, name, target, bytes2, options, posix, followed, resolved) {
    const existing = resolved ?? this.oneEntry(path);
    if (existing !== null) {
      if (!(options.replace ?? false)) {
        throw new VfsError("EEXIST", "file or directory exists", path);
      }
      if (existing.kind === "directory") {
        throw new VfsError("EISDIR", "is a directory", path);
      }
    }
    this.validateGuard(path, existing, {
      ...options.ifMutationToken === void 0 ? {} : { ifMutationToken: options.ifMutationToken }
    });
    const now = this.now();
    const parent = this.prepareParents(path, options.createParents ?? false, now, followed, posix);
    if (existing !== null && posix !== void 0) {
      this.assertStickyRemoval(parent, existing, posix, path);
    }
    if (existing !== null) this.removeExact(path, now, false);
    const owner = posix === void 0 ? { uid: 0, gid: 0 } : this.creationOwner(parent, posix);
    const revision = (existing?.revision ?? 0) + 1;
    const mutationVersion = this.nextEntryVersion(path, existing?.mutationVersion);
    this.assertCapacity(0, 1, path);
    const inserted = this.sql.exec(
      `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           mutation_version
        ) VALUES (?, ?, ?, ?, 'symlink', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      this.allocateIno(),
      path,
      parentPath,
      name,
      target,
      bytes2,
      SYMLINK_MODE,
      owner.uid,
      owner.gid,
      now,
      now,
      revision,
      mutationVersion
    ).one();
    this.updateUsage(0, 1);
    const token = this.publishToken(
      path,
      mutationVersion,
      true,
      existing === null ? "create" : "write"
    );
    this.symlinkCount += 1;
    return rowToStat({
      id: integerColumn(inserted, "id"),
      path,
      parentPath,
      name,
      kind: "symlink",
      contentClass: null,
      opaqueObjectId: null,
      linkTarget: target,
      sizeBytes: bytes2,
      mode: SYMLINK_MODE,
      uid: owner.uid,
      gid: owner.gid,
      createdAtMs: now,
      modifiedAtMs: now,
      changedAtMs: now,
      revision,
      mutationVersion,
      mutationToken: token
    });
  }
};

// src/vfs/sql-move-base.ts
var SqlMove = class extends SqlMetadata {
  async remove(path, options = {}, posix) {
    const access = this.resolveAccess(path, false, false);
    const normalized = access.path;
    if (normalized === "/") throw new VfsError("EINVAL", "cannot remove root", normalized);
    const root = access.row ?? this.requireEntry(normalized, false);
    const state = { queued: 0 };
    const result = this.transaction(
      () => this.commitRemove(normalized, root, access.followed, options, posix, state),
      posix !== void 0 && root.kind === "file"
    );
    if (state.queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }
  commitRemove(path, resolved, followed, options, posix, state) {
    const root = resolved ?? this.requireEntry(path, false);
    this.assertTraverse(path, followed, posix);
    if (posix !== void 0) {
      const parent = this.requireDirectory(dirname(path));
      this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, path);
      this.assertStickyRemoval(parent, root, posix, path);
    }
    if (root.kind !== "directory") return this.removeSingle(path, root, state);
    const range = descendantRange(path);
    const recursive = options.recursive ?? false;
    if (!recursive) {
      const hasDescendants = firstRow(
        this.sql.exec(
          `SELECT 1 AS present FROM vfs_entries
           WHERE path >= ? AND path < ? LIMIT 1`,
          range.lower,
          range.upper
        )
      );
      if (hasDescendants !== void 0) {
        throw new VfsError("ENOTEMPTY", "directory is not empty", path);
      }
      return this.removeSingle(path, root, state);
    }
    if (recursive) {
      this.assertSubtreePermissions(path, posix, 0, WRITE_PERMISSION | EXECUTE_PERMISSION);
      this.assertSubtreeSticky(path, posix);
    }
    const summary = recursive ? this.aggregateSubtree(path) : { entries: 1, inlineBytes: 0 };
    const now = this.now();
    const retained = this.retainOpenInodes?.(path, recursive, root) ?? 0;
    const identities = this.linkedIdentities(path, range);
    this.markUnlinking(path, range, now);
    this.publishSubtreeRemoval(path);
    this.sql.exec(
      `INSERT INTO vfs_gc_queue (
         r2_key, not_before_ms, attempts, next_attempt_at_ms, last_error
       )
       SELECT o.r2_key, MAX(?, o.retain_until_ms), 0,
              MAX(?, o.retain_until_ms), NULL
       FROM vfs_opaque_objects o
       WHERE EXISTS (
         SELECT 1 FROM vfs_entries removed
         WHERE removed.opaque_object_id = o.id
           AND (removed.path = ? OR (removed.path >= ? AND removed.path < ?))
       )
       AND NOT EXISTS (
         SELECT 1 FROM vfs_entries retained
         WHERE retained.opaque_object_id = o.id
           AND NOT (retained.path = ? OR (retained.path >= ? AND retained.path < ?))
       )
       AND NOT EXISTS (SELECT 1 FROM vfs_detached_inodes d WHERE d.opaque_object_id = o.id)
       ON CONFLICT(r2_key) DO UPDATE SET
         not_before_ms = MAX(vfs_gc_queue.not_before_ms, excluded.not_before_ms),
         next_attempt_at_ms = MAX(
           vfs_gc_queue.next_attempt_at_ms,
           excluded.not_before_ms
         )`,
      now,
      now,
      path,
      range.lower,
      range.upper,
      path,
      range.lower,
      range.upper
    );
    state.queued = integerColumn(this.sql.exec("SELECT changes() AS value").one(), "value");
    this.sql.exec(
      `DELETE FROM vfs_inline_chunks
       WHERE entry_id IN (
         SELECT id FROM vfs_entries
         WHERE path = ? OR (path >= ? AND path < ?)
       )`,
      path,
      range.lower,
      range.upper
    );
    this.sql.exec(
      `DELETE FROM vfs_entries
       WHERE path = ? OR (path >= ? AND path < ?)`,
      path,
      range.lower,
      range.upper
    );
    this.publishLinkedMetadata(identities);
    this.symlinkCountStale = true;
    this.sql.exec(
      `DELETE FROM vfs_opaque_objects
       WHERE NOT EXISTS (
         SELECT 1 FROM vfs_entries
         WHERE opaque_object_id = vfs_opaque_objects.id
       )
       AND NOT EXISTS (SELECT 1 FROM vfs_detached_inodes d WHERE d.opaque_object_id = vfs_opaque_objects.id)
       AND EXISTS (
         SELECT 1 FROM vfs_gc_queue
         WHERE r2_key = vfs_opaque_objects.r2_key
       )`
    );
    this.updateUsage(-summary.inlineBytes + retained, -summary.entries);
    this.noteDirectoryChange(root);
    this.recordMutation(
      summary.entries > 1 ? { op: "remove", path, subtree: { root: path } } : { op: "remove", path }
    );
    return {
      removed: summary.entries,
      opaqueObjectsQueuedForDeletion: state.queued
    };
  }
  removeSingle(path, root, state) {
    state.queued = this.removeExact(path, this.now(), true, root);
    this.recordPathChange(path, false);
    this.recordMutation({ op: "remove", path });
    return { removed: 1, opaqueObjectsQueuedForDeletion: state.queued };
  }
  linkedIdentities(path, range) {
    if (!this.sharedInodes) return [];
    return this.sql.exec(
      "SELECT DISTINCT link_identity FROM vfs_entries WHERE link_identity IS NOT NULL AND (path = ? OR (path >= ? AND path < ?))",
      path,
      range.lower,
      range.upper
    ).toArray().map((row) => integerColumn(row, "link_identity"));
  }
  markUnlinking(path, range, now) {
    if (this.sharedInodes)
      this.sql.exec(
        "UPDATE vfs_entries SET unlinking = 1, changed_at_ms = ?, revision = revision + 1, mutation_version = mutation_version + 1 WHERE link_identity IS NOT NULL AND (path = ? OR (path >= ? AND path < ?))",
        now,
        path,
        range.lower,
        range.upper
      );
  }
  assertMoveKinds(sourceEntry, destination, target) {
    const directoryMismatch = destination !== null && destination.kind === "directory" !== (sourceEntry.kind === "directory");
    if (directoryMismatch && destination !== null) {
      throw new VfsError(
        destination.kind === "directory" ? "EISDIR" : "ENOTDIR",
        "source and destination kinds differ",
        target
      );
    }
  }
  sameInode(source, destination) {
    return destination !== null && (source.linkIdentity ?? source.id) === (destination.linkIdentity ?? destination.id);
  }
  async move(from, to, options = {}, posix) {
    const sourceAccess = this.resolveAccess(from, false, false);
    const source = sourceAccess.path;
    const requiresDirectory = pathRequiresDirectory(to);
    if (requiresDirectory) sourceAccess.row ??= this.requireEntry(source, false);
    const allowMissingDirectory = !requiresDirectory || sourceAccess.row?.kind === "directory";
    const targetAccess = this.resolveAccess(to, allowMissingDirectory, false);
    const target = targetAccess.path;
    if (source === "/") throw new VfsError("EINVAL", "cannot move root", source);
    if (source === target) {
      return this.transaction(() => {
        const entry = sourceAccess.row ?? this.requireEntry(source, false);
        this.assertTraverse(source, sourceAccess.followed, posix);
        if (posix !== void 0) {
          const parent = this.requireDirectory(dirname(source));
          this.assertPermission(parent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, source);
          this.assertStickyRemoval(parent, entry, posix, source);
        }
        return { from: source, to: target, moved: 1, replaced: false };
      });
    }
    const state = { queued: 0 };
    const result = this.transaction(
      () => this.commitMove(
        source,
        target,
        sourceAccess.row,
        sourceAccess.followed,
        targetAccess.row,
        targetAccess.followed,
        options,
        posix,
        state
      )
    );
    if (state.queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }
  commitMove(source, target, sourceResolved, sourceFollowed, targetResolved, targetFollowed, options, posix, state) {
    const sourceEntry = sourceResolved ?? this.requireEntry(source, false);
    if (sourceEntry.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot move a directory into itself", target);
    }
    this.assertTraverse(source, sourceFollowed, posix);
    this.assertTraverse(target, targetFollowed, posix);
    const targetParent = this.requireDirectory(dirname(target));
    if (posix !== void 0) {
      const sourceParent = this.requireDirectory(dirname(source));
      this.assertPermission(sourceParent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, source);
      this.assertPermission(targetParent, posix, WRITE_PERMISSION | EXECUTE_PERMISSION, target);
      this.assertStickyRemoval(sourceParent, sourceEntry, posix, source);
    }
    const destination = targetResolved ?? this.oneEntry(target);
    if (this.sameInode(sourceEntry, destination))
      return { from: source, to: target, moved: 1, replaced: false };
    if (destination !== null && posix !== void 0) {
      this.assertStickyRemoval(targetParent, destination, posix, target);
    }
    this.assertDestinationReplaceable(destination, target, options.replace ?? false);
    this.assertMoveKinds(sourceEntry, destination, target);
    const sourceRange = descendantRange(source);
    const identities = this.linkedIdentities(source, sourceRange);
    const now = this.now();
    if (destination !== null) state.queued += this.removeExact(target, now, false, destination);
    const sourceChangeSeq = this.nextChangeSeq();
    this.publishSubtreeRemoval(source, sourceChangeSeq, sourceEntry.kind !== "directory");
    this.sql.exec(
      `UPDATE vfs_entries SET
         mutation_version = COALESCE((
           SELECT version + 1 FROM vfs_path_tombstones
           WHERE path = ? || substr(vfs_entries.path, ?)
         ), 1),
         path = ? || substr(path, ?),
         parent_path = CASE WHEN path = ? THEN ?
           ELSE ? || substr(parent_path, ?) END,
         name = CASE WHEN path = ? THEN ? ELSE name END,
         changed_at_ms = CASE WHEN path = ? THEN ? ELSE COALESCE(changed_at_ms, modified_at_ms) END,
         revision = CASE WHEN path = ? THEN MAX(revision, ?) + 1 ELSE revision + 1 END
       WHERE path = ? ${sourceEntry.kind === "directory" ? "OR (path >= ? AND path < ?)" : ""}`,
      target,
      codePointLength(source) + 1,
      target,
      codePointLength(source) + 1,
      source,
      dirname(target),
      target,
      codePointLength(source) + 1,
      source,
      basename(target),
      source,
      now,
      source,
      destination?.revision ?? 0,
      source,
      ...sourceEntry.kind === "directory" ? [sourceRange.lower, sourceRange.upper] : []
    );
    const moved = integerColumn(this.sql.exec("SELECT changes() AS value").one(), "value");
    this.publishLinkedMetadata(identities);
    this.clearSubtreeTombstones(target);
    this.recordSubtreeChange(target, true, this.nextChangeSeq(), sourceEntry.kind !== "directory");
    this.noteDirectoryChange(sourceEntry);
    this.recordMutation({
      op: "move",
      path: source,
      subtree: { root: source, to: target }
    });
    return {
      from: source,
      to: target,
      moved,
      replaced: destination !== null
    };
  }
};

// src/vfs/sql-copy-base.ts
var SqlCopy = class extends SqlMove {
  async copy(from, to, options = {}, posix) {
    const sourceAccess = this.resolveAccess(from, false, options.dereference ?? false);
    const source = sourceAccess.path;
    const requiresDirectory = pathRequiresDirectory(to);
    if (requiresDirectory) sourceAccess.row ??= this.requireEntry(source, false);
    const allowMissingDirectory = !requiresDirectory || sourceAccess.row?.kind === "directory";
    const targetAccess = this.resolveAccess(to, allowMissingDirectory, false);
    const target = targetAccess.path;
    const state = { queued: 0 };
    const result = this.transaction(
      () => this.commitCopy(
        source,
        target,
        sourceAccess.row,
        sourceAccess.followed,
        targetAccess.row,
        targetAccess.followed,
        options,
        posix,
        state
      )
    );
    if (state.queued > 0) await this.scheduleGarbageAlarm();
    return result;
  }
  commitCopy(source, target, sourceResolved, sourceFollowed, targetResolved, targetFollowed, options, posix, state) {
    const sourceEntry = sourceResolved ?? this.requireEntry(source, false);
    this.assertCopySource(source, target, sourceEntry, sourceFollowed, options, posix);
    const plan = this.prepareCopy(
      source,
      target,
      sourceEntry,
      targetResolved,
      targetFollowed,
      options,
      posix,
      state
    );
    this.insertCopyRows(source, target, plan, posix);
    this.noteDirectoryChange(sourceEntry);
    return this.finishCopy(source, target, plan);
  }
  assertCopySource(source, target, sourceEntry, sourceFollowed, options, posix) {
    if (source === target) {
      throw new VfsError("EINVAL", "source and destination are the same path", target);
    }
    this.assertTraverse(source, sourceFollowed, posix);
    if (sourceEntry.kind === "file") {
      this.assertPermission(sourceEntry, posix, READ_PERMISSION, source);
    } else if (sourceEntry.kind === "directory") {
      this.assertSubtreePermissions(
        source,
        posix,
        READ_PERMISSION,
        READ_PERMISSION | EXECUTE_PERMISSION
      );
    }
    if (sourceEntry.kind === "directory" && !(options.recursive ?? false)) {
      throw new VfsError("EISDIR", "recursive copy is required for directories", source);
    }
    if (sourceEntry.kind === "directory" && isDescendant(source, target)) {
      throw new VfsError("EINVAL", "cannot copy a directory into itself", target);
    }
  }
  prepareCopy(source, target, sourceEntry, targetResolved, targetFollowed, options, posix, state) {
    const parents = this.copyCreationParents(target, targetFollowed, options, posix);
    const destination = targetResolved ?? this.oneEntry(target);
    if (destination !== null && (destination.linkIdentity ?? destination.id) === (sourceEntry.linkIdentity ?? sourceEntry.id)) {
      throw new VfsError("EINVAL", "source and destination share an inode", target);
    }
    this.assertDestinationReplaceable(destination, target, options.replace ?? false);
    const now = this.now();
    const preparedParent = this.createCopyParent(
      target,
      targetFollowed,
      options,
      posix,
      parents,
      now
    );
    if (destination !== null && posix !== void 0) {
      this.assertStickyRemoval(preparedParent, destination, posix, target);
    }
    const targetParent = posix === void 0 ? void 0 : preparedParent;
    const owner = targetParent === void 0 ? { uid: 0, gid: 0 } : this.creationOwner(targetParent, posix);
    const sourceRange = descendantRange(source);
    const summary = this.aggregateSubtree(source, sourceEntry.kind !== "directory");
    const {
      preserve,
      preservedLinkIdentity,
      preservedLinkCount,
      extraInlineBytes,
      replacedInlineBytes
    } = this.copyLinks(sourceEntry, destination, summary);
    this.assertCapacity(
      summary.inlineBytes - replacedInlineBytes + extraInlineBytes,
      summary.entries - (destination === null ? 0 : 1),
      target
    );
    if (destination !== null)
      state.queued += this.removeExact(target, now, false, destination, preserve);
    const changeSeq = this.nextChangeSeq();
    const inoBase = this.copyInoBase(sourceEntry, destination, summary.entries);
    const rootRevision = (destination?.revision ?? 0) + 1;
    return {
      preservedLinkIdentity,
      preservedLinkCount,
      extraInlineBytes,
      destination,
      now,
      targetParent,
      owner,
      sourceRange,
      summary,
      inoBase,
      rootRevision,
      changeSeq
    };
  }
  copyLinks(source, destination, summary) {
    const replacedInlineBytes = destination?.contentClass === "inline" ? destination.sizeBytes : 0;
    const preserve = destination?.kind === "file" && source.kind === "file";
    const preservedLinkIdentity = preserve ? destination.linkIdentity ?? null : null;
    const preservedLinkCount = preserve ? destination.linkCount ?? 1 : 1;
    const extraInlineBytes = (summary.inlineBytes - replacedInlineBytes) * (preservedLinkCount - 1);
    return {
      preserve,
      preservedLinkIdentity,
      preservedLinkCount,
      extraInlineBytes,
      replacedInlineBytes
    };
  }
  copyCreationParents(target, followed, options, posix) {
    if (posix === void 0) return void 0;
    const parents = this.creationParents(target, options.createParents ?? false);
    this.assertCreationAccess(target, followed, posix, parents.existing);
    return parents;
  }
  createCopyParent(target, followed, options, posix, parents, now) {
    return parents === void 0 ? this.prepareParents(target, options.createParents ?? false, now, followed, posix) : this.createMissingParents(target, now, posix, parents);
  }
  copyInoBase(source, destination, entries) {
    const preserved = destination?.kind === "file" && source.kind === "file" ? destination.id : void 0;
    return (preserved ?? this.allocateIno(entries)) - 1;
  }
  insertCopyRows(source, target, plan, posix) {
    if (posix === void 0) this.insertTrustedCopyRows(source, target, plan);
    else this.insertPosixCopyRows(source, target, plan, posix);
  }
  insertTrustedCopyRows(source, target, plan) {
    this.sql.exec(
      `INSERT INTO vfs_entries (
         id, path, parent_path, name, kind, content_class, opaque_object_id,
         link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
         mutation_version, link_identity, link_count
       )
       SELECT
         ? + ROW_NUMBER() OVER (ORDER BY e.path),
         ? || substr(e.path, ?),
         CASE WHEN e.path = ? THEN ?
           ELSE ? || substr(e.parent_path, ?) END,
         CASE WHEN e.path = ? THEN ? ELSE e.name END,
         e.kind, e.content_class, e.opaque_object_id,
         e.link_target, e.size_bytes, e.mode, e.uid, e.gid, ?, ?,
         CASE WHEN e.path = ? THEN ? ELSE 1 END,
         COALESCE((
           SELECT version + 1 FROM vfs_path_tombstones
           WHERE path = ? || substr(e.path, ?)
         ), 1), ?, CASE WHEN e.kind = 'directory' THEN e.link_count ELSE ? END
       FROM vfs_entries e
       WHERE e.path = ? ${plan.summary.entries === 1 ? "" : "OR (e.path >= ? AND e.path < ?)"}`,
      plan.inoBase,
      target,
      codePointLength(source) + 1,
      source,
      dirname(target),
      target,
      codePointLength(source) + 1,
      source,
      basename(target),
      plan.now,
      plan.now,
      source,
      plan.rootRevision,
      target,
      codePointLength(source) + 1,
      plan.preservedLinkIdentity,
      plan.preservedLinkCount,
      source,
      ...plan.summary.entries === 1 ? [] : [plan.sourceRange.lower, plan.sourceRange.upper]
    );
  }
  /** Copies actor-owned rows while carrying setgid inheritance through the tree. */
  insertPosixCopyRows(source, target, plan, posix) {
    this.sql.exec(
      `WITH RECURSIVE copied (
           path, parent_path, name, kind, content_class, opaque_object_id,
           link_target, size_bytes, link_count, copied_mode, copied_uid, copied_gid
         ) AS (
           SELECT
             e.path, e.parent_path, e.name, e.kind, e.content_class,
             e.opaque_object_id, e.link_target, e.size_bytes, e.link_count,
             CASE WHEN e.kind = 'symlink' THEN e.mode ELSE
               (e.mode & ?) |
               CASE WHEN e.kind = 'directory' AND (? & ?) <> 0 THEN ? ELSE 0 END
             END,
             ?,
             ?
           FROM vfs_entries e INDEXED BY vfs_entries_path
           WHERE e.path = ?
           UNION ALL
           SELECT
             e.path, e.parent_path, e.name, e.kind, e.content_class,
             e.opaque_object_id, e.link_target, e.size_bytes, e.link_count,
             CASE WHEN e.kind = 'symlink' THEN e.mode ELSE
               (e.mode & ?) |
               CASE
                 WHEN e.kind = 'directory' AND (parent.copied_mode & ?) <> 0 THEN ?
                 ELSE 0
               END
             END,
             ?,
             CASE
               WHEN (parent.copied_mode & ?) <> 0 THEN parent.copied_gid
               ELSE ?
             END
           FROM copied parent
           CROSS JOIN vfs_entries e INDEXED BY vfs_entries_parent_name
           WHERE e.parent_path = parent.path
         )
         INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           link_target, size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           mutation_version, link_identity, link_count
         )
         SELECT
           ? + ROW_NUMBER() OVER (ORDER BY copied.path),
           ? || substr(copied.path, ?),
           CASE WHEN copied.path = ? THEN ?
             ELSE ? || substr(copied.parent_path, ?) END,
           CASE WHEN copied.path = ? THEN ? ELSE copied.name END,
           copied.kind, copied.content_class, copied.opaque_object_id,
           copied.link_target, copied.size_bytes,
           copied.copied_mode, copied.copied_uid, copied.copied_gid, ?, ?,
           CASE WHEN copied.path = ? THEN ? ELSE 1 END,
           COALESCE((
             SELECT version + 1 FROM vfs_path_tombstones
             WHERE path = ? || substr(copied.path, ?)
           ), 1), CASE WHEN copied.path = ? THEN ? ELSE NULL END, CASE WHEN copied.kind = 'directory' THEN copied.link_count WHEN copied.path = ? THEN ? ELSE 1 END
         FROM copied`,
      ~posix.umask,
      plan.targetParent?.mode ?? 0,
      SETGID_BIT,
      SETGID_BIT,
      plan.owner.uid,
      plan.owner.gid,
      source,
      ~posix.umask,
      SETGID_BIT,
      SETGID_BIT,
      posix.credentials.uid,
      SETGID_BIT,
      posix.credentials.gid,
      plan.inoBase,
      target,
      codePointLength(source) + 1,
      source,
      dirname(target),
      target,
      codePointLength(source) + 1,
      source,
      basename(target),
      plan.now,
      plan.now,
      source,
      plan.rootRevision,
      target,
      codePointLength(source) + 1,
      source,
      plan.preservedLinkIdentity,
      source,
      plan.preservedLinkCount
    );
  }
  finishCopy(source, target, plan) {
    this.clearSubtreeTombstones(target);
    this.recordSubtreeChange(target, true, plan.changeSeq, plan.summary.entries === 1);
    this.sql.exec(
      `INSERT INTO vfs_inline_chunks (entry_id, chunk_index, body)
       SELECT destination.id, chunk.chunk_index, chunk.body
       FROM vfs_inline_chunks chunk
       JOIN vfs_entries source_entry ON source_entry.id = chunk.entry_id
       JOIN vfs_entries destination
         ON destination.path = ? || substr(source_entry.path, ?)
       WHERE source_entry.path = ?
          ${plan.summary.entries === 1 ? "" : "OR (source_entry.path >= ? AND source_entry.path < ?)"}`,
      target,
      codePointLength(source) + 1,
      source,
      ...plan.summary.entries === 1 ? [] : [plan.sourceRange.lower, plan.sourceRange.upper]
    );
    this.symlinkCountStale = true;
    this.updateUsage(plan.summary.inlineBytes + plan.extraInlineBytes, plan.summary.entries);
    this.recordMutation(
      plan.summary.entries > 1 ? { op: "create", path: target, subtree: { root: target } } : { op: "create", path: target }
    );
    return {
      from: source,
      to: target,
      copied: plan.summary.entries,
      replaced: plan.destination !== null,
      opaqueBodiesCopied: 0
    };
  }
};

// src/vfs/sql-opaque-start-base.ts
var SqlOpaqueStart = class extends SqlCopy {
  async beginOpaqueUpload(path, options = {}) {
    if (this.opaqueStore === void 0) {
      throw new VfsError("ENOTSUP", "opaque storage is not configured");
    }
    const access = this.resolveAccess(path);
    const normalized = access.path;
    const traversal = access.followed.length !== 0;
    const existing = this.oneEntry(normalized);
    if (existing?.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
    if (options.expectedSizeBytes !== void 0 && (!Number.isSafeInteger(options.expectedSizeBytes) || options.expectedSizeBytes < 0)) {
      throw new VfsError("EINVAL", "expectedSizeBytes must be a non-negative safe integer");
    }
    const expiresInMs = options.expiresInMs ?? DEFAULT_UPLOAD_TTL_MS;
    validatePositiveInteger(expiresInMs, "expiresInMs");
    const reservation = this.transaction(() => {
      this.assertCapacity(0, 0, normalized);
      const token = this.tokenFor(normalized);
      const writtenToken = traversal ? this.guardToken(path) : token;
      if (options.ifMutationToken !== void 0 && options.ifMutationToken !== writtenToken) {
        throw new VfsError("EREVISION", "path mutation token does not match", normalized);
      }
      const uploadId = this.createId();
      const objectKey = `vfs/${this.workspaceId}/objects/${this.createId()}`;
      const expiresAtMs = this.now() + expiresInMs;
      this.sql.exec(
        `INSERT INTO vfs_upload_sessions (
           id, path, expected_mutation_token, r2_key, state,
           verification_token, expected_size_bytes, expires_at_ms,
           verification_lease_until_ms, create_parents, mode,
           content_type, receipt_json, written_path, traversal_token
         ) VALUES (?, ?, ?, ?, 'open', NULL, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
        uploadId,
        normalized,
        token,
        objectKey,
        options.expectedSizeBytes ?? null,
        expiresAtMs,
        options.createParents === true ? 1 : 0,
        options.mode ?? null,
        options.contentType ?? null,
        ...this.traversalColumns(traversal, path, writtenToken)
      );
      return {
        uploadId,
        path: normalized,
        objectKey,
        expectedMutationToken: token,
        expiresAtMs,
        ...options.contentType === void 0 ? {} : { contentType: options.contentType }
      };
    });
    await this.scheduleGarbageAlarm();
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "begin",
      uploadId: reservation.uploadId,
      objectKey: reservation.objectKey,
      path: reservation.path
    });
    return reservation;
  }
  traversalColumns(traversal, path, token) {
    return traversal ? [path, token] : [null, null];
  }
  parseReceipt(value, path) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new VfsError("EIO", "invalid committed upload receipt", path);
    }
    return parseOpaqueReceipt(parsed, path);
  }
  markUploadGarbage(uploadId, objectKey, verificationToken, now, reason) {
    const rejected = this.transaction(() => {
      const session = this.upload(uploadId);
      if (session === null || session.state !== "verifying" || session.objectKey !== objectKey || session.verificationToken !== verificationToken)
        return false;
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ? AND state = 'verifying' AND verification_token = ?`,
        uploadId,
        verificationToken
      );
      this.queueUploadGarbage(session, now);
      return { path: session.path };
    });
    if (rejected === false) return false;
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "reject",
      uploadId,
      objectKey,
      path: rejected.path,
      ...reason === void 0 ? {} : { reason }
    });
    return true;
  }
};

// src/vfs/sql-opaque-commit-base.ts
var SqlOpaqueCommit = class extends SqlOpaqueStart {
  async commitOpaqueUpload(uploadId, options = {}) {
    const store = this.opaqueStore;
    if (store === void 0) throw new VfsError("ENOTSUP", "opaque storage is not configured");
    const started = this.transaction(() => this.beginOpaqueVerification(uploadId));
    const progress = await this.advanceOpaqueVerification(started);
    if (progress.kind === "committed") return progress.stat;
    const metadata = await this.inspectOpaqueObject(store, uploadId, progress, options);
    const committed = await this.finalizeOpaqueVerification(uploadId, progress, metadata);
    return this.reportOpaqueCommit(uploadId, progress.session.objectKey, committed);
  }
  beginOpaqueVerification(uploadId) {
    const session = this.upload(uploadId);
    if (session === null) throw new VfsError("ENOENT", "upload session does not exist");
    if (session.state === "committed" && session.receiptJson !== null) {
      if (session.expiresAtMs <= this.now()) {
        this.sql.exec("DELETE FROM vfs_upload_sessions WHERE id = ?", uploadId);
        return { kind: "expired-receipt", path: session.path };
      }
      return { kind: "committed", stat: this.parseReceipt(session.receiptJson, session.path) };
    }
    if (session.state === "garbage") {
      throw new VfsError("EREVISION", "upload session can no longer be committed", session.path);
    }
    const now = this.now();
    if (session.expiresAtMs <= now) {
      this.sql.exec("UPDATE vfs_upload_sessions SET state = 'garbage' WHERE id = ?", uploadId);
      this.queueUploadGarbage(session, now);
      return { kind: "expired", session };
    }
    if (session.state === "verifying" && (session.verificationLeaseUntilMs ?? 0) > now) {
      throw new VfsError("EAGAIN", "upload verification is already in progress", session.path);
    }
    const token = this.newToken();
    this.sql.exec(
      `UPDATE vfs_upload_sessions SET
         state = 'verifying', verification_token = ?, verification_lease_until_ms = ?
       WHERE id = ?`,
      token,
      now + DEFAULT_VERIFY_LEASE_MS,
      uploadId
    );
    return { kind: "verify", session, token };
  }
  async advanceOpaqueVerification(started) {
    if (started.kind === "committed") return started;
    await this.scheduleGarbageAlarm();
    if (started.kind === "expired-receipt") {
      throw new VfsError("ENOENT", "committed upload receipt expired", started.path);
    }
    if (started.kind === "expired") {
      throw new VfsError("ETIMEDOUT", "upload session expired", started.session.path);
    }
    return started;
  }
  async inspectOpaqueObject(store, uploadId, lease, options) {
    let metadata;
    try {
      metadata = await store.head(lease.session.objectKey);
    } catch (error) {
      this.resetOpaqueVerification(uploadId, lease.token);
      await this.scheduleGarbageAlarm();
      throw error;
    }
    return this.validateOpaqueMetadata(uploadId, lease, metadata, options);
  }
  async validateOpaqueMetadata(uploadId, lease, metadata, options) {
    if (metadata === null) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "object-missing",
        "EIO",
        "uploaded R2 object is missing"
      );
    }
    if (metadata.key !== lease.session.objectKey) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "key-mismatch",
        "EIO",
        "object store returned metadata for the wrong key"
      );
    }
    if (lease.session.expectedSizeBytes !== null && metadata.sizeBytes !== lease.session.expectedSizeBytes) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "size-mismatch",
        "EIO",
        "uploaded R2 object size does not match"
      );
    }
    if (options.verifiedSha256 !== void 0 && options.verifiedSha256 !== metadata.verifiedSha256) {
      return this.rejectOpaqueMetadata(
        uploadId,
        lease,
        "digest-unverified",
        "EINVAL",
        "SHA-256 was not verified by the trusted object store"
      );
    }
    return metadata;
  }
  async rejectOpaqueMetadata(uploadId, lease, reason, code, message) {
    const marked = this.markUploadGarbage(
      uploadId,
      lease.session.objectKey,
      lease.token,
      this.now(),
      reason
    );
    if (!marked) {
      throw new VfsError("EREVISION", "upload verification lease was lost", lease.session.path);
    }
    await this.scheduleGarbageAlarm();
    throw new VfsError(code, message, lease.session.path);
  }
  resetOpaqueVerification(uploadId, token) {
    this.transaction(() => {
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'open', verification_token = NULL, verification_lease_until_ms = NULL
         WHERE id = ? AND state = 'verifying' AND verification_token = ?`,
        uploadId,
        token
      );
    });
  }
  async finalizeOpaqueVerification(uploadId, lease, metadata) {
    try {
      const committed = this.transaction(
        () => this.commitVerifiedOpaqueUpload(uploadId, lease, metadata)
      );
      await this.scheduleGarbageAlarm();
      return committed;
    } catch (error) {
      this.resetOpaqueVerification(uploadId, lease.token);
      await this.scheduleGarbageAlarm();
      throw error;
    }
  }
  commitVerifiedOpaqueUpload(uploadId, lease, metadata) {
    const session = this.requireVerificationLease(uploadId, lease);
    if (session.expiresAtMs <= this.now() || (session.verificationLeaseUntilMs ?? 0) <= this.now()) {
      this.staleOpaqueCommit(uploadId, session);
      return { kind: "expired", path: session.path };
    }
    if (this.tokenFor(session.path) !== session.expectedMutationToken || !this.matchesUploadTraversal(session)) {
      return this.staleOpaqueCommit(uploadId, session);
    }
    const existing = this.oneEntry(session.path);
    if (existing?.kind === "directory")
      throw new VfsError("EISDIR", "is a directory", session.path);
    const now = this.now();
    this.prepareParents(session.path, session.createParents, now, []);
    this.assertCapacity(
      existing?.contentClass === "inline" ? -existing.sizeBytes * (existing.linkCount ?? 1) : 0,
      existing === null ? 1 : 0,
      session.path
    );
    const objectId = this.insertOpaqueObject(session, metadata, now);
    this.removeReplacedInlineBody(existing);
    const written = this.writeOpaqueEntry(session, existing, metadata, objectId, now);
    const stat = this.publishOpaqueEntry(session, existing, metadata, written, now);
    this.storeOpaqueReceipt(uploadId, stat, now);
    return { kind: "committed", stat };
  }
  matchesUploadTraversal(session) {
    if (session.writtenPath === null) return true;
    try {
      return this.resolveAccess(session.writtenPath).path === session.path && this.guardToken(session.writtenPath) === session.traversalToken;
    } catch (error) {
      if (error instanceof VfsError && ["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code))
        return false;
      throw error;
    }
  }
  requireVerificationLease(uploadId, lease) {
    const session = this.upload(uploadId);
    if (session === null || session.state !== "verifying" || session.verificationToken !== lease.token) {
      throw new VfsError("EREVISION", "upload verification lease was lost", lease.session.path);
    }
    return session;
  }
  staleOpaqueCommit(uploadId, session) {
    this.sql.exec(
      `UPDATE vfs_upload_sessions SET
         state = 'garbage', verification_token = NULL, verification_lease_until_ms = NULL
       WHERE id = ?`,
      uploadId
    );
    this.queueUploadGarbage(session, this.now());
    return { kind: "stale", path: session.path, objectKey: session.objectKey };
  }
  insertOpaqueObject(session, metadata, now) {
    const row = this.sql.exec(
      `INSERT INTO vfs_opaque_objects (
           r2_key, size_bytes, etag, r2_version, verified_sha256,
           content_type, retain_until_ms, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         RETURNING id`,
      metadata.key,
      metadata.sizeBytes,
      metadata.etag,
      metadata.version,
      metadata.verifiedSha256 ?? null,
      session.contentType ?? metadata.contentType ?? null,
      now
    ).one();
    return integerColumn(row, "id");
  }
  removeReplacedInlineBody(existing) {
    if (existing?.contentClass !== "inline") return;
    this.sql.exec("DELETE FROM vfs_inline_chunks WHERE entry_id = ?", existing.id);
  }
  writeOpaqueEntry(session, existing, metadata, objectId, now) {
    const parentPath = dirname(session.path);
    const name = basename(session.path);
    const mode = session.mode ?? existing?.mode ?? FILE_MODE;
    const uid = existing?.uid ?? 0;
    const gid = existing?.gid ?? 0;
    const createdAtMs = existing?.createdAtMs ?? now;
    const mutationVersion = existing === null ? this.nextEntryVersion(session.path) : existing.mutationVersion + 1;
    const row = this.sql.exec(
      `INSERT INTO vfs_entries (
           id, path, parent_path, name, kind, content_class, opaque_object_id,
           size_bytes, mode, uid, gid, created_at_ms, modified_at_ms, revision,
           mutation_version
         ) VALUES (?, ?, ?, ?, 'file', 'opaque', ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(path) DO UPDATE SET
           kind = 'file', content_class = 'opaque', opaque_object_id = excluded.opaque_object_id,
           size_bytes = excluded.size_bytes, mode = excluded.mode,
           modified_at_ms = excluded.modified_at_ms, changed_at_ms = excluded.modified_at_ms,
           revision = vfs_entries.revision + 1,
           mutation_version = excluded.mutation_version
         RETURNING id, revision`,
      existing?.id ?? this.allocateIno(),
      session.path,
      parentPath,
      name,
      objectId,
      metadata.sizeBytes,
      mode,
      uid,
      gid,
      createdAtMs,
      now,
      mutationVersion
    ).one();
    return { row, parentPath, name, mode, uid, gid, createdAtMs, mutationVersion };
  }
  publishOpaqueEntry(session, existing, metadata, written, now) {
    const token = this.publishToken(
      session.path,
      written.mutationVersion,
      true,
      existing === null ? "create" : "write",
      existing
    );
    this.updateUsage(
      existing?.contentClass === "inline" ? -existing.sizeBytes * (existing.linkCount ?? 1) : 0,
      existing === null ? 1 : 0
    );
    this.queueReplacedOpaqueObject(existing, now);
    const contentType = session.contentType ?? metadata.contentType;
    return {
      path: session.path,
      parentPath: written.parentPath,
      ino: existing?.linkIdentity ?? integerColumn(written.row, "id"),
      nlink: existing?.linkCount ?? 1,
      name: written.name,
      kind: "file",
      contentClass: "opaque",
      sizeBytes: metadata.sizeBytes,
      mode: written.mode,
      uid: written.uid,
      gid: written.gid,
      createdAtMs: written.createdAtMs,
      modifiedAtMs: now,
      changedAtMs: now,
      revision: integerColumn(written.row, "revision"),
      mutationToken: token,
      ...contentType === void 0 ? {} : { contentType },
      ...metadata.verifiedSha256 === void 0 ? {} : { verifiedSha256: metadata.verifiedSha256 }
    };
  }
  queueReplacedOpaqueObject(existing, now) {
    if (existing?.contentClass !== "opaque") return;
    this.queueObjectIfUnreferenced(existing.opaqueObjectId, now);
  }
  storeOpaqueReceipt(uploadId, stat, now) {
    this.sql.exec(
      `UPDATE vfs_upload_sessions SET
         state = 'committed', verification_token = NULL,
         verification_lease_until_ms = NULL, receipt_json = ?, expires_at_ms = ?
       WHERE id = ?`,
      JSON.stringify(stat),
      now + this.receiptRetentionMs,
      uploadId
    );
  }
  reportOpaqueCommit(uploadId, originalObjectKey, committed) {
    if (committed.kind === "expired") {
      emitVfsEvent(this.onEvent, {
        type: "vfs.opaque-upload",
        phase: "expire",
        uploadId,
        objectKey: originalObjectKey,
        path: committed.path
      });
      throw new VfsError("ETIMEDOUT", "upload verification expired", committed.path);
    }
    if (committed.kind === "stale") {
      emitVfsEvent(this.onEvent, {
        type: "vfs.opaque-upload",
        phase: "reject",
        uploadId,
        objectKey: committed.objectKey,
        path: committed.path,
        reason: "stale-path-token"
      });
      throw new VfsError("EREVISION", "path changed after upload reservation", committed.path);
    }
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "commit",
      uploadId,
      objectKey: originalObjectKey,
      path: committed.stat.path
    });
    return committed.stat;
  }
};

// src/vfs/sql-gc-base.ts
var MAX_GC_BATCH = 100;
var SqlGc = class extends SqlOpaqueCommit {
  async abortOpaqueUpload(uploadId) {
    let aborted;
    this.transaction(() => {
      const session = this.upload(uploadId);
      if (session === null || session.state === "garbage" || session.state === "committed") return;
      this.sql.exec(
        `UPDATE vfs_upload_sessions SET
           state = 'garbage', verification_token = NULL,
           verification_lease_until_ms = NULL
         WHERE id = ?`,
        uploadId
      );
      this.queueUploadGarbage(session, this.now());
      aborted = { path: session.path, objectKey: session.objectKey };
    });
    if (aborted === void 0) return;
    await this.scheduleGarbageAlarm();
    emitVfsEvent(this.onEvent, {
      type: "vfs.opaque-upload",
      phase: "abort",
      uploadId,
      objectKey: aborted.objectKey,
      path: aborted.path
    });
  }
  resolveOpaqueRead(path, leaseMs = DEFAULT_READ_LEASE_MS) {
    validatePositiveInteger(leaseMs, "leaseMs");
    const normalized = this.normalizeAccessPath(path);
    return this.transaction(() => {
      const entry = this.requireEntry(normalized);
      if (entry.kind === "directory") throw new VfsError("EISDIR", "is a directory", normalized);
      if (entry.contentClass !== "opaque") {
        throw new VfsError("ENOTSUP", "file is not opaque", normalized);
      }
      const object = this.opaqueObject(entry.opaqueObjectId);
      if (object === null)
        throw new VfsError("EIO", "opaque object metadata is missing", normalized);
      const leaseExpiresAtMs = this.now() + Math.min(leaseMs, MAX_READ_LEASE_MS);
      this.sql.exec(
        `UPDATE vfs_opaque_objects
         SET retain_until_ms = MAX(retain_until_ms, ?) WHERE id = ?`,
        leaseExpiresAtMs,
        object.id
      );
      return {
        stat: rowToStat(entry),
        object: metadataFromObject(object),
        leaseExpiresAtMs
      };
    });
  }
  async drainGarbage(limit = MAX_GC_BATCH) {
    validatePositiveInteger(limit, "limit");
    const store = this.opaqueStore;
    const batchLimit = Math.min(limit, MAX_GC_BATCH);
    const now = this.now();
    const { expiredSessions, keys } = this.selectGarbageBatch(now, batchLimit);
    for (const session of expiredSessions) {
      emitVfsEvent(this.onEvent, { type: "vfs.opaque-upload", phase: "expire", ...session });
    }
    if (store === void 0 || keys.length === 0) {
      await this.scheduleGarbageAlarm();
      const remaining2 = this.garbageDepth();
      emitVfsEvent(this.onEvent, {
        type: "vfs.garbage",
        deleted: 0,
        remaining: remaining2,
        failed: 0
      });
      return { deleted: 0, remaining: remaining2 };
    }
    const selectedKeys = JSON.stringify(keys);
    try {
      await store.delete(keys);
      this.transaction(() => {
        this.sql.exec(
          "DELETE FROM vfs_upload_sessions WHERE state='garbage' AND r2_key IN(SELECT value FROM json_each(?))",
          selectedKeys
        );
        this.sql.exec(
          "DELETE FROM vfs_gc_queue WHERE r2_key IN (SELECT value FROM json_each(?))",
          selectedKeys
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transaction(() => {
        this.sql.exec(
          "UPDATE vfs_gc_queue SET attempts=attempts+1,next_attempt_at_ms=?+MIN((1<<MIN(attempts+1,12))*1000,60*60*1000),last_error=? WHERE r2_key IN(SELECT value FROM json_each(?))",
          now,
          message,
          selectedKeys
        );
      });
      await this.scheduleGarbageAlarm();
      emitVfsEvent(this.onEvent, {
        type: "vfs.garbage",
        deleted: 0,
        remaining: this.garbageDepth(),
        failed: keys.length
      });
      throw error;
    }
    await this.scheduleGarbageAlarm();
    const remaining = this.garbageDepth();
    emitVfsEvent(this.onEvent, {
      type: "vfs.garbage",
      deleted: keys.length,
      remaining,
      failed: 0
    });
    return { deleted: keys.length, remaining };
  }
  selectGarbageBatch(now, batchLimit) {
    const expiredSessions = [];
    const keys = this.transaction(() => {
      const expired = this.sql.exec(
        "SELECT id,path,r2_key,expires_at_ms FROM vfs_upload_sessions WHERE(state='open' AND expires_at_ms<=?)OR(state='verifying' AND verification_lease_until_ms<=?)LIMIT ?",
        now,
        now,
        batchLimit
      ).toArray();
      for (const row of expired) {
        const id = stringColumn(row, "id");
        this.sql.exec(
          "UPDATE vfs_upload_sessions SET state='garbage',verification_token=NULL,verification_lease_until_ms=NULL WHERE id=?",
          id
        );
        const objectKey = stringColumn(row, "r2_key");
        this.queueGarbage(
          objectKey,
          Math.max(now, integerColumn(row, "expires_at_ms") + this.uploadSettlementGraceMs)
        );
        expiredSessions.push({
          uploadId: id,
          objectKey,
          path: stringColumn(row, "path")
        });
      }
      this.sql.exec(
        "DELETE FROM vfs_upload_sessions WHERE state = 'committed' AND expires_at_ms <= ?",
        now
      );
      return this.sql.exec(
        "SELECT r2_key FROM vfs_gc_queue WHERE not_before_ms<=? AND next_attempt_at_ms<=? ORDER BY next_attempt_at_ms,not_before_ms LIMIT ?",
        now,
        now,
        batchLimit
      ).toArray().map((row) => stringColumn(row, "r2_key"));
    });
    return { expiredSessions, keys };
  }
  garbageDepth() {
    return integerColumn(
      this.sql.exec("SELECT COUNT(*) AS value FROM vfs_gc_queue").one(),
      "value"
    );
  }
};

// src/vfs/sql.ts
var SqlFileSystem = class extends SqlGc {
  handles;
  canUseBulkOperation(_operation, _path) {
    return true;
  }
  /** Hosts await this at startup to arm recovery maintenance before serving work. */
  async initialize() {
    if (!this.recoveredDetached) return;
    await this.scheduleGarbageAlarm();
    this.recoveredDetached = false;
  }
  openFileHandle(path, flags = "r", mode = 438, access) {
    this.handles ??= createHandleProvider(this.handlePort());
    return this.handles.open(path, flags, mode, access);
  }
  linkFile(from, to, access) {
    this.handles ??= createHandleProvider(this.handlePort());
    this.handles.link(from, to, access);
  }
  handlePort() {
    return {
      sql: this.sql,
      batch: (query) => this.execBatch(query),
      linked: () => {
        this.sharedInodes = true;
      },
      sourceEntry: (path, access) => {
        const resolved = this.resolveAccess(path, false, false);
        this.assertTraverse(resolved.path, resolved.followed, access);
        return resolved.row ?? this.requireEntry(resolved.path, false);
      },
      budget: this.inFlightBytes,
      chunkBytes: this.chunkBytes,
      maximum: this.maxInlineFileBytes,
      store: this.opaqueStore,
      transaction: (callback) => this.transaction(callback),
      now: () => this.now(),
      openEntry: (...args) => this.openHandleEntry(...args),
      retain: (callback) => {
        this.retainOpenInodes = callback;
      },
      capacity: (delta, path) => this.assertCapacity(delta, 0, path),
      usage: (delta) => this.updateUsage(delta, 0),
      publish: (entry) => {
        this.publishToken(entry.path, entry.mutationVersion, true, "write", entry);
      },
      reclaimObject: (id) => {
        this.queueObjectIfUnreferenced(id, this.now());
      },
      sync: () => this.storage.sync?.() ?? Promise.resolve(),
      maintenance: () => this.scheduleGarbageAlarm(),
      stat: rowToStat
    };
  }
  openHandleEntry(path, read, write, create, exclusive, mode, access) {
    if (exclusive) {
      const named = this.resolveAccess(path, false, false);
      if ((named.row ?? this.oneEntry(named.path)) !== null)
        throw new VfsError("EEXIST", "entry exists", path);
    }
    const resolved = this.resolveAccess(path);
    this.assertTraverse(resolved.path, resolved.followed, access);
    let entry = resolved.row ?? this.oneEntry(resolved.path);
    const created = entry === null && create;
    if (created) {
      this.touch(path, { mode: 32768 | mode & 4095 }, access);
      entry = this.requireEntry(resolved.path);
    }
    if (entry === null) throw new VfsError("ENOENT", "file does not exist", path);
    if (entry.kind !== "file") throw new VfsError("EISDIR", "not a regular file", path);
    if (!created)
      this.assertPermission(
        entry,
        access,
        (read ? READ_PERMISSION : 0) | (write ? WRITE_PERMISSION : 0),
        path
      );
    return entry;
  }
  forCredentials(credentials, options = {}) {
    return new PosixFileSystemView(this, posixContext(credentials, options));
  }
};
var PosixFileSystemView = class {
  constructor(inner, access) {
    this.inner = inner;
    this.access = access;
  }
  inner;
  access;
  canUseBulkOperation(operation, path) {
    return this.inner.canUseBulkOperation(operation, path);
  }
  linkFile(from, to) {
    this.inner.linkFile(from, to, this.access);
  }
  openFileHandle(path, flags = "r", mode = 438) {
    return this.inner.openFileHandle(path, flags, mode, this.access);
  }
  getMutationToken(path, options) {
    return this.inner.getMutationToken(path, options, this.access);
  }
  get availableWriteBufferBytes() {
    return this.inner.availableWriteBufferBytes;
  }
  stat(path) {
    return this.inner.stat(path, this.access);
  }
  statMany(paths, options) {
    return this.inner.statMany(paths, options, this.access);
  }
  lstat(path) {
    return this.inner.lstat(path, this.access);
  }
  readlink(path) {
    return this.inner.readlink(path, this.access);
  }
  symlink(path, target, options) {
    return this.inner.symlink(path, target, options, this.access);
  }
  realpath(path, options) {
    return this.inner.realpath(path, options, this.access);
  }
  list(path) {
    return this.inner.list(path, this.access);
  }
  listPage(path, options) {
    return this.inner.listPage(path, options, this.access);
  }
  find(options) {
    return this.inner.find(options, this.access);
  }
  findPage(options) {
    return this.inner.findPage(options, this.access);
  }
  subtreeSummary(path) {
    return this.inner.subtreeSummary(path, this.access);
  }
  mutationSubtreeCount(path, operation) {
    return this.inner.countPosixMutationSubtree(path, operation, this.access);
  }
  digestFile(path) {
    return this.inner.digestFile(path, this.access);
  }
  readFile(path, options) {
    return this.inner.readFile(path, options, this.access);
  }
  validateInlineWrite(path, options, sizeBytes, additionalInlineBytes) {
    return this.inner.validateInlineWrite(
      path,
      options,
      sizeBytes,
      additionalInlineBytes,
      this.access
    );
  }
  writeFile(path, body, options) {
    return this.inner.writeFile(path, body, options, this.access);
  }
  writeFiles(entries, options) {
    return this.inner.writeFiles(entries, options, this.access);
  }
  appendFile(path, body, options) {
    return this.inner.appendFile(path, body, options, this.access);
  }
  touch(path, options) {
    return this.inner.touch(path, options, this.access);
  }
  setMetadata(path, options) {
    return this.inner.setMetadata(path, options, this.access);
  }
  setOwnership(path, options) {
    return this.inner.setOwnership(path, options, this.access);
  }
  mkdir(path, recursive, mode) {
    return this.inner.mkdir(path, recursive, mode, this.access);
  }
  remove(path, options) {
    return this.inner.remove(path, options, this.access);
  }
  move(from, to, options) {
    return this.inner.move(from, to, options, this.access);
  }
  copy(from, to, options) {
    return this.inner.copy(from, to, options, this.access);
  }
  statById() {
    throw new VfsError("EPERM", "user views cannot read by entry identity");
  }
  changesSince() {
    throw new VfsError("EPERM", "user views cannot read the workspace change feed");
  }
  beginOpaqueUpload() {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer opaque uploads"));
  }
  commitOpaqueUpload() {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer opaque uploads"));
  }
  abortOpaqueUpload() {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer opaque uploads"));
  }
  resolveOpaqueRead(path, leaseMs) {
    const stat = this.inner.stat(path, this.access);
    if (stat.kind !== "file") throw new VfsError("EISDIR", "is a directory", path);
    if (this.access.credentials.uid !== 0 && (posixPermissions(stat, this.access) & READ_PERMISSION) === 0) {
      throw new VfsError("EACCES", "permission denied", path);
    }
    return this.inner.resolveOpaqueRead(path, leaseMs);
  }
  drainGarbage() {
    return Promise.reject(new VfsError("EPERM", "user views cannot administer garbage collection"));
  }
};

// src/vfs/do-sql.ts
var MAX_SQLITE_INLINE_CHUNK_BYTES = 1024 * 1024;
var DurableObjectFileSystem = class extends SqlFileSystem {
  constructor(storage, options = {}) {
    if (options.chunkBytes !== void 0 && options.chunkBytes > MAX_SQLITE_INLINE_CHUNK_BYTES) {
      throw new VfsError(
        "EINVAL",
        `chunkBytes cannot exceed ${MAX_SQLITE_INLINE_CHUNK_BYTES} for SQLite storage`
      );
    }
    super(storage, options);
  }
};

// demo/benchmark-suite.ts
import git12 from "isomorphic-git";

// src/core/lines.ts
function splitLinesPreservingEndings(text) {
  const lines = [];
  let start = 0;
  for (; ; ) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) break;
    lines.push(text.slice(start, newline + 1));
    start = newline + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

// src/core/line-diff.ts
var MAX_LCS_CELLS = 1e6;
function lineAt(lines, index) {
  const line = lines[index];
  if (line === void 0) throw new RangeError(`line index ${index} is out of bounds`);
  return line;
}
function equalOperation(text, oldLine, newLine) {
  return { kind: "equal", text, oldLine, newLine };
}
function cellAt(cells, index) {
  const cell = cells[index];
  if (cell === void 0) throw new RangeError(`diff matrix index ${index} is out of bounds`);
  return cell;
}
function lcsLengths(before, after) {
  const columns = after.length + 1;
  const cells = (before.length + 1) * columns;
  if (cells > MAX_LCS_CELLS) {
    throw new VfsError(
      "E2BIG",
      `diff requires ${cells} comparison cells; limit is ${MAX_LCS_CELLS}`
    );
  }
  const lengths = new Uint32Array(cells);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * columns + right;
      lengths[index] = lineAt(before, left) === lineAt(after, right) ? cellAt(lengths, (left + 1) * columns + right + 1) + 1 : Math.max(cellAt(lengths, (left + 1) * columns + right), cellAt(lengths, index + 1));
    }
  }
  return lengths;
}
function shouldDelete(lengths, columns, left, right, afterLength) {
  return right >= afterLength || cellAt(lengths, (left + 1) * columns + right) >= cellAt(lengths, left * columns + right + 1);
}
function lineOperations(before, after, oldOffset = 0, newOffset = 0) {
  const columns = after.length + 1;
  const lengths = lcsLengths(before, after);
  const operations = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      operations.push(
        equalOperation(lineAt(before, left), oldOffset + left + 1, newOffset + right + 1)
      );
      left += 1;
      right += 1;
    } else if (left < before.length && shouldDelete(lengths, columns, left, right, after.length)) {
      operations.push({
        kind: "delete",
        text: lineAt(before, left),
        oldLine: oldOffset + left + 1,
        newLine: newOffset + right + 1
      });
      left += 1;
    } else {
      operations.push({
        kind: "insert",
        text: lineAt(after, right),
        oldLine: oldOffset + left + 1,
        newLine: newOffset + right + 1
      });
      right += 1;
    }
  }
  return operations;
}
function prefixedLine(prefix, text) {
  return text.endsWith("\n") ? `${prefix}${text}` : `${prefix}${text}
\\ No newline at end of file
`;
}
function changedHunk(operations, start) {
  let next = start;
  while (operations[next] !== void 0 && operations[next]?.kind !== "equal") next += 1;
  const changed = operations.slice(start, next);
  const first = changed.at(0);
  if (!first) throw new Error("diff hunk cannot be empty");
  const deleted = changed.filter((operation) => operation.kind === "delete").length;
  const inserted = changed.filter((operation) => operation.kind === "insert").length;
  const oldStart = first.oldLine - (deleted === 0 ? 1 : 0);
  const newStart = first.newLine - (inserted === 0 ? 1 : 0);
  const lines = [`@@ -${oldStart},${deleted} +${newStart},${inserted} @@
`];
  for (const operation of changed) {
    if (operation.kind === "delete") lines.push(prefixedLine("-", operation.text));
    if (operation.kind === "insert") lines.push(prefixedLine("+", operation.text));
  }
  return { lines, next };
}
function createLineDiff(before, after) {
  if (before === after) return { changes: 0, operations: [] };
  const beforeLines = splitLinesPreservingEndings(before);
  const afterLines = splitLinesPreservingEndings(after);
  const shared = Math.min(beforeLines.length, afterLines.length);
  let prefix = 0;
  while (prefix < shared && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shared - prefix && beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]) {
    suffix += 1;
  }
  const operations = [];
  for (let index = 0; index < prefix; index += 1) {
    operations.push(equalOperation(lineAt(beforeLines, index), index + 1, index + 1));
  }
  for (const operation of lineOperations(
    beforeLines.slice(prefix, beforeLines.length - suffix),
    afterLines.slice(prefix, afterLines.length - suffix),
    prefix,
    prefix
  ))
    operations.push(operation);
  for (let index = 0; index < suffix; index += 1) {
    operations.push(
      equalOperation(
        lineAt(beforeLines, beforeLines.length - suffix + index),
        beforeLines.length - suffix + index + 1,
        afterLines.length - suffix + index + 1
      )
    );
  }
  return {
    changes: operations.filter((operation) => operation.kind !== "equal").length,
    operations
  };
}
function renderLineDiff(from, to, diff) {
  if (diff.changes === 0) return "";
  const output = [`--- ${from}
`, `+++ ${to}
`];
  let index = 0;
  while (index < diff.operations.length) {
    while (diff.operations[index]?.kind === "equal") index += 1;
    if (index >= diff.operations.length) break;
    const hunk = changedHunk(diff.operations, index);
    for (const line of hunk.lines) output.push(line);
    index = hunk.next;
  }
  return output.join("");
}

// src/fs/handle-utils.ts
function bytes(body) {
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}
function position(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new VfsError("EINVAL", "invalid file position");
  return value;
}

// src/fs/file-handle.ts
function writeBytes(body, offset, length) {
  if (typeof body === "string") {
    if (typeof length === "string" && length !== "utf8" && length !== "utf-8")
      throw new VfsError("ENOTSUP", "unsupported encoding");
    return bytes(body);
  }
  const start = position(offset ?? 0);
  const count = typeof length === "number" ? position(length) : body.byteLength - start;
  if (start > body.byteLength || start + count > body.byteLength)
    throw new VfsError("EINVAL", "write exceeds buffer");
  return body.subarray(start, start + count);
}
var FsFileHandle = class {
  constructor(owner, ino, fd, readable, writable, append2) {
    this.owner = owner;
    this.ino = ino;
    this.fd = fd;
    this.readable = readable;
    this.writable = writable;
    this.append = append2;
  }
  owner;
  ino;
  fd;
  readable;
  writable;
  append;
  cursor = 0;
  closed = false;
  queue = Promise.resolve();
  closing;
  run(operation) {
    if (this.closed) return Promise.reject(new VfsError("EBADF", "file handle is closed"));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => void 0);
    return result;
  }
  readableHandle() {
    if (!this.readable) throw new VfsError("EBADF", "handle is not readable");
  }
  writableHandle() {
    if (!this.writable) throw new VfsError("EBADF", "handle is not writable");
  }
  readFile(options) {
    return this.run(async () => {
      this.readableHandle();
      const encoding2 = typeof options === "string" ? options : options?.encoding;
      if (encoding2 !== void 0 && encoding2 !== null && encoding2 !== "utf8" && encoding2 !== "utf-8")
        throw new VfsError("ENOTSUP", "unsupported encoding");
      const result = await this.owner.readRemaining(this.ino, this.cursor);
      this.cursor += result.byteLength;
      return encoding2 ? new TextDecoder().decode(result) : result;
    });
  }
  write(body, offset, length, at) {
    return this.run(() => {
      this.writableHandle();
      const explicit = typeof body === "string" ? offset : at;
      const data = writeBytes(body, offset, length);
      const end = this.owner.write(
        this.ino,
        data,
        explicit == null ? this.cursor : position(explicit),
        this.append
      );
      if (explicit == null) this.cursor = end;
      return { bytesWritten: data.byteLength, buffer: body };
    });
  }
  writeFile(body) {
    return this.run(() => {
      this.writableHandle();
      this.cursor = this.owner.write(this.ino, bytes(body), this.cursor, this.append);
    });
  }
  read(buffer, offset = 0, length = buffer.byteLength - offset, at = null) {
    return this.run(async () => {
      this.readableHandle();
      position(offset);
      position(length);
      if (offset + length > buffer.byteLength) throw new VfsError("EINVAL", "read exceeds buffer");
      const data = await this.owner.read(
        this.ino,
        at === null ? this.cursor : position(at),
        length
      );
      buffer.set(data, offset);
      if (at === null) this.cursor += data.byteLength;
      return { bytesRead: data.byteLength, buffer };
    });
  }
  truncate(size = 0) {
    return this.run(() => {
      this.writableHandle();
      this.owner.truncate(this.ino, position(size));
    });
  }
  stat() {
    return this.run(() => this.owner.stat(this.ino));
  }
  /** Waits for previous writes and the backing storage durability barrier. */
  sync() {
    return this.run(() => this.owner.sync());
  }
  datasync() {
    return this.sync();
  }
  close() {
    if (this.closing !== void 0) return this.closing;
    this.closed = true;
    const closing = this.queue.then(async () => {
      this.owner.release(this.ino);
      await this.owner.maintenance();
    });
    this.closing = closing;
    void closing.catch(() => {
      this.closing = void 0;
    });
    return closing;
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
};

// src/fs/read.ts
async function materialize(opened, maximum, budget) {
  const { stat, stream } = opened;
  try {
    if (stat.sizeBytes > maximum)
      throw new VfsError("EFBIG", "readFile exceeds its materialization limit", stat.path);
    budget.acquire(stat.sizeBytes);
  } catch (error) {
    await stream.cancel(error).catch(() => void 0);
    throw error;
  }
  let reader;
  try {
    reader = stream.getReader();
  } catch (error) {
    budget.release(stat.sizeBytes);
    throw error;
  }
  try {
    const bytes2 = new Uint8Array(stat.sizeBytes);
    let offset = 0;
    for (; ; ) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.byteLength > bytes2.byteLength)
        throw new VfsError("EIO", "file exceeds its reported size", stat.path);
      bytes2.set(next.value, offset);
      offset += next.value.byteLength;
    }
    if (offset !== bytes2.byteLength)
      throw new VfsError("EIO", "file is shorter than its reported size", stat.path);
    return bytes2;
  } catch (error) {
    await reader.cancel(error).catch(() => void 0);
    throw error;
  } finally {
    reader.releaseLock();
    budget.release(stat.sizeBytes);
  }
}

// src/fs/hard-links.ts
function installHardLinkTriggers(port) {
  const columns = [
    "kind",
    "content_class",
    "opaque_object_id",
    "link_target",
    "size_bytes",
    "mode",
    "uid",
    "gid",
    "created_at_ms",
    "modified_at_ms",
    "changed_at_ms",
    "revision",
    "mutation_version",
    "body_digest",
    "body_digest_revision"
  ];
  const metadata = columns.filter(
    (column) => column !== "revision" && column !== "mutation_version" && column !== "body_digest" && column !== "body_digest_revision"
  );
  const watched = columns.filter(
    (column) => column !== "body_digest" && column !== "body_digest_revision"
  );
  port.batch(`
    CREATE TRIGGER IF NOT EXISTS vfs_hard_metadata AFTER UPDATE OF ${watched.join(", ")} ON vfs_entries
    WHEN NEW.link_identity IS NOT NULL AND NEW.mirroring = 0 BEGIN
      UPDATE vfs_entries SET mirroring = 1, ${metadata.map((column) => `${column} = NEW.${column}`).join(", ")},
        body_digest = NULL, body_digest_revision = NULL, revision = revision + 1, mutation_version = mutation_version + 1
      WHERE link_identity = NEW.link_identity AND id <> NEW.id;
      UPDATE vfs_entries SET mirroring = 0 WHERE link_identity = NEW.link_identity AND mirroring <> 0;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_new_name AFTER INSERT ON vfs_entries WHEN NEW.link_identity IS NOT NULL BEGIN
      DELETE FROM vfs_inline_chunks WHERE entry_id IN (SELECT id FROM vfs_entries WHERE link_identity = NEW.link_identity AND id <> NEW.id);
      UPDATE vfs_entries SET link_count = (SELECT COUNT(*) FROM vfs_entries WHERE link_identity = NEW.link_identity)
      WHERE link_identity = NEW.link_identity;
      UPDATE vfs_entries SET mirroring = 1, ${metadata.map((column) => `${column} = NEW.${column}`).join(", ")},
        body_digest = NULL, body_digest_revision = NULL, revision = revision + 1, mutation_version = mutation_version + 1
      WHERE link_identity = NEW.link_identity AND id <> NEW.id;
      UPDATE vfs_entries SET mirroring = 0 WHERE link_identity = NEW.link_identity AND mirroring <> 0;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_chunk_insert AFTER INSERT ON vfs_inline_chunks BEGIN
      INSERT INTO vfs_inline_chunks(entry_id, chunk_index, body)
      SELECT alias.id, NEW.chunk_index, NEW.body FROM vfs_entries source JOIN vfs_entries alias
      ON alias.link_identity = source.link_identity AND alias.id <> source.id
      WHERE source.id = NEW.entry_id AND source.link_identity IS NOT NULL AND source.unlinking = 0
      ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_chunk_update AFTER UPDATE OF body ON vfs_inline_chunks BEGIN
      INSERT INTO vfs_inline_chunks(entry_id, chunk_index, body)
      SELECT alias.id, NEW.chunk_index, NEW.body FROM vfs_entries source JOIN vfs_entries alias
      ON alias.link_identity = source.link_identity AND alias.id <> source.id
      WHERE source.id = NEW.entry_id AND source.link_identity IS NOT NULL AND source.unlinking = 0
      ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body;
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_chunk_delete AFTER DELETE ON vfs_inline_chunks BEGIN
      DELETE FROM vfs_inline_chunks WHERE chunk_index = OLD.chunk_index AND entry_id IN (
        SELECT alias.id FROM vfs_entries source JOIN vfs_entries alias ON alias.link_identity = source.link_identity
        WHERE source.id = OLD.entry_id AND source.unlinking = 0 AND alias.id <> source.id
      );
    END;
    CREATE TRIGGER IF NOT EXISTS vfs_hard_unlink AFTER DELETE ON vfs_entries WHEN OLD.link_identity IS NOT NULL BEGIN
      UPDATE vfs_entries SET link_count = (SELECT COUNT(*) FROM vfs_entries WHERE link_identity = OLD.link_identity)
      WHERE link_identity = OLD.link_identity;
    END;
  `);
}

// src/fs/leased-stream.ts
function readFailure(error, path) {
  return isVfsError(error) ? error : new VfsError("EIO", "opaque content read failed", path);
}
function checkSize(read, expected, path, complete = false) {
  if (read > expected || complete && read !== expected) {
    throw new VfsError("EIO", "opaque body size does not match metadata", path);
  }
}
function leasedStream(body, path, expires, expected, now) {
  const reader = body.getReader();
  let read = 0;
  let settled = false;
  const checkLease = () => {
    if (now() >= expires) throw new VfsError("EIO", "opaque read lease expired", path);
  };
  return new ReadableStream({
    pull: async (controller) => {
      if (settled) return;
      try {
        checkLease();
        const next = await reader.read();
        if (settled) return;
        checkLease();
        if (next.done) {
          checkSize(read, expected, path, true);
          settled = true;
          reader.releaseLock();
          controller.close();
          return;
        }
        read += next.value.byteLength;
        checkSize(read, expected, path);
        controller.enqueue(next.value);
      } catch (error) {
        if (settled) return;
        settled = true;
        await reader.cancel(error).catch(() => void 0);
        reader.releaseLock();
        controller.error(readFailure(error, path));
      }
    },
    cancel: async (reason) => {
      settled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    }
  });
}

// src/fs/stats.ts
var FsStats = class {
  constructor(entry, nlink = 1) {
    this.entry = entry;
    this.nlink = entry.nlink ?? nlink;
    this.size = entry.sizeBytes;
    this.mode = entry.mode;
    this.ino = entry.ino;
    this.uid = entry.uid;
    this.gid = entry.gid;
    this.mtimeMs = entry.modifiedAtMs;
    this.ctimeMs = entry.changedAtMs ?? entry.modifiedAtMs;
    this.birthtimeMs = entry.createdAtMs;
    this.revision = entry.revision;
    this.mutationToken = entry.mutationToken;
    this.mtime = new Date(this.mtimeMs);
    this.ctime = new Date(this.ctimeMs);
    this.birthtime = new Date(this.birthtimeMs);
  }
  entry;
  size;
  mode;
  ino;
  uid;
  gid;
  dev = 0;
  nlink;
  mtimeMs;
  ctimeMs;
  birthtimeMs;
  revision;
  mutationToken;
  mtime;
  ctime;
  birthtime;
  isFile() {
    return this.entry.kind === "file";
  }
  isDirectory() {
    return this.entry.kind === "directory";
  }
  isSymbolicLink() {
    return this.entry.kind === "symlink";
  }
};
var FsDirent = class {
  constructor(entry) {
    this.entry = entry;
    this.name = entry.name;
  }
  entry;
  name;
  isFile() {
    return this.entry.kind === "file";
  }
  isDirectory() {
    return this.entry.kind === "directory";
  }
  isSymbolicLink() {
    return this.entry.kind === "symlink";
  }
};

// src/fs/sql-file-handles.ts
function detachedRow(json) {
  const value = JSON.parse(json);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new VfsError("EIO", "invalid detached inode");
  const row = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== null && typeof field !== "number" && typeof field !== "string")
      throw new VfsError("EIO", "invalid inode column");
    row[key] = field;
  }
  return row;
}
var SqlFileHandles = class {
  constructor(port) {
    this.port = port;
    port.retain((path, recursive, root) => this.retain(path, recursive, root));
  }
  port;
  pins = /* @__PURE__ */ new Map();
  nextDescriptor = 3;
  link(from, to, access) {
    installHardLinkTriggers(this.port);
    this.port.transaction(() => {
      const source = this.port.sourceEntry(from, access);
      if (source.kind === "directory")
        throw new VfsError("EPERM", "directories cannot be hard linked", from);
      const destination = this.port.openEntry(to, false, false, true, true, 438, access);
      const identity = source.linkIdentity ?? source.id;
      const count = (source.linkCount ?? 1) + 1;
      this.port.capacity(source.contentClass === "inline" ? source.sizeBytes : 0, to);
      this.port.sql.exec(
        "UPDATE vfs_entries SET link_identity = ?, link_count = ? WHERE id = ?",
        identity,
        count,
        source.id
      );
      this.port.sql.exec(
        `UPDATE vfs_entries SET kind = ?, content_class = ?, opaque_object_id = ?, link_target = ?,
        size_bytes = ?, mode = ?, uid = ?, gid = ?, created_at_ms = ?, modified_at_ms = ?, changed_at_ms = ?,
        link_identity = ?, link_count = ?, revision = ?, mutation_version = ? WHERE id = ?`,
        source.kind,
        source.contentClass,
        source.opaqueObjectId,
        source.linkTarget,
        source.sizeBytes,
        source.mode,
        source.uid,
        source.gid,
        source.createdAtMs,
        source.modifiedAtMs,
        this.port.now(),
        identity,
        count,
        Math.max(source.revision, destination.revision) + 1,
        Math.max(source.mutationVersion, destination.mutationVersion) + 1,
        destination.id
      );
      if (source.contentClass === "inline")
        this.port.sql.exec(
          "INSERT INTO vfs_inline_chunks SELECT ?, chunk_index, body FROM vfs_inline_chunks WHERE entry_id = ?",
          destination.id,
          source.id
        );
      this.port.usage(source.contentClass === "inline" ? source.sizeBytes : 0);
      this.port.linked();
      this.port.publish(this.entry(identity));
    });
  }
  open(path, flags, mode, access) {
    if (!/^(r|r\+|w|w\+|wx|wx\+|a|a\+|ax|ax\+)$/.test(flags))
      throw new VfsError("EINVAL", "unsupported open flags", path);
    if (this.count() >= 1024) throw new VfsError("EMFILE", "too many open handles");
    const readable = flags.startsWith("r") || flags.endsWith("+");
    const writable = !flags.startsWith("r") || flags.endsWith("+");
    const entry = this.port.openEntry(
      path,
      readable,
      writable,
      !flags.startsWith("r"),
      flags.includes("x"),
      mode,
      access
    );
    const identity = entry.linkIdentity ?? entry.id;
    this.pins.set(identity, (this.pins.get(identity) ?? 0) + 1);
    try {
      if (flags.startsWith("w")) this.truncate(identity, 0);
      return new FsFileHandle(
        this,
        identity,
        this.nextDescriptor++,
        readable,
        writable,
        flags.startsWith("a")
      );
    } catch (error) {
      this.release(identity);
      throw error;
    }
  }
  count() {
    let count = 0;
    for (const value of this.pins.values()) count += value;
    return count;
  }
  retained(ino) {
    return firstRow(
      this.port.sql.exec("SELECT entry_json FROM vfs_detached_inodes WHERE id = ?", ino)
    );
  }
  entry(ino) {
    const row = firstRow(
      this.port.sql.exec(
        `SELECT ${ENTRY_COLUMNS} FROM vfs_entries e WHERE id = (
           SELECT id FROM vfs_entries WHERE id = ?
           UNION SELECT id FROM vfs_entries WHERE link_identity = ?
           ORDER BY id LIMIT 1
         )`,
        ino,
        ino
      )
    );
    if (row !== void 0) return parseEntry(row, this.epoch(row));
    const detached = this.retained(ino);
    if (detached === void 0) throw new VfsError("EBADF", "inode is no longer open");
    const columns = detachedRow(stringColumn(detached, "entry_json"));
    return parseEntry(columns, this.epoch(columns));
  }
  // The epoch is immutable and read only on first handle use, not ordinary paths.
  mutationEpoch;
  epoch(_row) {
    this.mutationEpoch ??= stringColumn(
      this.port.sql.exec("SELECT mutation_epoch FROM vfs_state WHERE singleton = 1").one(),
      "mutation_epoch"
    );
    return this.mutationEpoch;
  }
  retain(path, recursive, root) {
    let retained = 0;
    for (const ino of this.retainedCandidates(root, recursive)) {
      const row = firstRow(
        this.port.sql.exec(
          `SELECT ${ENTRY_COLUMNS} FROM vfs_entries e WHERE id = (
           SELECT id FROM vfs_entries WHERE id = ?
           UNION SELECT id FROM vfs_entries WHERE link_identity = ?
           ORDER BY id LIMIT 1
         )`,
          ino,
          ino
        )
      );
      if (row === void 0) continue;
      const entry = parseEntry(row, this.epoch(row));
      if (entry.path !== path && !(recursive && isDescendant(path, entry.path))) continue;
      if (this.hasRemainingName(entry, path, recursive)) continue;
      const inlineBytes = entry.contentClass === "inline" ? entry.sizeBytes : 0;
      this.port.sql.exec(
        "INSERT INTO vfs_detached_inodes(id, entry_json, inline_bytes, opaque_object_id) VALUES (?, ?, ?, ?)",
        ino,
        JSON.stringify({ ...row, id: ino, link_count: 0, changed_at_ms: this.port.now() }),
        inlineBytes,
        entry.opaqueObjectId
      );
      if (entry.contentClass === "inline")
        this.port.sql.exec(
          "INSERT INTO vfs_detached_chunks SELECT ?, chunk_index, body FROM vfs_inline_chunks WHERE entry_id = ?",
          ino,
          entry.id
        );
      retained += inlineBytes;
    }
    return retained;
  }
  retainedCandidates(root, recursive) {
    if (recursive) return this.pins.keys();
    const identity = root.linkIdentity ?? root.id;
    return this.pins.has(identity) ? [identity] : [];
  }
  hasRemainingName(entry, path, recursive) {
    if (entry.linkIdentity == null) return false;
    return this.port.sql.exec("SELECT path FROM vfs_entries WHERE link_identity = ?", entry.linkIdentity).toArray().some((item) => {
      const name = stringColumn(item, "path");
      return name !== path && !(recursive && isDescendant(path, name));
    });
  }
  release(ino) {
    const count = this.pins.get(ino);
    if (count === void 0) return;
    if (count > 1) {
      this.pins.set(ino, count - 1);
      return;
    }
    this.port.transaction(() => {
      const detached = firstRow(
        this.port.sql.exec(
          "SELECT inline_bytes, opaque_object_id FROM vfs_detached_inodes WHERE id = ?",
          ino
        )
      );
      if (detached === void 0) return;
      this.port.sql.exec("DELETE FROM vfs_detached_chunks WHERE entry_id = ?", ino);
      this.port.sql.exec("DELETE FROM vfs_detached_inodes WHERE id = ?", ino);
      this.port.usage(-integerColumn(detached, "inline_bytes"));
      if (typeof detached["opaque_object_id"] === "number")
        this.port.reclaimObject(detached["opaque_object_id"]);
    });
    this.pins.delete(ino);
  }
  sync() {
    return this.port.sync();
  }
  maintenance() {
    return this.port.maintenance();
  }
  stat(ino) {
    const entry = this.entry(ino);
    return new FsStats(this.port.stat(entry), entry.linkCount ?? 1);
  }
  async read(ino, offset, length) {
    return this.readEntry(this.entry(ino), offset, length);
  }
  readRemaining(ino, offset) {
    const entry = this.entry(ino);
    return this.readEntry(entry, offset, Math.max(0, entry.sizeBytes - offset));
  }
  async readEntry(entry, offset, length) {
    const selected = Math.min(length, Math.max(0, entry.sizeBytes - offset));
    if (selected === 0) return new Uint8Array();
    if (entry.contentClass === "opaque") return this.readOpaque(entry, offset, selected);
    const table = entry.linkCount !== 0 ? "vfs_inline_chunks" : "vfs_detached_chunks";
    const first = this.port.sql.exec(
      `SELECT length(body) AS size FROM ${table} WHERE entry_id = ? AND chunk_index = 0`,
      entry.id
    ).one();
    const width = integerColumn(first, "size");
    if (width <= 0) throw new VfsError("EIO", "invalid inode chunk width");
    const begin = Math.floor(offset / width);
    const end = Math.ceil((offset + selected) / width);
    const reserved = Math.min(entry.sizeBytes, (end - begin) * width) + selected;
    this.port.budget.acquire(reserved);
    try {
      const rows = this.port.sql.exec(
        `SELECT chunk_index, body FROM ${table} WHERE entry_id = ? AND chunk_index >= ? AND chunk_index < ? ORDER BY chunk_index`,
        entry.id,
        begin,
        end
      ).toArray();
      const output = new Uint8Array(selected);
      let consumed = 0;
      for (const row of rows) {
        const base = integerColumn(row, "chunk_index") * width;
        const body = new Uint8Array(blobColumn(row, "body"));
        const from = Math.max(0, offset - base);
        const to = Math.min(body.byteLength, offset + selected - base);
        if (to > from) {
          output.set(body.subarray(from, to), base + from - offset);
          consumed += to - from;
        }
      }
      if (consumed !== selected) throw new VfsError("EIO", "inode body does not match range");
      return output;
    } finally {
      this.port.budget.release(reserved);
    }
  }
  async readOpaque(entry, offset, length) {
    const store = this.port.store;
    if (store === void 0 || entry.opaqueObjectId === null)
      throw new VfsError("ENOTSUP", "opaque handle requires a store");
    const expires = this.port.now() + 6e4;
    const object = this.port.sql.exec(
      "UPDATE vfs_opaque_objects SET retain_until_ms = MAX(retain_until_ms, ?) WHERE id = ? RETURNING r2_key",
      expires,
      entry.opaqueObjectId
    ).one();
    const stream = await store.getStream(stringColumn(object, "r2_key"), { offset, length });
    if (stream === null) throw new VfsError("EIO", "opaque body is missing");
    if (this.port.now() >= expires) {
      await stream.cancel();
      throw new VfsError("EIO", "opaque read lease expired", entry.path);
    }
    const stat = this.port.stat(entry);
    if (stat.kind !== "file" || stat.contentClass !== "opaque")
      throw new VfsError("EIO", "invalid open inode");
    return materialize(
      {
        stat: { ...stat, sizeBytes: length },
        stream: leasedStream(stream, entry.path, expires, length, () => this.port.now())
      },
      this.port.maximum,
      this.port.budget
    );
  }
  write(ino, body, offset, append2) {
    return this.port.transaction(() => {
      const entry = this.entry(ino);
      if (entry.contentClass !== "inline")
        throw new VfsError("ENOTSUP", "random opaque writes require a content tier");
      const start = append2 ? entry.sizeBytes : position(offset ?? 0);
      if (body.byteLength === 0) return start;
      const size = Math.max(entry.sizeBytes, start + body.byteLength);
      this.validateSize(size, entry.path);
      this.port.capacity((size - entry.sizeBytes) * Math.max(1, entry.linkCount ?? 1), entry.path);
      const detached = entry.linkCount === 0;
      const table = detached ? "vfs_detached_chunks" : "vfs_inline_chunks";
      this.writeChunks(entry, body, start, size, table);
      this.update(entry, size, detached);
      return start + body.byteLength;
    });
  }
  writeChunks(entry, body, start, size, table) {
    const first = firstRow(
      this.port.sql.exec(
        `SELECT length(body) AS size FROM ${table} WHERE entry_id = ? AND chunk_index = 0`,
        entry.id
      )
    );
    const firstSize = first === void 0 ? 0 : integerColumn(first, "size");
    const chunkBytes = firstSize < entry.sizeBytes ? firstSize : Math.max(firstSize, this.port.chunkBytes);
    const begin = Math.floor(Math.min(start, entry.sizeBytes) / chunkBytes);
    const end = Math.ceil((start + body.byteLength) / chunkBytes);
    for (let index = begin; index < end; index++) {
      const base = index * chunkBytes;
      const chunk = new Uint8Array(Math.min(chunkBytes, size - base));
      const oldEnd = Math.min(base + chunk.byteLength, entry.sizeBytes);
      if (base < oldEnd && (start > base || start + body.byteLength < oldEnd)) {
        const old = firstRow(
          this.port.sql.exec(
            `SELECT body FROM ${table} WHERE entry_id = ? AND chunk_index = ?`,
            entry.id,
            index
          )
        );
        if (old !== void 0)
          chunk.set(new Uint8Array(blobColumn(old, "body")).subarray(0, chunk.byteLength));
      }
      const from = Math.max(start, base);
      const to = Math.min(start + body.byteLength, base + chunk.byteLength);
      if (to > from) chunk.set(body.subarray(from - start, to - start), from - base);
      this.port.sql.exec(
        `INSERT INTO ${table}(entry_id, chunk_index, body) VALUES (?, ?, ?) ON CONFLICT(entry_id, chunk_index) DO UPDATE SET body = excluded.body`,
        entry.id,
        index,
        chunk
      );
    }
  }
  truncate(ino, size) {
    this.validateSize(size, "");
    const entry = this.entry(ino);
    if (entry.contentClass !== "inline")
      throw new VfsError("ENOTSUP", "opaque truncate requires a content tier");
    if (size > entry.sizeBytes) {
      this.write(ino, new Uint8Array(size - entry.sizeBytes), entry.sizeBytes, false);
      return;
    }
    this.port.transaction(() => {
      const current = this.entry(ino);
      const detached = entry.linkCount === 0;
      const table = detached ? "vfs_detached_chunks" : "vfs_inline_chunks";
      if (size === 0) this.port.sql.exec(`DELETE FROM ${table} WHERE entry_id = ?`, current.id);
      else {
        const first = this.port.sql.exec(
          `SELECT length(body) AS size FROM ${table} WHERE entry_id = ? AND chunk_index = 0`,
          current.id
        ).one();
        const width = integerColumn(first, "size");
        if (width <= 0) throw new VfsError("EIO", "invalid inode chunk width");
        const end = Math.ceil(size / width);
        this.port.sql.exec(
          `DELETE FROM ${table} WHERE entry_id = ? AND chunk_index >= ?`,
          current.id,
          end
        );
        const tail = size % width;
        if (tail !== 0)
          this.port.sql.exec(
            `UPDATE ${table} SET body = substr(body, 1, ?) WHERE entry_id = ? AND chunk_index = ?`,
            tail,
            current.id,
            end - 1
          );
      }
      this.update(current, size, detached);
    });
  }
  validateSize(size, path) {
    position(size);
    if (size > this.port.maximum)
      throw new VfsError("EFBIG", "inode exceeds inline file limit", path);
  }
  update(entry, size, detached) {
    const now = this.port.now();
    if (detached)
      this.port.sql.exec(
        `UPDATE vfs_detached_inodes SET inline_bytes = ?, entry_json = json_set(entry_json,
      '$.size_bytes', ?, '$.modified_at_ms', ?, '$.changed_at_ms', ?, '$.revision', ?, '$.mutation_version', ?) WHERE id = ?`,
        size,
        size,
        now,
        now,
        entry.revision + 1,
        entry.mutationVersion + 1,
        entry.id
      );
    else {
      this.port.sql.exec(
        "UPDATE vfs_entries SET size_bytes = ?, modified_at_ms = ?, changed_at_ms = ?, body_digest = NULL, body_digest_revision = NULL, revision = revision + 1, mutation_version = mutation_version + 1 WHERE id = ?",
        size,
        now,
        now,
        entry.id
      );
      this.port.publish({
        ...entry,
        sizeBytes: size,
        modifiedAtMs: now,
        changedAtMs: now,
        revision: entry.revision + 1,
        mutationVersion: entry.mutationVersion + 1
      });
    }
    this.port.usage((size - entry.sizeBytes) * Math.max(1, entry.linkCount ?? 1));
  }
};

// src/fs/promises.ts
function encoding(options) {
  const value = typeof options === "string" ? options : options?.encoding ?? null;
  if (value !== null && value !== "utf8" && value !== "utf-8") {
    throw new VfsError("ENOTSUP", "only UTF-8 text encoding is supported");
  }
  return value;
}
var FsPromises = class {
  constructor(vfs, options) {
    this.vfs = vfs;
    this.options = options;
    this.maximum = options.maxReadFileBytes ?? MAX_INLINE_FILE_BYTES;
    validatePositiveInteger(this.maximum, "maxReadFileBytes");
    this.budget = new InFlightByteBudget(options.maxInFlightReadBytes ?? 32 * 1024 * 1024);
  }
  vfs;
  options;
  maximum;
  budget;
  path(path) {
    return normalizeFileSystemPath(path, this.options.cwd ?? "/");
  }
  async readFile(path, options) {
    const textEncoding = encoding(options);
    if (typeof options === "object" && options?.flag !== void 0 && options.flag !== "r") {
      throw new VfsError("ENOTSUP", "unsupported read flag", path);
    }
    const resolved = this.path(path);
    const opened = this.options.content === void 0 ? this.vfs.readFile(resolved) : await this.options.content.open(resolved);
    const bytes2 = await materialize(opened, this.maximum, this.budget);
    return textEncoding === null ? bytes2 : new TextDecoder().decode(bytes2);
  }
  async writeFile(path, body, options) {
    encoding(options);
    const resolved = this.path(path);
    const settings = typeof options === "object" ? options : void 0;
    const flag = settings?.flag ?? "w";
    if (!["w", "wx", "a", "ax"].includes(flag))
      throw new VfsError("ENOTSUP", "unsupported write flag", path);
    if (flag === "a" && await this.append(resolved, body)) return;
    if (flag === "wx" || flag === "ax") this.assertAbsent(resolved);
    const mode = this.creationMode(resolved, settings?.mode);
    const write = {
      disposition: flag === "wx" || flag === "ax" || flag === "a" ? "create" : "upsert",
      ...mode === void 0 ? {} : { mode }
    };
    if (this.options.content === void 0) await this.vfs.writeFile(resolved, body, write);
    else await this.options.content.write(resolved, body, write);
  }
  async append(path, body) {
    try {
      if (this.options.content?.append === void 0) await this.vfs.appendFile(path, body);
      else await this.options.content.append(path, body);
      return true;
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return false;
      throw error;
    }
  }
  assertAbsent(path) {
    try {
      this.vfs.lstat(path);
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return;
      throw error;
    }
    throw new VfsError("EEXIST", "file or link already exists", path);
  }
  creationMode(path, mode) {
    if (mode === void 0) return void 0;
    try {
      this.vfs.stat(path);
      return void 0;
    } catch (error) {
      if (error instanceof VfsError && error.code === "ENOENT") return 32768 | mode & 4095;
      throw error;
    }
  }
  async open(path, flags = "r", mode = 438) {
    installHandleFactory((port) => new SqlFileHandles(port));
    if (!("openFileHandle" in this.vfs) || typeof this.vfs.openFileHandle !== "function")
      throw new VfsError("ENOTSUP", "filesystem does not support inode handles", path);
    const open = this.vfs.openFileHandle;
    return open.call(this.vfs, this.path(path), flags, mode);
  }
  async link(from, to) {
    installHandleFactory((port) => new SqlFileHandles(port));
    if (!("linkFile" in this.vfs) || typeof this.vfs.linkFile !== "function")
      throw new VfsError("ENOTSUP", "filesystem does not support hard links");
    const link = this.vfs.linkFile;
    link.call(this.vfs, this.path(from), this.path(to));
  }
  async truncate(path, size = 0) {
    const handle = await this.open(path, "r+");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }
  async stat(path) {
    const resolved = this.path(path);
    return new FsStats(
      this.options.metadataCache?.stat(this.vfs, resolved, true) ?? this.vfs.stat(resolved)
    );
  }
  async lstat(path) {
    const resolved = this.path(path);
    return new FsStats(
      this.options.metadataCache?.stat(this.vfs, resolved, false) ?? this.vfs.lstat(resolved)
    );
  }
  async readdir(path, options = {}) {
    const resolved = this.path(path);
    const entries = this.options.metadataCache?.list(this.vfs, resolved) ?? this.vfs.list(resolved);
    return options.withFileTypes ? entries.map((entry) => new FsDirent(entry)) : entries.map((entry) => entry.name);
  }
  async mkdir(path, options) {
    const resolved = this.path(path);
    const recursive = typeof options === "object" && options.recursive === true;
    this.vfs.mkdir(resolved, recursive, typeof options === "object" ? options.mode : options);
  }
  async unlink(path) {
    const resolved = this.path(path);
    if (this.vfs.lstat(resolved).kind === "directory")
      throw new VfsError("EISDIR", "is a directory", resolved);
    await this.vfs.remove(resolved);
  }
  async rmdir(path) {
    const resolved = this.path(path);
    if (this.vfs.lstat(resolved).kind !== "directory")
      throw new VfsError("ENOTDIR", "not a directory", resolved);
    await this.vfs.remove(resolved);
  }
  async rm(path, options = {}) {
    const resolved = this.path(path);
    try {
      if (options.recursive !== true && this.vfs.lstat(resolved).kind === "directory") {
        throw new VfsError("EISDIR", "recursive option is required for a directory", resolved);
      }
      await this.vfs.remove(resolved, { recursive: options.recursive ?? false });
    } catch (error) {
      if (!(options.force && error instanceof VfsError && error.code === "ENOENT")) throw error;
    }
  }
  async rename(from, to) {
    await this.vfs.move(this.path(from), this.path(to), { replace: true });
  }
  async chmod(path, mode) {
    const resolved = this.path(path);
    const current = this.vfs.stat(resolved);
    this.vfs.setMetadata(resolved, { mode: current.mode & ~4095 | mode & 4095 });
  }
  async readlink(path) {
    return this.vfs.readlink(this.path(path));
  }
  async symlink(target, path) {
    this.vfs.symlink(this.path(path), target);
  }
};
function createFsAdapter(fileSystem, options = {}) {
  const fs = new FsPromises(fileSystem, options);
  return {
    promises: {
      open: fs.open.bind(fs),
      link: fs.link.bind(fs),
      truncate: fs.truncate.bind(fs),
      readFile: fs.readFile.bind(fs),
      writeFile: fs.writeFile.bind(fs),
      stat: fs.stat.bind(fs),
      lstat: fs.lstat.bind(fs),
      readdir: fs.readdir.bind(fs),
      mkdir: fs.mkdir.bind(fs),
      unlink: fs.unlink.bind(fs),
      rmdir: fs.rmdir.bind(fs),
      rm: fs.rm.bind(fs),
      rename: fs.rename.bind(fs),
      chmod: fs.chmod.bind(fs),
      readlink: fs.readlink.bind(fs),
      symlink: fs.symlink.bind(fs)
    }
  };
}

// src/fs/metadata.ts
var FsMetadataCache = class {
  constructor(maxEntries = 4096) {
    this.maxEntries = maxEntries;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new VfsError("EINVAL", "metadata cache size must be a positive safe integer");
    }
  }
  maxEntries;
  entries = /* @__PURE__ */ new Map();
  owner;
  epoch = 0;
  evictedSinceClear = false;
  onEvent = (event) => {
    if (event.type !== "vfs.mutation") return;
    if (event.op === "write" && event.subtree === void 0 && !this.evictedSinceClear) {
      this.entries.delete(event.path);
      this.epoch += 1;
    } else this.clear();
  };
  clear() {
    this.entries.clear();
    this.evictedSinceClear = false;
    this.epoch += 1;
  }
  /** Never shares successful permission checks across filesystem views. */
  bind(fileSystem) {
    if (this.owner === void 0) this.owner = fileSystem;
    else if (this.owner !== fileSystem) {
      throw new VfsError("EINVAL", "metadata cache belongs to another filesystem view");
    }
  }
  remember(stat) {
    this.entries.delete(stat.path);
    this.entries.set(stat.path, { ...stat });
    if (this.entries.size > this.maxEntries) {
      this.evictedSinceClear = true;
      const oldest = this.entries.keys().next().value;
      if (oldest !== void 0) this.entries.delete(oldest);
    }
  }
  stat(fileSystem, path, follow) {
    this.bind(fileSystem);
    const normalized = normalizePath(path);
    const cached = pathRequiresDirectory(path) || hasDotSegments(path) ? void 0 : this.entries.get(normalized);
    if (cached !== void 0 && (!follow || cached.kind !== "symlink")) {
      this.entries.delete(normalized);
      this.entries.set(normalized, cached);
      return { ...cached };
    }
    const stat = follow ? fileSystem.stat(path) : fileSystem.lstat(path);
    if (stat.path === normalized && (!follow || stat.kind !== "symlink")) this.remember(stat);
    return stat;
  }
  list(fileSystem, path) {
    this.bind(fileSystem);
    const epoch = this.epoch;
    const entries = fileSystem.list(path);
    if (this.epoch === epoch) {
      for (const entry of entries) if (entry.contentClass !== "opaque") this.remember(entry);
    }
    return entries;
  }
};

// demo/benchmark-git-recovery.ts
import * as git9 from "isomorphic-git";

// src/vfs/capabilities.ts
function supportsPosixCredentials(fileSystem) {
  return typeof Reflect.get(fileSystem, "forCredentials") === "function";
}

// src/shell/events.ts
function emitShellEvent(sink, event) {
  if (sink === void 0) return;
  try {
    sink(event);
  } catch {
  }
}

// src/shell/budget.ts
var MAX_PIPELINE_EDGE_BYTES = 8 * 1024 * 1024;
var DEFAULT_SHELL_LIMITS = {
  maxScriptBytes: 1024 * 1024,
  maxTotalSourceBytes: 4 * 1024 * 1024,
  maxAstNodes: 1e4,
  maxNestingDepth: 64,
  maxCommands: 1e4,
  maxSteps: 1e5,
  maxLoopIterations: 1e4,
  maxFunctionDepth: 64,
  maxSourceDepth: 16,
  maxScriptDepth: 8,
  maxCommandSubstitutionBytes: 1024 * 1024,
  maxPipelineBytes: 8 * 1024 * 1024,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 8 * 1024 * 1024,
  maxMaterializedOutputBytes: 8 * 1024 * 1024,
  maxTotalIoBytes: 32 * 1024 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxBufferedRecords: 1e5,
  maxGlobMatches: 1e4,
  maxExpansionWork: 1e7,
  maxExpansionChars: 1024 * 1024,
  maxExpansionFields: 1e4,
  maxMutations: 1e4,
  deadlineMs: 3e4,
  outputIdleTimeoutMs: 5e3
};
function positive(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VfsError("EINVAL", `${name} must be a positive safe integer`);
  }
  return value;
}
function resolveShellLimits(input = {}) {
  const limits = { ...DEFAULT_SHELL_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) positive(value, name);
  if (limits.maxPipelineBytes > MAX_PIPELINE_EDGE_BYTES) {
    throw new VfsError("EINVAL", `maxPipelineBytes cannot exceed ${MAX_PIPELINE_EDGE_BYTES}`);
  }
  return limits;
}
var ExecutionBudget = class {
  limits;
  startedAtMs;
  now;
  onEvent;
  steps = 0;
  commands = 0;
  loopIterations = 0;
  ioBytes = 0;
  mutations = 0;
  globMatches = 0;
  expansionCharacters = 0;
  expansionFields = 0;
  expansionWorkUnits = 0;
  bufferedBytes = 0;
  constructor(limits, now, onEvent) {
    this.limits = limits;
    this.now = now;
    this.onEvent = onEvent;
    this.startedAtMs = now();
  }
  /** Reports the limit that refused work, then fails. */
  exceeded(limit, used, code, message) {
    emitShellEvent(this.onEvent, {
      type: "shell.limit",
      limit,
      used,
      max: this.limits[limit]
    });
    throw new VfsError(code, message);
  }
  elapsedMs() {
    return this.now() - this.startedAtMs;
  }
  checkDeadline() {
    const elapsed = this.elapsedMs();
    if (elapsed > this.limits.deadlineMs) {
      this.exceeded("deadlineMs", elapsed, "ETIMEDOUT", "shell execution deadline exceeded");
    }
  }
  remainingDeadlineMs() {
    return Math.max(0, this.limits.deadlineMs - (this.now() - this.startedAtMs));
  }
  step(count = 1) {
    this.checkDeadline();
    this.steps += count;
    if (this.steps > this.limits.maxSteps) {
      this.exceeded("maxSteps", this.steps, "E2BIG", "shell execution step limit exceeded");
    }
  }
  command() {
    this.step();
    this.commands += 1;
    if (this.commands > this.limits.maxCommands) {
      this.exceeded("maxCommands", this.commands, "E2BIG", "shell command limit exceeded");
    }
  }
  loop() {
    this.step();
    this.loopIterations += 1;
    if (this.loopIterations > this.limits.maxLoopIterations) {
      this.exceeded(
        "maxLoopIterations",
        this.loopIterations,
        "E2BIG",
        "shell loop iteration limit exceeded"
      );
    }
  }
  io(bytes2) {
    this.checkDeadline();
    this.ioBytes += bytes2;
    if (this.ioBytes > this.limits.maxTotalIoBytes) {
      this.exceeded(
        "maxTotalIoBytes",
        this.ioBytes,
        "E2BIG",
        "shell total I/O byte limit exceeded"
      );
    }
  }
  mutation(count = 1) {
    this.checkDeadline();
    this.mutations += count;
    if (this.mutations > this.limits.maxMutations) {
      this.exceeded(
        "maxMutations",
        this.mutations,
        "E2BIG",
        "shell filesystem mutation limit exceeded"
      );
    }
  }
  glob(count = 1) {
    this.checkDeadline();
    this.globMatches += count;
    if (this.globMatches > this.limits.maxGlobMatches) {
      this.exceeded(
        "maxGlobMatches",
        this.globMatches,
        "E2BIG",
        "pathname expansion match limit exceeded"
      );
    }
  }
  expansionWork(count = 1) {
    this.checkDeadline();
    this.expansionWorkUnits += count;
    if (this.expansionWorkUnits > this.limits.maxExpansionWork) {
      this.exceeded(
        "maxExpansionWork",
        this.expansionWorkUnits,
        "E2BIG",
        "shell expansion work limit exceeded"
      );
    }
  }
  checkExpansionOutput(characters, fields2 = 1) {
    this.checkDeadline();
    if (this.expansionCharacters + characters > this.limits.maxExpansionChars) {
      this.exceeded(
        "maxExpansionChars",
        this.expansionCharacters + characters,
        "E2BIG",
        "shell expansion character limit exceeded"
      );
    }
    if (this.expansionFields + fields2 > this.limits.maxExpansionFields) {
      this.exceeded(
        "maxExpansionFields",
        this.expansionFields + fields2,
        "E2BIG",
        "shell expansion field limit exceeded"
      );
    }
  }
  expansionOutput(characters, fields2 = 1) {
    this.checkExpansionOutput(characters, fields2);
    this.expansionCharacters += characters;
    this.expansionFields += fields2;
  }
  remainingBufferedBytes() {
    return this.limits.maxBufferedBytes - this.bufferedBytes;
  }
  buffered(bytes2) {
    this.checkDeadline();
    this.bufferedBytes += bytes2;
    if (this.bufferedBytes > this.limits.maxBufferedBytes) {
      const attempted = this.bufferedBytes;
      this.bufferedBytes -= bytes2;
      this.exceeded("maxBufferedBytes", attempted, "E2BIG", "shell buffered-byte limit exceeded");
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.bufferedBytes -= bytes2;
    };
  }
};

// src/shell/commands/applet.ts
var APPLET_DIRECTORIES = ["/bin", "/usr/bin"];
var SLASH = 47;
function isShellApplet(command) {
  return "spec" in command;
}
// @__NO_SIDE_EFFECTS__
function defineApplet(spec, runner) {
  return {
    name: spec.name,
    spec,
    run(context, argv, fds) {
      return {
        completed: Promise.resolve().then(async () => ({
          exitCode: await runner(context, argv, fds)
        }))
      };
    }
  };
}
function appletPathName(name) {
  if (name.charCodeAt(0) !== SLASH) return void 0;
  const separator = name.lastIndexOf("/");
  const base = name.slice(separator + 1);
  if (base === "" || base === "." || base === "..") return void 0;
  return APPLET_DIRECTORIES.includes(name.slice(0, separator)) ? base : void 0;
}
function splitSearchPath(value) {
  return value.split(":");
}
function createAppletRegistry(commands) {
  const registered = [...commands];
  const byName = /* @__PURE__ */ new Map();
  for (const command of registered) {
    const spec = isShellApplet(command) ? command.spec : void 0;
    const entry = { command, kind: spec?.kind ?? "program" };
    for (const name of [command.name, ...spec?.aliases ?? []]) {
      if (byName.has(name)) throw new VfsError("EINVAL", `duplicate command: ${name}`);
      byName.set(name, entry);
    }
  }
  let sortedNames;
  return {
    commands: registered,
    find(name) {
      return byName.get(name);
    },
    isAppletDirectory(directory) {
      return APPLET_DIRECTORIES.includes(directory);
    },
    names() {
      sortedNames ??= [...byName.keys()].sort(compareUtf8);
      return sortedNames;
    },
    findPath(path) {
      const base = appletPathName(path);
      if (base === void 0) return void 0;
      const entry = byName.get(base);
      return entry === void 0 || entry.kind === "session-builtin" ? void 0 : entry;
    }
  };
}

// src/shell/batch-stats.ts
function readStatBatch(inner, paths, options, roots2, read) {
  validateStatPaths(paths);
  const ordinary = options.follow === false && paths.every(
    (path) => path.startsWith("/") && !path.includes("\0") && !hasDotSegments(path) && !path.includes("//") && !path.endsWith("/") && !roots2.some((name) => path === `/${name}` || path.startsWith(`/${name}/`))
  );
  if (ordinary && inner.statMany !== void 0) return inner.statMany(paths, options);
  return paths.map((path) => statResult(() => read(path)));
}

// src/shell/batch-writes.ts
function writeCheckedBatch(fs, entries, checkPath) {
  for (const entry of entries) checkPath(entry.path);
  if (fs.writeFiles === void 0) throw new VfsError("ENOTSUP", "batch writes are unavailable");
  return fs.writeFiles(entries);
}

// src/shell/device-sinks.ts
function nullSink() {
  const sink = {
    async write() {
    },
    async close() {
    },
    async abort() {
    },
    clone: () => sink
  };
  return sink;
}
function aliasSink(inner) {
  return {
    write: (chunk) => inner.write(chunk),
    close: () => inner.close(),
    abort: () => inner.close(),
    clone: () => aliasSink(inner.clone())
  };
}

// src/shell/devices.ts
var DEVICES = {
  "/dev/null": "null",
  "/dev/stdin": "stdin",
  "/dev/stdout": "stdout",
  "/dev/stderr": "stderr",
  "/dev/fd/0": "stdin",
  "/dev/fd/1": "stdout",
  "/dev/fd/2": "stderr"
};
var DEVICE_MODE = 8192 | 438;
var DEVICE_DIRECTORY_MODE = 16877;
var DEVICE_DIRECTORIES = {
  "/dev": ["fd", "null", "stderr", "stdin", "stdout"],
  "/dev/fd": ["0", "1", "2"]
};
var APPLET_MODE = 33261;
var EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function shellDevice(path) {
  return Object.hasOwn(DEVICES, path) ? DEVICES[path] : void 0;
}
function reservedStatBase(path, mode, mutationToken) {
  return {
    path,
    parentPath: path.slice(0, path.lastIndexOf("/")) || "/",
    name: path.slice(path.lastIndexOf("/") + 1),
    ino: NO_ENTRY_IDENTITY,
    sizeBytes: 0,
    mode,
    uid: 0,
    gid: 0,
    createdAtMs: 0,
    modifiedAtMs: 0,
    revision: 1,
    mutationToken
  };
}
function deviceStat(path, device) {
  return {
    ...reservedStatBase(path, DEVICE_MODE, `vfs:device:${device}`),
    kind: "file",
    contentClass: "inline"
  };
}
function appletStat(path) {
  return {
    ...reservedStatBase(path, APPLET_MODE, "vfs:device:dev"),
    kind: "file",
    contentClass: "inline"
  };
}
function directoryStat(path) {
  return {
    ...reservedStatBase(path, DEVICE_DIRECTORY_MODE, "vfs:device:dev"),
    kind: "directory",
    contentClass: null
  };
}
function emptyStream() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    }
  });
}
async function drain(body) {
  if (!(body instanceof ReadableStream)) return;
  const reader = body.getReader();
  for (; ; ) {
    const next = await reader.read();
    if (next.done) return;
  }
}
function localEntryPage(entries, options) {
  if (options?.limit !== void 0 && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new VfsError("EINVAL", "limit must be a positive safe integer");
  }
  const cursor = options?.cursor ?? "";
  const remaining = entries.filter((entry) => entry.path > cursor);
  const limit = options?.limit ?? remaining.length;
  const kept = remaining.slice(0, limit);
  return {
    entries: kept,
    nextCursor: remaining.length > limit ? kept.at(-1)?.path ?? null : null,
    scanned: kept.length
  };
}
function addReservedName(directories, parent, name) {
  const existing = directories.get(parent);
  if (existing === void 0) directories.set(parent, [name]);
  else if (!existing.includes(name)) existing.push(name);
}
function addAppletDirectory(directories, applets, directory, names) {
  const segments = directory.split("/").filter((segment) => segment.length > 0);
  for (let depth = 0; depth < segments.length; depth += 1) {
    const parent = depth === 0 ? "/" : `/${segments.slice(0, depth).join("/")}`;
    addReservedName(directories, parent, segments[depth] ?? "");
    if (!directories.has(parent) && parent !== "/") directories.set(parent, []);
  }
  directories.set(directory, [...names]);
  for (const name of names) applets.add(`${directory}/${name}`);
}
function reservedIndex(options) {
  const directories = /* @__PURE__ */ new Map();
  for (const [path, names] of Object.entries(DEVICE_DIRECTORIES)) directories.set(path, [...names]);
  const applets = /* @__PURE__ */ new Set();
  for (const directory of options.applets?.directories ?? []) {
    addAppletDirectory(directories, applets, directory, options.applets?.names ?? []);
  }
  addReservedName(directories, "/", "dev");
  const rootNames = directories.get("/") ?? ["dev"];
  directories.delete("/");
  for (const names of directories.values()) names.sort();
  return { directories, applets, rootNames };
}
var ReservedPathFileSystem = class {
  #inner;
  /** Reserved directory to the names it holds, including implied parents. */
  #directories;
  /** Reserved paths that are applets rather than devices or directories. */
  #applets;
  constructor(inner, options = {}) {
    this.#inner = inner;
    const index = reservedIndex(options);
    this.#rootNames = index.rootNames;
    this.#directories = index.directories;
    this.#applets = index.applets;
  }
  /** Reserved names that are children of the root. */
  #rootNames;
  inspectWriteTarget(path, follow = true) {
    const at = this.#statAt(path);
    if (at !== void 0) return at;
    this.#refuseMutation(path);
    return this.#inner.inspectWriteTarget(path, follow);
  }
  assertReadable(path) {
    if (this.#at(path) === void 0) this.#inner.assertReadable(path);
  }
  assertWritable(path) {
    if (this.#at(path) === void 0) this.#inner.assertWritable(path);
  }
  /** The device or reserved directory a path names literally, if any. */
  #at(path) {
    const normalized = normalizePath(path);
    const device = shellDevice(normalized);
    if (device !== void 0 || this.#applets.has(normalized)) {
      if (pathRequiresDirectory(path)) {
        throw new VfsError("ENOTDIR", "not a directory", normalized);
      }
      return device === void 0 ? { path: normalized, applet: true } : { path: normalized, device };
    }
    if (this.#directories.has(normalized)) return { path: normalized, directory: true };
    return void 0;
  }
  /**
   * The device a path reaches, following links.
   *
   * A link to `/dev/null` is a link to `/dev/null`: `ln -s /dev/null quiet`
   * then `echo x > quiet` has to discard, and `[ -e quiet ]` has to be true.
   * Only the operations that follow links ask this — `rm` and `mv` name the
   * link itself and use the literal check above.
   */
  #reached(path) {
    const direct = this.#at(path);
    if (direct !== void 0) return direct;
    let resolved;
    try {
      resolved = this.#inner.realpath(path);
    } catch {
      return void 0;
    }
    return resolved === normalizePath(path) ? void 0 : this.#at(resolved);
  }
  /** Refuses a namespace change anywhere in the reserved device paths. */
  #refuseMutation(path) {
    const normalized = normalizePath(path);
    const root = this.#rootNames.find(
      (name) => normalized === `/${name}` || normalized.startsWith(`/${name}/`)
    );
    if (root === void 0) return;
    throw new VfsError("EACCES", `/${root} is reserved and cannot be changed`, normalized);
  }
  #statAt(path, follow = true) {
    const at = follow ? this.#reached(path) : this.#at(path);
    if (at === void 0) return void 0;
    if (at.device !== void 0) return deviceStat(at.path, at.device);
    return at.applet === true ? appletStat(at.path) : directoryStat(at.path);
  }
  stat(path) {
    return this.#statAt(path) ?? this.#inner.stat(path);
  }
  statMany(paths, options = {}) {
    return readStatBatch(
      this.#inner,
      paths,
      options,
      this.#rootNames,
      (path) => options.follow === false ? this.lstat(path) : this.stat(path)
    );
  }
  canUseBulkOperation(operation, path) {
    return this.#at(path) === void 0 && this.#inner.canUseBulkOperation?.(operation, path) === true;
  }
  get availableWriteBufferBytes() {
    return this.#inner.availableWriteBufferBytes ?? 0;
  }
  writeFiles(entries) {
    return writeCheckedBatch(this.#inner, entries, (path) => this.#refuseMutation(path));
  }
  lstat(path) {
    return this.#statAt(path, false) ?? this.#inner.lstat(path);
  }
  readlink(path) {
    if (this.#at(path) !== void 0) {
      throw new VfsError("EINVAL", "not a symbolic link", normalizePath(path));
    }
    return this.#inner.readlink(path);
  }
  realpath(path, options) {
    const at = this.#at(path);
    return at === void 0 ? this.#inner.realpath(path, options) : at.path;
  }
  getMutationToken(path, options) {
    const at = this.#statAt(path);
    return at === void 0 ? this.#inner.getMutationToken(path, options) : at.mutationToken;
  }
  digestFile(path) {
    const at = this.#reached(path);
    if (at === void 0) return this.#inner.digestFile(path);
    if (at.applet === true) {
      throw new VfsError("ENOTSUP", "an applet has no file content to read", at.path);
    }
    if (at.device === void 0) throw new VfsError("EISDIR", "is a directory", at.path);
    if (at.device !== "null") {
      throw new VfsError("EINVAL", "device is not readable", at.path);
    }
    return Promise.resolve(EMPTY_SHA256);
  }
  readFile(path, options) {
    const at = this.#reached(path);
    if (at === void 0) return this.#inner.readFile(path, options);
    if (at.applet === true) {
      throw new VfsError("ENOTSUP", "an applet has no file content to read", at.path);
    }
    if (at.device === void 0) throw new VfsError("EISDIR", "is a directory", at.path);
    if (at.device !== "null") {
      throw new VfsError("EINVAL", "device is not readable", at.path);
    }
    validateByteRange(options?.range, at.path);
    return {
      stat: deviceStat(at.path, at.device),
      stream: emptyStream()
    };
  }
  async writeFile(path, body, options) {
    const discarded = await this.#discard(path, body);
    return discarded ?? await this.#inner.writeFile(path, body, options);
  }
  async appendFile(path, body, options) {
    const discarded = await this.#discard(path, body);
    return discarded ?? await this.#inner.appendFile(path, body, options);
  }
  /**
   * Drops a body written to `/dev/null`, or reports that this is not one.
   *
   * The stream is read to its end rather than ignored so a producer sees its
   * writes accepted and releases whatever it holds. Nothing is charged for the
   * discard itself: the bytes were already metered when they were produced, and
   * charging again would make `cmd > /dev/null` cost more than `cmd > file`.
   */
  async #discard(path, body) {
    const at = this.#reached(path);
    if (at === void 0) return void 0;
    if (at.device !== "null") {
      this.#refuseMutation(at.path);
      return void 0;
    }
    await drain(body);
    const stat = deviceStat(at.path, at.device);
    return {
      path: stat.path,
      revision: stat.revision,
      mutationToken: stat.mutationToken,
      sizeBytes: 0,
      created: false
    };
  }
  list(path) {
    const at = this.#at(path);
    if (at !== void 0) {
      if (at.device !== void 0) throw new VfsError("ENOTDIR", "not a directory", at.path);
      const names = this.#directories.get(at.path) ?? [];
      return names.map((name) => {
        const child = at.path === "/" ? `/${name}` : `${at.path}/${name}`;
        return this.#statAt(child) ?? directoryStat(child);
      });
    }
    const entries = this.#inner.list(path);
    if (normalizePath(path) !== "/") return entries;
    return [...entries, ...this.#rootEntries()].sort(
      (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
  }
  /** The reserved directories that are children of the root. */
  #rootEntries() {
    return this.#rootNames.map((name) => directoryStat(`/${name}`));
  }
  listPage(path, options) {
    const at = this.#at(path);
    if (at !== void 0) return localEntryPage(this.list(path), options);
    const page = this.#inner.listPage(path, options);
    const cursor = options?.cursor ?? "";
    if (normalizePath(path) !== "/") return page;
    const pending = this.#rootEntries().filter((entry) => entry.path > cursor);
    if (pending.length === 0) return page;
    const limit = options?.limit ?? page.entries.length + pending.length;
    const merged = [...page.entries, ...pending].sort(
      (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    const kept = merged.slice(0, limit);
    const truncated = kept.length < merged.length;
    return {
      entries: kept,
      nextCursor: truncated ? kept.at(-1)?.path ?? null : page.nextCursor,
      scanned: page.scanned
    };
  }
  find(options) {
    if (this.#at(options.path) !== void 0) return this.findPage(options).entries;
    const entries = this.#inner.find(options);
    const roots2 = this.#reservedRootsFor(options);
    if (roots2.length === 0) return entries;
    return [...entries, ...roots2].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0).slice(0, options.limit ?? 1e4);
  }
  findPage(options) {
    if (this.#at(options.path) !== void 0)
      return localEntryPage(this.#findHere(options), options);
    const page = this.#inner.findPage(options);
    const cursor = options.cursor ?? "";
    const pending = this.#reservedRootsFor(options).filter((entry) => entry.path > cursor);
    if (pending.length === 0) return page;
    const frontier = page.nextCursor;
    const available = frontier === null ? pending : pending.filter((entry) => entry.path <= frontier);
    if (available.length === 0) return page;
    const limit = options.limit ?? page.entries.length + pending.length;
    const merged = [...page.entries, ...available].sort(
      (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
    const kept = merged.slice(0, limit);
    return {
      entries: kept,
      nextCursor: kept.length < merged.length ? kept.at(-1)?.path ?? null : page.nextCursor,
      scanned: page.scanned
    };
  }
  /**
   * The `/dev` entry a walk of the root should report, if this walk should.
   *
   * A traversal reports `/dev` itself, because `find / -maxdepth 1` and `ls /`
   * are the same question and must not answer differently. It does not report
   * what is inside: those are descriptor paths a recursive reader cannot open,
   * so `grep -r /` would collect errors rather than results. Naming `/dev`
   * directly still lists them.
   */
  #reservedRootsFor(options) {
    if (normalizePath(options.path) !== "/") return [];
    if ((options.maxDepth ?? Number.POSITIVE_INFINITY) < 1) return [];
    if (options.type !== void 0 && options.type !== "directory") return [];
    return this.#rootNames.filter((name) => options.name === void 0 || matchesGlob(name, options.name)).filter((name) => options.pathGlob === void 0 || matchesGlob(`/${name}`, options.pathGlob)).map((name) => directoryStat(`/${name}`));
  }
  #findHere(options) {
    const at = this.#at(options.path);
    if (at === void 0) return [];
    const root = this.#statAt(at.path);
    const found = root === void 0 ? [] : [root];
    if (at.device === void 0) {
      for (const child of this.list(at.path)) {
        found.push(child);
        if (child.kind === "directory") found.push(...this.list(child.path));
      }
    }
    const selected = options.includeRoot === true ? found : found.slice(1);
    return selected.filter(
      (entry) => (options.maxDepth === void 0 || depthFrom(at.path, entry.path) <= options.maxDepth) && (options.type === void 0 || entry.kind === options.type) && (options.name === void 0 || matchesGlob(entry.name, options.name)) && (options.pathGlob === void 0 || matchesGlob(entry.path, options.pathGlob))
    );
  }
  subtreeSummary(path) {
    const at = this.#at(path);
    if (at === void 0) return this.#inner.subtreeSummary(path);
    return {
      entries: this.#findHere({ path: at.path, includeRoot: true }).length,
      inlineBytes: 0,
      logicalFileBytes: 0
    };
  }
  touch(path, options) {
    this.#refuseMutation(path);
    return this.#inner.touch(path, options);
  }
  setMetadata(path, options) {
    this.#refuseMutation(path);
    return this.#inner.setMetadata(path, options);
  }
  setOwnership(path, options) {
    this.#refuseMutation(path);
    return this.#inner.setOwnership(path, options);
  }
  mkdir(path, recursive, mode) {
    this.#refuseMutation(path);
    return this.#inner.mkdir(path, recursive, mode);
  }
  symlink(path, target, options) {
    this.#refuseMutation(path);
    return this.#inner.symlink(path, target, options);
  }
  async remove(path, options) {
    this.#refuseMutation(path);
    return this.#inner.remove(path, options);
  }
  async move(from, to, options) {
    this.#refuseMutation(from);
    this.#refuseMutation(to);
    return this.#inner.move(from, to, options);
  }
  async copy(from, to, options) {
    this.#refuseMutation(to);
    if (this.#at(from) !== void 0) {
      throw new VfsError("EINVAL", "cannot copy a device", normalizePath(from));
    }
    return this.#inner.copy(from, to, options);
  }
};
function deviceInput(device, fds, path) {
  if (device === "null") return emptyStream();
  if (device === "stdin") return fds[0];
  throw new VfsError("EINVAL", "device is not readable", path);
}
function deviceSink(device, fds, path) {
  if (device === "null") return nullSink();
  if (device === "stdout") return aliasSink(fds[1].clone());
  if (device === "stderr") return aliasSink(fds[2].clone());
  throw new VfsError("EINVAL", "device is not writable", path);
}

// src/shell/fs-origin.ts
var roots = /* @__PURE__ */ new WeakMap();
var views = /* @__PURE__ */ new WeakMap();
function registerFileSystemOrigin(view, root) {
  let identity = roots.get(root);
  if (identity === void 0) {
    identity = {};
    roots.set(root, identity);
  }
  views.set(view, identity);
}
function fileSystemOrigin(view) {
  return views.get(view) ?? view;
}

// src/shell/errors.ts
var ShellNounsetError = class extends VfsError {
  constructor(name, message = `${name}: unbound variable`) {
    super("EINVAL", message);
    this.name = "ShellNounsetError";
  }
};
var ShellRefusalError = class extends VfsError {
  constructor(message, path) {
    super("EACCES", message, path);
    this.name = "ShellRefusalError";
  }
};

// src/shell/policy.ts
function allowed(path, roots2) {
  if (roots2 === void 0) return true;
  const normalized = normalizePath(path);
  return roots2.some((root) => {
    const normalizedRoot = normalizePath(root);
    return normalized === normalizedRoot || isDescendant(normalizedRoot, normalized);
  });
}
function countsMutations(fileSystem) {
  return typeof Reflect.get(fileSystem, "mutationSubtreeCount") === "function";
}
var ScopedFileSystem = class {
  #inner;
  #policy;
  #budget;
  constructor(inner, policy, budget) {
    this.#inner = inner;
    this.#policy = policy;
    this.#budget = budget;
  }
  /**
   * The path a root check has to be made against.
   *
   * A link inside an allowed root can name anything at all, so checking the
   * path as written would let `/allowed/escape -> /etc` hand out the whole
   * namespace. The check is made against what the path actually resolves to.
   * The written form is checked too, so a caller naming an out-of-bounds path
   * directly still gets the error that names what they asked for.
   */
  #resolved(path, follow = true) {
    try {
      return this.#inner.realpath(path, { follow });
    } catch {
      return normalizePath(path);
    }
  }
  /**
   * Checks the roots for an operation that acts on a link rather than through
   * it.
   *
   * `lstat` and `readlink` answer questions about the link itself, so the
   * check is about where the link lives, not where it points — refusing them
   * would be inconsistent with `ls -l`, which shows the same target text for
   * every entry in a readable directory. Everything on the way to the link is
   * still resolved, so an escaping directory link cannot be used to reach one.
   */
  /**
   * Checks one set of roots against both the written and the resolved path.
   *
   * Resolving costs a lookup, so it is skipped entirely when the session
   * declares no roots — there is nothing to be outside of, and that is the
   * common case. When roots do exist the resolved form is the one that
   * decides, because a link inside a root can name anything at all.
   */
  #check(path, roots2, detail, follow) {
    if (roots2 === void 0) return;
    if (!allowed(path, roots2) || !allowed(this.#resolved(path, follow), roots2)) {
      throw new ShellRefusalError(detail, normalizePath(path));
    }
  }
  /**
   * Checks an operation that acts on a link rather than through it.
   *
   * `lstat` and `readlink` answer questions about the link itself, so the
   * check is about where the link lives, not where it points — refusing them
   * would be inconsistent with `ls -l`, which shows the same target text for
   * every entry in a readable directory. Everything on the way to the link is
   * still resolved, so an escaping directory link cannot be used to reach one.
   */
  readLink(path) {
    this.#check(path, this.#policy.readRoots, "path is outside the readable roots", false);
  }
  read(path) {
    this.#check(path, this.#policy.readRoots, "path is outside the readable roots", true);
  }
  write(path) {
    this.#check(path, this.#policy.writeRoots, "path is outside the writable roots", true);
  }
  /** Checks an operation that names a link: `rm`, `mv`, and `cp -P`. */
  writeLink(path) {
    this.#check(path, this.#policy.writeRoots, "path is outside the writable roots", false);
  }
  missingDirectoryCount(path, recursive) {
    const normalized = normalizePath(path);
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const candidates = recursive ? segments.map((_segment, index) => `/${segments.slice(0, index + 1).join("/")}`) : [normalized];
    let missing = 0;
    for (const candidate of candidates) {
      this.write(candidate);
      try {
        this.#inner.stat(candidate);
      } catch (error) {
        if (error instanceof VfsError && error.code === "ENOENT") missing += 1;
        else throw error;
      }
    }
    return missing;
  }
  mutationSubtreeCount(path, operation) {
    return countsMutations(this.#inner) ? this.#inner.mutationSubtreeCount(path, operation) : this.#inner.subtreeSummary(path).entries;
  }
  getMutationToken(path, options) {
    const { readRoots, writeRoots } = this.#policy;
    if (readRoots !== void 0 || writeRoots !== void 0) {
      const scoped = (candidate) => allowed(candidate, readRoots) || allowed(candidate, writeRoots);
      if (!scoped(path) || !scoped(this.#resolved(path, options?.follow !== false))) {
        throw new ShellRefusalError("path is outside the scoped roots", normalizePath(path));
      }
    }
    return this.#inner.getMutationToken(path, options);
  }
  canUseBulkOperation(operation, path) {
    if (operation === "copy-source") this.read(path);
    else this.write(path);
    return this.#inner.canUseBulkOperation?.(operation, path) === true;
  }
  get availableWriteBufferBytes() {
    return this.#inner.availableWriteBufferBytes ?? 0;
  }
  writeFiles(entries) {
    for (const entry of entries) this.write(entry.path);
    this.#budget.mutation(entries.length);
    return this.#inner.writeFiles(entries);
  }
  lstat(path) {
    this.readLink(path);
    return this.#inner.lstat(path);
  }
  readlink(path) {
    this.readLink(path);
    return this.#inner.readlink(path);
  }
  realpath(path, options) {
    this.read(path);
    return this.#inner.realpath(path, options);
  }
  symlink(path, target, options) {
    this.writeLink(path);
    this.#budget.mutation();
    return this.#inner.symlink(path, target, options);
  }
  assertReadable(path) {
    this.read(path);
  }
  assertWritable(path) {
    this.write(path);
  }
  inspectWriteTarget(path, follow = true) {
    const normalized = normalizePath(path);
    this.#check(path, this.#policy.writeRoots, "path is outside the writable roots", follow);
    try {
      return follow ? this.#inner.stat(path) : this.#inner.lstat(path);
    } catch (error) {
      if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
    }
    const parent = this.#inner.stat(dirname(normalized));
    if (parent.kind !== "directory") throw new VfsError("ENOTDIR", "not a directory", parent.path);
    return null;
  }
  stat(path) {
    this.read(path);
    return this.#inner.stat(path);
  }
  statMany(paths, options = {}) {
    validateStatPaths(paths);
    for (const path of paths) {
      if (options.follow === false) this.readLink(path);
      else this.read(path);
    }
    return this.#inner.statMany?.(paths, options) ?? paths.map(
      (path) => statResult(
        () => options.follow === false ? this.#inner.lstat(path) : this.#inner.stat(path)
      )
    );
  }
  list(path) {
    this.read(path);
    return this.#inner.list(path);
  }
  listPage(path, options) {
    this.read(path);
    return this.#inner.listPage(path, options);
  }
  find(options) {
    this.read(options.path);
    return this.#inner.find(options);
  }
  findPage(options) {
    this.read(options.path);
    return this.#inner.findPage(options);
  }
  subtreeSummary(path) {
    this.read(path);
    return this.#inner.subtreeSummary(path);
  }
  digestFile(path) {
    this.read(path);
    return this.#inner.digestFile(path);
  }
  readFile(path, options) {
    this.read(path);
    return this.#inner.readFile(path, options);
  }
  writeFile(path, body, options) {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.writeFile(path, body, options);
  }
  appendFile(path, body, options) {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.appendFile(path, body, options);
  }
  touch(path, options) {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.touch(path, options);
  }
  setMetadata(path, options) {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.setMetadata(path, options);
  }
  setOwnership(path, options) {
    this.write(path);
    this.#budget.mutation();
    return this.#inner.setOwnership(path, options);
  }
  mkdir(path, recursive, mode) {
    this.write(path);
    const mutations = this.missingDirectoryCount(path, recursive === true);
    if (mutations > 0) this.#budget.mutation(mutations);
    return this.#inner.mkdir(path, recursive, mode);
  }
  remove(path, options) {
    this.writeLink(path);
    const count = options?.recursive === true ? this.mutationSubtreeCount(path, { kind: "remove-recursive" }) : 1;
    this.#budget.mutation(Math.max(1, count));
    return this.#inner.remove(path, options);
  }
  move(from, to, options) {
    this.writeLink(from);
    this.writeLink(to);
    this.#budget.mutation(Math.max(1, this.mutationSubtreeCount(from, { kind: "move" })));
    return this.#inner.move(from, to, options);
  }
  copy(from, to, options) {
    if (options?.dereference === true) this.read(from);
    else this.readLink(from);
    this.writeLink(to);
    this.#budget.mutation(
      Math.max(
        1,
        this.mutationSubtreeCount(from, {
          kind: "copy",
          dereference: options?.dereference === true
        })
      )
    );
    return this.#inner.copy(from, to, options);
  }
};

// src/shell/environment.ts
var ShellEnvironment = class _ShellEnvironment extends Map {
  optindGenerationValue;
  constructor(entries = [], optindGeneration2 = 0) {
    super();
    for (const [name, value] of entries) super.set(name, value);
    this.optindGenerationValue = optindGeneration2;
  }
  get optindGeneration() {
    return this.optindGenerationValue;
  }
  set(name, value) {
    if (name === "OPTIND") this.optindGenerationValue += 1;
    return super.set(name, value);
  }
  delete(name) {
    if (name === "OPTIND") this.optindGenerationValue += 1;
    return super.delete(name);
  }
  clear() {
    if (this.has("OPTIND")) this.optindGenerationValue += 1;
    super.clear();
  }
  clone() {
    return new _ShellEnvironment(this, this.optindGenerationValue);
  }
  setFromGetopts(value) {
    super.set("OPTIND", value);
  }
};
function optindGeneration(environment) {
  return environment instanceof ShellEnvironment ? environment.optindGeneration : 0;
}

// src/shell/session.ts
function createShellSession(options = {}) {
  const cwd = normalizePath(options.cwd ?? "/");
  const session = {
    cwd,
    env: new ShellEnvironment(Object.entries(options.env ?? {})),
    args: [...options.args ?? []],
    lastExitCode: 0,
    exitRequested: false,
    requestedExitCode: 0,
    pipefail: false,
    errexit: false,
    nounset: false,
    ...options.credentials === void 0 ? {} : {
      credentials: Object.freeze({
        uid: options.credentials.uid,
        gid: options.credentials.gid,
        supplementaryGids: Object.freeze([
          ...new Set(options.credentials.supplementaryGids ?? [])
        ])
      })
    },
    umask: options.umask ?? 18,
    functions: /* @__PURE__ */ new Map(),
    functionDepth: 0,
    sourceDepth: 0,
    scriptDepth: 0,
    loopDepth: 0,
    localFrames: [],
    localGetoptsFrames: [],
    getopts: void 0,
    flow: { type: "none" }
  };
  session.env.set("PWD", cwd);
  session.env.set("0", session.env.get("0") ?? "cf-vfs");
  session.env.set("IFS", " 	\n");
  if (!session.env.has("OPTIND")) session.env.set("OPTIND", "1");
  session.env.set("LC_ALL", "C");
  session.env.set("TZ", "UTC");
  return session;
}
function cloneShellSession(session) {
  return {
    cwd: session.cwd,
    env: session.env instanceof ShellEnvironment ? session.env.clone() : new ShellEnvironment(session.env),
    args: [...session.args],
    lastExitCode: session.lastExitCode,
    exitRequested: false,
    requestedExitCode: 0,
    pipefail: session.pipefail,
    errexit: session.errexit === true,
    nounset: session.nounset === true,
    ...session.credentials === void 0 ? {} : { credentials: session.credentials },
    umask: session.umask,
    functions: new Map(session.functions),
    functionDepth: session.functionDepth,
    sourceDepth: session.sourceDepth,
    scriptDepth: session.scriptDepth,
    loopDepth: session.loopDepth,
    localFrames: session.localFrames.map((frame) => new Map(frame)),
    localGetoptsFrames: session.localGetoptsFrames.map((frame) => ({
      captured: frame.captured,
      state: frame.state === void 0 ? void 0 : { ...frame.state }
    })),
    getopts: session.getopts === void 0 ? void 0 : { ...session.getopts },
    flow: { type: "none" }
  };
}
function prepareShellSessionUnit(session) {
  session.exitRequested = false;
  session.requestedExitCode = 0;
  session.functionDepth = 0;
  session.sourceDepth = 0;
  session.scriptDepth = 0;
  session.loopDepth = 0;
  session.localFrames.length = 0;
  session.localGetoptsFrames.length = 0;
  session.flow = { type: "none" };
}

// src/shell/access.ts
function shellModeAllows(stat, credentials, permission) {
  if (credentials === void 0) {
    return (stat.mode & permission * 73) !== 0;
  }
  if (credentials.uid === 0) {
    return permission !== 1 || stat.kind === "directory" || (stat.mode & 73) !== 0;
  }
  const bits = stat.uid === credentials.uid ? stat.mode >> 6 & 7 : stat.gid === credentials.gid || (credentials.supplementaryGids ?? []).includes(stat.gid) ? stat.mode >> 3 & 7 : stat.mode & 7;
  return (bits & permission) !== 0;
}

// src/shell/arithmetic-lexer.ts
var OPERATORS = [
  "<<=",
  ">>=",
  "++",
  "--",
  "**",
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "^=",
  "|=",
  "=",
  "?",
  ":",
  ",",
  "(",
  ")",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "~",
  "<",
  ">",
  "&",
  "^",
  "|"
];
var ArithmeticSyntaxError = class extends VfsError {
  detail;
  byteOffset;
  constructor(detail, source, offset) {
    const byteOffset = utf8ByteLength(source.slice(0, offset));
    super("EINVAL", `${detail} in arithmetic expression at byte ${byteOffset}`);
    this.detail = detail;
    this.byteOffset = byteOffset;
  }
};
function arithmeticSyntax(message, source, offset) {
  return new ArithmeticSyntaxError(message, source, offset);
}
function decimalOrOctalInteger(digits) {
  if (digits.length > 1 && digits.startsWith("0")) {
    if (!/^[0-7]+$/u.test(digits)) return void 0;
    return BigInt(`0o${digits}`);
  }
  return BigInt(digits);
}
function integerToken(source, start) {
  if (source.startsWith("0x", start) || source.startsWith("0X", start)) {
    const digits2 = /^[0-9a-f]+/iu.exec(source.slice(start + 2))?.[0] ?? "";
    if (digits2.length === 0) throw arithmeticSyntax("invalid hexadecimal literal", source, start);
    return {
      token: { type: "integer", value: BigInt(`0x${digits2}`), offset: start },
      next: start + digits2.length + 2
    };
  }
  const digits = /^[0-9]+/u.exec(source.slice(start))?.[0] ?? "";
  const value = decimalOrOctalInteger(digits);
  if (value === void 0) throw arithmeticSyntax("invalid octal literal", source, start);
  return { token: { type: "integer", value, offset: start }, next: start + digits.length };
}
function variableToken(source, start) {
  if (source[start] !== "$") {
    const value2 = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(start))?.[0] ?? "";
    return { token: { type: "identifier", value: value2, offset: start }, next: start + value2.length };
  }
  if (source[start + 1] !== "{") {
    const value2 = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(start + 1))?.[0];
    if (value2 === void 0) throw arithmeticSyntax("invalid arithmetic variable", source, start);
    return { token: { type: "identifier", value: value2, offset: start }, next: start + value2.length + 1 };
  }
  const close = source.indexOf("}", start + 2);
  if (close < 0) throw arithmeticSyntax("unterminated variable reference", source, start);
  const value = source.slice(start + 2, close);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw arithmeticSyntax("invalid arithmetic variable", source, start);
  }
  return { token: { type: "identifier", value, offset: start }, next: close + 1 };
}
function tokenizeArithmetic(source) {
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset];
    if (character === void 0) break;
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }
    if (/[0-9]/u.test(character)) {
      const parsed = integerToken(source, offset);
      tokens.push(parsed.token);
      offset = parsed.next;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      const parsed = variableToken(source, offset);
      tokens.push(parsed.token);
      offset = parsed.next;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, offset));
    if (operator === void 0) {
      throw arithmeticSyntax(`unexpected character ${JSON.stringify(character)}`, source, offset);
    }
    tokens.push({ type: "operator", value: operator, offset });
    offset += operator.length;
  }
  tokens.push({ type: "end", offset: source.length });
  return tokens;
}

// src/shell/arithmetic.ts
var BINARY_PRECEDENCE = {
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "<": 7,
  "<=": 7,
  ">": 7,
  ">=": 7,
  "<<": 8,
  ">>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 11
};
var ASSIGNMENT_BINARY = {
  "=": void 0,
  "+=": "+",
  "-=": "-",
  "*=": "*",
  "/=": "/",
  "%=": "%",
  "<<=": "<<",
  ">>=": ">>",
  "&=": "&",
  "^=": "^",
  "|=": "|"
};
function isAssignmentOperator(value) {
  return Object.hasOwn(ASSIGNMENT_BINARY, value);
}
function isBinaryOperator(value) {
  return Object.hasOwn(BINARY_PRECEDENCE, value);
}
var ArithmeticParser = class {
  source;
  tokens;
  maximumNodes;
  maximumDepth;
  index = 0;
  nodes = 0;
  syntaxDepth = 1;
  constructor(source, maximumNodes, maximumDepth) {
    this.source = source;
    this.tokens = tokenizeArithmetic(source);
    this.maximumNodes = maximumNodes;
    this.maximumDepth = maximumDepth;
  }
  parse() {
    if (this.maximumDepth < 1)
      throw new VfsError("E2BIG", "arithmetic nesting depth limit exceeded");
    const node = this.comma();
    const token = this.peek();
    if (token.type !== "end") throw this.syntax("unexpected token", token.offset);
    validateArithmeticDepth(node, this.maximumDepth);
    return { node, nodeCount: this.nodes };
  }
  add(node) {
    this.nodes += 1;
    if (this.nodes > this.maximumNodes) {
      throw new VfsError("E2BIG", "shell AST node limit exceeded");
    }
    return node;
  }
  syntax(message, offset) {
    return arithmeticSyntax(message, this.source, offset);
  }
  nested(parse) {
    this.syntaxDepth += 1;
    if (this.syntaxDepth > this.maximumDepth) {
      this.syntaxDepth -= 1;
      throw new VfsError("E2BIG", "arithmetic nesting depth limit exceeded");
    }
    try {
      return parse();
    } finally {
      this.syntaxDepth -= 1;
    }
  }
  peek() {
    return this.tokens[this.index] ?? { type: "end", offset: 0 };
  }
  take() {
    const token = this.peek();
    this.index += 1;
    return token;
  }
  takeOperator(value) {
    const token = this.peek();
    if (token.type !== "operator" || token.value !== value) return false;
    this.index += 1;
    return true;
  }
  comma() {
    const expressions = [this.assignment()];
    while (this.takeOperator(",")) expressions.push(this.assignment());
    return expressions.length === 1 ? expressions[0] ?? this.add({ type: "integer", value: 0n }) : this.add({ type: "comma", expressions });
  }
  assignment() {
    const left = this.conditional();
    const token = this.peek();
    if (token.type !== "operator" || !isAssignmentOperator(token.value)) return left;
    if (left.type !== "variable")
      throw this.syntax("assignment target must be a variable", token.offset);
    this.take();
    return this.add({
      type: "assignment",
      operator: token.value,
      name: left.name,
      value: this.nested(() => this.assignment())
    });
  }
  conditional() {
    const condition = this.binary(1);
    if (!this.takeOperator("?")) return condition;
    const consequent = this.nested(() => this.comma());
    const token = this.peek();
    if (!this.takeOperator(":"))
      throw this.syntax("conditional expression requires :", token.offset);
    return this.add({
      type: "conditional",
      condition,
      consequent,
      alternate: this.nested(() => this.assignment())
    });
  }
  binary(minimum) {
    let left = this.unary();
    while (true) {
      const token = this.peek();
      if (token.type !== "operator" || !isBinaryOperator(token.value)) break;
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence < minimum) break;
      this.take();
      const right = this.nested(
        () => this.binary(token.value === "**" ? precedence : precedence + 1)
      );
      left = this.add({ type: "binary", operator: token.value, left, right });
    }
    return left;
  }
  unary() {
    const token = this.peek();
    if (token.type === "operator" && (token.value === "++" || token.value === "--")) {
      this.take();
      const operand = this.peek();
      if (operand.type !== "identifier")
        throw this.syntax("update target must be a variable", operand.offset);
      this.take();
      return this.add({ type: "update", operator: token.value, name: operand.value, prefix: true });
    }
    if (token.type === "operator" && (token.value === "+" || token.value === "-" || token.value === "!" || token.value === "~")) {
      this.take();
      return this.add({
        type: "unary",
        operator: token.value,
        operand: this.nested(() => this.unary())
      });
    }
    return this.postfix();
  }
  postfix() {
    const primary = this.primary();
    const token = this.peek();
    if (token.type !== "operator" || token.value !== "++" && token.value !== "--") return primary;
    if (primary.type !== "variable")
      throw this.syntax("update target must be a variable", token.offset);
    this.take();
    return this.add({ type: "update", operator: token.value, name: primary.name, prefix: false });
  }
  primary() {
    const token = this.take();
    if (token.type === "integer") return this.add({ type: "integer", value: token.value });
    if (token.type === "identifier") return this.add({ type: "variable", name: token.value });
    if (token.type === "operator" && token.value === "(") {
      const expression = this.nested(() => this.comma());
      const close = this.peek();
      if (!this.takeOperator(")")) throw this.syntax("missing closing parenthesis", close.offset);
      return expression;
    }
    throw this.syntax("expected integer, variable, or parenthesized expression", token.offset);
  }
};
function validateArithmeticDepth(root, maximumDepth) {
  const pending = [{ node: root, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === void 0) break;
    if (current.depth > maximumDepth) {
      throw new VfsError("E2BIG", "arithmetic nesting depth limit exceeded");
    }
    const nextDepth = current.depth + 1;
    switch (current.node.type) {
      case "unary":
        pending.push({ node: current.node.operand, depth: nextDepth });
        break;
      case "binary":
        pending.push(
          { node: current.node.left, depth: nextDepth },
          { node: current.node.right, depth: nextDepth }
        );
        break;
      case "conditional":
        pending.push(
          { node: current.node.condition, depth: nextDepth },
          { node: current.node.consequent, depth: nextDepth },
          { node: current.node.alternate, depth: nextDepth }
        );
        break;
      case "assignment":
        pending.push({ node: current.node.value, depth: nextDepth });
        break;
      case "comma": {
        for (const expression of current.node.expressions) {
          pending.push({ node: expression, depth: nextDepth });
        }
        break;
      }
      case "integer":
      case "variable":
      case "update":
        break;
    }
  }
}
function int64(value) {
  return BigInt.asIntN(64, value);
}
function truth(value) {
  return value === 0n ? 0n : 1n;
}
function readVariable(name, env, nounset) {
  const value = env.get(name);
  if (value === void 0 && nounset) throw new ShellNounsetError(name);
  const normalized = value ?? "";
  if (!/^[+-]?(?:[0-9]+|0[xX][0-9a-f]+)$/iu.test(normalized)) return 0n;
  try {
    const negative = normalized.startsWith("-");
    const unsigned = normalized.startsWith("-") || normalized.startsWith("+") ? normalized.slice(1) : normalized;
    const parsed = /^0[xX]/u.test(unsigned) ? BigInt(unsigned) : decimalOrOctalInteger(unsigned);
    if (parsed === void 0) return 0n;
    return int64(negative ? -parsed : parsed);
  } catch {
    return 0n;
  }
}
function divide(left, right, remainder) {
  if (right === 0n) throw new VfsError("EINVAL", "division by zero in arithmetic expression");
  return remainder ? left % right : left / right;
}
function power(left, right) {
  if (right < 0n) throw new VfsError("EINVAL", "negative arithmetic exponent");
  if (right > 63n) throw new VfsError("E2BIG", "arithmetic exponent is too large");
  return int64(left ** right);
}
var BINARY_OPERATIONS = {
  "+": (left, right) => int64(left + right),
  "-": (left, right) => int64(left - right),
  "*": (left, right) => int64(left * right),
  "/": (left, right) => int64(divide(left, right, false)),
  "%": (left, right) => int64(divide(left, right, true)),
  "<<": (left, right) => int64(left << BigInt.asUintN(6, right)),
  ">>": (left, right) => int64(left >> BigInt.asUintN(6, right)),
  "<": (left, right) => left < right ? 1n : 0n,
  "<=": (left, right) => left <= right ? 1n : 0n,
  ">": (left, right) => left > right ? 1n : 0n,
  ">=": (left, right) => left >= right ? 1n : 0n,
  "==": (left, right) => left === right ? 1n : 0n,
  "!=": (left, right) => left !== right ? 1n : 0n,
  "&": (left, right) => int64(left & right),
  "^": (left, right) => int64(left ^ right),
  "|": (left, right) => int64(left | right),
  "&&": (left, right) => truth(left) & truth(right),
  "||": (left, right) => truth(left) | truth(right)
};
function binary(operator, left, right) {
  return operator === "**" ? power(left, right) : BINARY_OPERATIONS[operator](left, right);
}
function assignmentBinary(operator) {
  return ASSIGNMENT_BINARY[operator];
}
function unaryValue(node, value) {
  if (node.operator === "+") return value;
  if (node.operator === "-") return int64(-value);
  if (node.operator === "!") return value === 0n ? 1n : 0n;
  return int64(~value);
}
function updateValue(node, env, nounset) {
  const previous = readVariable(node.name, env, nounset);
  const value = int64(previous + (node.operator === "++" ? 1n : -1n));
  env.set(node.name, String(value));
  return node.prefix ? value : previous;
}
function binaryValue(node, env, nounset) {
  const left = evaluateArithmetic(node.left, env, nounset);
  if (node.operator === "&&" && left === 0n) return 0n;
  if (node.operator === "||" && left !== 0n) return 1n;
  return binary(node.operator, left, evaluateArithmetic(node.right, env, nounset));
}
function assignmentValue(node, env, nounset) {
  const operation = assignmentBinary(node.operator);
  const left = operation === void 0 ? void 0 : readVariable(node.name, env, nounset);
  const right = evaluateArithmetic(node.value, env, nounset);
  const value = operation === void 0 ? right : binary(operation, left ?? 0n, right);
  env.set(node.name, String(value));
  return value;
}
function commaValue(expressions, env, nounset) {
  let value = 0n;
  for (const expression of expressions) value = evaluateArithmetic(expression, env, nounset);
  return value;
}
function evaluateArithmetic(node, env, nounset = false) {
  switch (node.type) {
    case "integer":
      return int64(node.value);
    case "variable":
      return readVariable(node.name, env, nounset);
    case "unary":
      return unaryValue(node, evaluateArithmetic(node.operand, env, nounset));
    case "update":
      return updateValue(node, env, nounset);
    case "binary":
      return binaryValue(node, env, nounset);
    case "conditional":
      return evaluateArithmetic(
        evaluateArithmetic(node.condition, env, nounset) === 0n ? node.alternate : node.consequent,
        env,
        nounset
      );
    case "assignment":
      return assignmentValue(node, env, nounset);
    case "comma":
      return commaValue(node.expressions, env, nounset);
  }
}
function parseArithmetic(source, maximumNodes = 1e4, maximumDepth = 64) {
  if (source.trim().length === 0) throw arithmeticSyntax("empty expression", source, 0);
  return new ArithmeticParser(source, maximumNodes, maximumDepth).parse();
}

// src/shell/brace.ts
var INTEGER_RANGE = /^(-?[0-9]+)\.\.(-?[0-9]+)(?:\.\.(-?[0-9]+))?$/u;
var CHARACTER_RANGE = /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?[0-9]+))?$/u;
var ZERO_PADDED = /^-?0[0-9]/u;
function flatten(word) {
  const atoms = [];
  for (const part of word.parts) {
    if (part.kind !== "literal" || part.quoted) {
      atoms.push({ kind: "opaque", part });
      continue;
    }
    for (const value of part.value) atoms.push({ kind: "char", value });
  }
  return atoms;
}
function rebuild(atoms, word) {
  const parts = [];
  let literal = "";
  const flush = () => {
    if (literal === "") return;
    parts.push({ kind: "literal", value: literal, quoted: false });
    literal = "";
  };
  for (const atom of atoms) {
    if (atom.kind === "char") {
      literal += atom.value;
      continue;
    }
    flush();
    parts.push(atom.part);
  }
  flush();
  const rebuilt = { parts, sourceOffset: word.sourceOffset };
  return word.assignmentName === void 0 ? rebuilt : { ...rebuilt, assignmentName: word.assignmentName };
}
function chargeRange(start, end, stride, budget) {
  const count = Math.floor(Math.abs(end - start) / stride) + 1;
  budget.expansionWork(count);
  return count;
}
function characterRange(startText, endText, step, budget) {
  const start = startText.codePointAt(0);
  const end = endText.codePointAt(0);
  if (start === void 0 || end === void 0) return void 0;
  const stride = step === 0 ? 1 : Math.abs(step);
  const direction = start <= end ? 1 : -1;
  const count = chargeRange(start, end, stride, budget);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const code = start + direction * stride * index;
    values.push([
      code === 92 ? { kind: "opaque", part: { kind: "literal", value: "", quoted: true } } : { kind: "char", value: String.fromCodePoint(code) }
    ]);
  }
  return values;
}
function integerRange(startText, endText, step, budget) {
  const start = Number(startText);
  const end = Number(endText);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return void 0;
  const width = ZERO_PADDED.test(startText) || ZERO_PADDED.test(endText) ? Math.max(startText.length, endText.length) : 0;
  const stride = step === 0 ? 1 : Math.abs(step);
  const direction = start <= end ? 1 : -1;
  const count = chargeRange(start, end, stride, budget);
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const value = start + direction * stride * index;
    const digits = Math.abs(value).toString();
    const sign = value < 0 ? "-" : "";
    const padded = width === 0 ? `${sign}${digits}` : `${sign}${digits.padStart(width - sign.length, "0")}`;
    values.push([...padded].map((character) => ({ kind: "char", value: character })));
  }
  return values;
}
function rangeStep(text) {
  if (text === void 0) return 1;
  const value = BigInt(text);
  return BigInt.asIntN(64, value) === value ? Number(value) : void 0;
}
function rangeAlternatives(content, budget) {
  if (content.some((atom) => atom.kind !== "char")) return void 0;
  const text = content.map((atom) => atom.kind === "char" ? atom.value : "").join("");
  const integers = INTEGER_RANGE.exec(text);
  if (integers?.[1] !== void 0 && integers[2] !== void 0) {
    const step = rangeStep(integers[3]);
    return step === void 0 ? void 0 : integerRange(integers[1], integers[2], step, budget);
  }
  const characters = CHARACTER_RANGE.exec(text);
  if (characters?.[1] !== void 0 && characters[2] !== void 0) {
    const step = rangeStep(characters[3]);
    return step === void 0 ? void 0 : characterRange(characters[1], characters[2], step, budget);
  }
  return void 0;
}
function groupBounds(atoms, start, budget) {
  const separators = [];
  let depth = 0;
  for (let index = start; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (atom?.kind !== "char") continue;
    budget.expansionWork();
    if (atom.value === "{") depth += 1;
    else if (atom.value === "," && depth === 1) separators.push(index);
    else if (atom.value === "}") {
      depth -= 1;
      if (depth === 0) return { end: index, separators };
    }
  }
  return void 0;
}
function readGroup(atoms, start, budget) {
  const bounds = groupBounds(atoms, start, budget);
  if (bounds === void 0) return void 0;
  const { end, separators } = bounds;
  const content = atoms.slice(start + 1, end);
  if (separators.length === 0) {
    const alternatives3 = rangeAlternatives(content, budget);
    return alternatives3 === void 0 ? void 0 : { alternatives: alternatives3, end };
  }
  const alternatives2 = [];
  let from = start + 1;
  for (const separator of [...separators, end]) {
    alternatives2.push(atoms.slice(from, separator));
    from = separator + 1;
  }
  return { alternatives: alternatives2, end };
}
function expandAtoms(atoms, budget) {
  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (atom?.kind !== "char" || atom.value !== "{") continue;
    const group = readGroup(atoms, index, budget);
    if (group === void 0) continue;
    const output = [];
    const prefix = atoms.slice(0, index);
    const suffix = atoms.slice(group.end + 1);
    for (const alternative of group.alternatives) {
      output.push(...expandAtoms([...prefix, ...alternative, ...suffix], budget));
    }
    return output;
  }
  return [[...atoms]];
}
function expandBraces(word, budget) {
  if (!word.parts.some((part) => part.kind === "literal" && !part.quoted && part.value.includes("{")))
    return [word];
  const atoms = flatten(word);
  const expanded = expandAtoms(atoms, budget).filter((candidate) => candidate.length > 0);
  if (expanded.length > 1) budget.expansionWork(expanded.length);
  return expanded.map((candidate) => rebuild(candidate, word));
}

// src/shell/expand-glob.ts
function escapeGlob(value) {
  return value.replace(/[\\*?[\]]/gu, (character) => `\\${character}`);
}
function unescapeGlob(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && value[index + 1] !== void 0) index += 1;
    output += value[index] ?? "";
  }
  return output;
}
function hasClosingClassBracket(pattern, open) {
  let escaped = false;
  for (let index = open + 1; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "]") return true;
  }
  return false;
}
function firstGlobMeta(pattern) {
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") escaped = true;
    else if (character === "*" || character === "?") return index;
    else if (character === "[" && hasClosingClassBracket(pattern, index)) return index;
  }
  return -1;
}
function hasGlob(pattern) {
  return firstGlobMeta(pattern) >= 0;
}
function containsDotSegment(pattern, path) {
  const patternSegments = pattern.split("/").map(unescapeGlob);
  const pathSegments = path.split("/");
  return pathSegments.some(
    (segment, index) => segment.startsWith(".") && !(patternSegments[index]?.startsWith(".") ?? false)
  );
}
function relativePath(from, to) {
  const fromSegments = from.split("/").filter(Boolean);
  const toSegments = to.split("/").filter(Boolean);
  let common = 0;
  while (fromSegments[common] === toSegments[common] && common < fromSegments.length) common += 1;
  return [
    ...Array.from({ length: fromSegments.length - common }, () => ".."),
    ...toSegments.slice(common)
  ].join("/") || ".";
}
function globSearch(pattern, cwd, fileSystem) {
  const absolutePattern = normalizeFileSystemPath(pattern, cwd);
  const firstMeta = firstGlobMeta(absolutePattern);
  const escapedPrefix = firstMeta < 0 ? absolutePattern : absolutePattern.slice(0, firstMeta);
  const rootEnd = Math.max(escapedPrefix.lastIndexOf("/"), 0);
  const writtenRoot = rootEnd === 0 ? "/" : unescapeGlob(absolutePattern.slice(0, rootEnd));
  const root = fileSystem.realpath(writtenRoot);
  const suffix = absolutePattern.slice(rootEnd);
  return { root, writtenRoot, pattern: root === "/" ? suffix || "/" : `${root}${suffix}` };
}
function writtenGlobPath(search, path) {
  if (search.root === search.writtenRoot) return path;
  const tail = search.root === "/" ? path : path.slice(search.root.length);
  return search.writtenRoot === "/" ? tail : `${search.writtenRoot}${tail}`;
}
function scanGlob(search, fileSystem, budget) {
  const matches = [];
  let cursor;
  do {
    const remaining = budget.limits.maxGlobMatches - matches.length;
    const page = fileSystem.findPage({
      path: search.root,
      includeRoot: false,
      pathGlob: search.pattern,
      ...cursor === void 0 ? {} : { cursor },
      limit: Math.min(1e3, remaining + 1)
    });
    budget.step(page.scanned);
    for (const entry of page.entries) {
      if (!containsDotSegment(search.pattern, entry.path)) {
        matches.push(writtenGlobPath(search, entry.path));
      }
    }
    if (matches.length > budget.limits.maxGlobMatches) return matches;
    cursor = page.nextCursor ?? void 0;
  } while (cursor !== void 0);
  return matches;
}
function displayedGlobPath(value, pattern, cwd, path) {
  if (value.startsWith("/")) return path;
  const relativeMeta = firstGlobMeta(pattern);
  const directoryEnd = pattern.lastIndexOf("/", relativeMeta);
  if (directoryEnd < 0) return relativePath(cwd, path);
  const lexicalDirectory = unescapeGlob(pattern.slice(0, directoryEnd + 1));
  const base = normalizeFileSystemPath(lexicalDirectory, cwd);
  return `${lexicalDirectory}${relativePath(base, path)}`;
}
async function expandGlob(value, pattern, session, fileSystem, budget) {
  const search = globSearch(pattern, session.cwd, fileSystem);
  let matches;
  try {
    matches = scanGlob(search, fileSystem, budget);
  } catch (error) {
    if (error instanceof VfsError && error.code === "ENOENT") return [];
    throw error;
  }
  matches.sort(compareUtf8);
  budget.glob(matches.length);
  return matches.map((path) => displayedGlobPath(value, pattern, session.cwd, path));
}

// src/shell/expand-parameter.ts
function shellOptionFlags(session) {
  return `${session.errexit === true ? "e" : ""}${session.nounset === true ? "u" : ""}`;
}
function variableState(name, session) {
  if (name === "?") return { set: true, value: String(session.lastExitCode) };
  if (name === "-") return { set: true, value: shellOptionFlags(session) };
  if (name === "#") return { set: true, value: String(session.args.length) };
  if (name === "@") return { set: session.args.length > 0, value: session.args.join(" ") };
  if (name === "*") return { set: session.args.length > 0, value: session.args.join(" ") };
  if (name === "0") return { set: true, value: session.env.get("0") ?? "cf-vfs" };
  if (/^[1-9][0-9]*$/u.test(name)) {
    const value2 = session.args[Number(name) - 1];
    return value2 === void 0 ? { set: false, value: "" } : { set: true, value: value2 };
  }
  const value = session.env.get(name);
  return value === void 0 ? { set: false, value: "" } : { set: true, value };
}
function isShellParameterSet(name, session) {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#@*-])$/u.test(name)) {
    throw new VfsError("EINVAL", `${name}: invalid variable name`);
  }
  return variableState(name, session).set;
}
function assignParameter(name, value, session) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new VfsError("EINVAL", `cannot assign to special parameter ${name}`);
  }
  session.env.set(name, value);
}
function substringByCodePoint(value, offset, length, budget) {
  let start = offset;
  if (start < 0) {
    budget.expansionWork(value.length);
    start = Math.max(codePointLength(value) + start, 0);
  }
  budget.expansionWork(value.length);
  const end = length === void 0 ? Number.POSITIVE_INFINITY : start + length;
  let codePoints = 0;
  let codeUnits = 0;
  let startCodeUnit = value.length;
  let endCodeUnit = value.length;
  for (const character of value) {
    if (codePoints === start) startCodeUnit = codeUnits;
    if (codePoints === end) {
      endCodeUnit = codeUnits;
      break;
    }
    codePoints += 1;
    codeUnits += character.length;
  }
  if (codePoints === start) startCodeUnit = codeUnits;
  if (codePoints === end) endCodeUnit = codeUnits;
  return value.slice(startCodeUnit, endCodeUnit);
}
function expansionInteger(value, label) {
  const normalized = value.trim();
  if (!/^-?[0-9]+$/u.test(normalized)) {
    throw new VfsError("EINVAL", `${label} must expand to an integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new VfsError("EINVAL", `${label} must expand to a safe integer`);
  }
  return parsed;
}
function missingParameter(name, session, message) {
  const rendered = message || `${name}: parameter is unset or empty`;
  if (session.nounset) throw new ShellNounsetError(name, rendered);
  throw new VfsError("EINVAL", rendered);
}
function indirectParameterValue(session, value) {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#-])$/u.test(value)) {
    throw new VfsError("EINVAL", `${value}: invalid variable name for indirect expansion`);
  }
  const referenced = variableState(value, session);
  if (!referenced.set && session.nounset) throw new ShellNounsetError(value);
  return referenced.value;
}

// src/shell/expand-tilde.ts
var ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/u;
function tildeHome(session) {
  const home = session.env.get("HOME");
  return home === void 0 || home === "" ? void 0 : home;
}
function tildeSuffix(segment) {
  if (!segment.startsWith("~")) return void 0;
  const rest = segment.slice(1);
  return rest === "" || rest.startsWith("/") ? rest : void 0;
}
function tildeParts(template, home, suffix) {
  const parts = [{ ...template, value: home, quoted: true }];
  if (suffix !== "") parts.push({ ...template, value: suffix, quoted: false });
  return parts;
}
function chargeTilde(home, budget) {
  budget.expansionWork(home.length);
  budget.checkExpansionOutput(codePointLength(home));
}
function leadingTildePrefix(parts, first, home, budget) {
  const suffix = tildeSuffix(first.value);
  if (suffix === void 0 || suffix === "" && parts.length > 1) return parts;
  chargeTilde(home, budget);
  return [...tildeParts(first, home, suffix), ...parts.slice(1)];
}
function appendAssignmentTildeSegment(state, part, segment, continues, home, budget) {
  const suffix = state.atBoundary ? tildeSuffix(segment) : void 0;
  if (suffix === void 0 || suffix === "" && continues) {
    if (segment !== "") state.output.push({ ...part, value: segment });
  } else {
    chargeTilde(home, budget);
    state.output.push(...tildeParts(part, home, suffix));
    state.expanded = true;
  }
  state.atBoundary = false;
}
function appendAssignmentTildePart(state, part, index, partCount, home, budget) {
  if (part.kind !== "literal" || part.quoted) {
    state.output.push(part);
    state.atBoundary = false;
    return;
  }
  let value = part.value;
  if (!state.seenName) {
    const separator = value.indexOf("=");
    state.output.push({ ...part, value: value.slice(0, separator + 1) });
    value = value.slice(separator + 1);
    state.seenName = true;
    state.atBoundary = true;
  }
  const segments = value.split(":");
  for (const [segmentIndex, segment] of segments.entries()) {
    if (segmentIndex > 0) {
      state.output.push({ ...part, value: ":" });
      state.atBoundary = true;
    }
    const continues = segmentIndex === segments.length - 1 && index < partCount - 1;
    appendAssignmentTildeSegment(state, part, segment, continues, home, budget);
  }
}
function assignmentTildePrefix(parts, home, budget) {
  const state = {
    output: [],
    atBoundary: false,
    seenName: false,
    expanded: false
  };
  for (const [index, part] of parts.entries()) {
    appendAssignmentTildePart(state, part, index, parts.length, home, budget);
  }
  return state.expanded ? state.output : parts;
}
function withTildePrefix(parts, session, budget) {
  const first = parts[0];
  if (first?.kind !== "literal" || first.quoted) return parts;
  const home = tildeHome(session);
  if (home === void 0) return parts;
  return ASSIGNMENT_WORD.test(first.value) ? assignmentTildePrefix(parts, home, budget) : leadingTildePrefix(parts, first, home, budget);
}

// src/shell/pattern.ts
var unboundedBudget = { expansionWork() {
} };
function boundedCharacters(value, budget) {
  budget.expansionWork(value.length);
  const characters = codePointLength(value);
  if (characters > (budget.limits?.maxExpansionChars ?? Number.POSITIVE_INFINITY)) {
    throw new VfsError("E2BIG", "shell expansion character limit exceeded");
  }
  return [...value];
}
function patternToken(characters, index) {
  const character = characters[index] ?? "";
  if (character === "\\" && characters[index + 1] !== void 0) {
    return { token: { kind: "literal", value: characters[index + 1] ?? "" }, consumed: 2 };
  }
  if (character === "*") return { token: { kind: "star" }, consumed: 1 };
  if (character === "?") return { token: { kind: "any" }, consumed: 1 };
  if (character !== "[") return { token: { kind: "literal", value: character }, consumed: 1 };
  const expression = parseBracketExpression(characters, index);
  return expression === void 0 ? { token: { kind: "literal", value: character }, consumed: 1 } : {
    token: { kind: "class", negated: expression.negated, ranges: expression.ranges },
    consumed: expression.close - index + 1
  };
}
function compilePattern(pattern, budget) {
  const characters = [...pattern];
  budget.expansionWork(characters.length);
  const tokens = [];
  for (let index = 0; index < characters.length; ) {
    const parsed = patternToken(characters, index);
    if (parsed.token.kind !== "star" || tokens.at(-1)?.kind !== "star") tokens.push(parsed.token);
    index += parsed.consumed;
  }
  return {
    tokens,
    hasStar: tokens.some((token) => token.kind === "star"),
    minimumCharacters: tokens.filter((token) => token.kind !== "star").length
  };
}
function tokenMatches(token, value, budget) {
  if (token.kind === "literal") return token.value === value;
  if (token.kind === "any") return true;
  const point = firstCodePoint(value);
  let included = false;
  for (const [start, end] of token.ranges) {
    budget.expansionWork();
    if (point >= start && point <= end) {
      included = true;
      break;
    }
  }
  return token.negated ? !included : included;
}
function matchesWithoutStar(characters, start, pattern, budget) {
  budget.expansionWork(pattern.tokens.length);
  for (const [offset, token] of pattern.tokens.entries()) {
    if (token.kind === "star" || !tokenMatches(token, characters[start + offset] ?? "", budget))
      return false;
  }
  return true;
}
function advanceMatches(previous, token, characters, start, budget) {
  const remaining = previous.length - 1;
  const current = new Uint8Array(previous.length);
  if (token.kind === "star") {
    return advanceStar(previous, current);
  }
  for (let offset = 1; offset <= remaining; offset += 1) {
    if ((previous[offset - 1] ?? 0) !== 0 && tokenMatches(token, characters[start + offset - 1] ?? "", budget)) {
      current[offset] = 1;
    }
  }
  return current;
}
function advanceStar(previous, current) {
  current[0] = previous[0] ?? 0;
  for (let offset = 1; offset < previous.length; offset += 1) {
    current[offset] = (previous[offset] ?? 0) || (current[offset - 1] ?? 0) ? 1 : 0;
  }
  return current;
}
function selectedMatchEnd(matches, start, selection) {
  const remaining = matches.length - 1;
  if (selection === "exact") return matches[remaining] === 0 ? void 0 : start + remaining;
  const minimum = selection === "longest-nonempty" ? 1 : 0;
  if (selection === "shortest") {
    for (let offset = minimum; offset <= remaining; offset += 1) {
      if ((matches[offset] ?? 0) !== 0) return start + offset;
    }
    return void 0;
  }
  for (let offset = remaining; offset >= minimum; offset -= 1) {
    if ((matches[offset] ?? 0) !== 0) return start + offset;
  }
  return void 0;
}
function matchingEnd(characters, start, pattern, budget, selection) {
  const remaining = characters.length - start;
  if (!pattern.hasStar) {
    const end = start + pattern.minimumCharacters;
    if (end > characters.length || !matchesWithoutStar(characters, start, pattern, budget)) {
      return void 0;
    }
    if (selection === "exact" && end !== characters.length) return void 0;
    return selection === "longest-nonempty" && end === start ? void 0 : end;
  }
  budget.expansionWork(remaining + 1);
  let previous = new Uint8Array(remaining + 1);
  previous[0] = 1;
  for (const token of pattern.tokens) {
    budget.expansionWork(remaining + 1);
    previous = advanceMatches(previous, token, characters, start, budget);
  }
  return selectedMatchEnd(previous, start, selection);
}
function matchesShellPattern(value, pattern, budget = unboundedBudget) {
  const characters = boundedCharacters(value, budget);
  const compiled = compilePattern(pattern, budget);
  return matchingEnd(characters, 0, compiled, budget, "exact") !== void 0;
}
function removeShellPattern(value, pattern, side, longest, budget) {
  const characters = boundedCharacters(value, budget);
  const compiled = compilePattern(pattern, budget);
  const input = side === "prefix" ? characters : characters.reverse();
  const effective = side === "prefix" ? compiled : { ...compiled, tokens: [...compiled.tokens].reverse() };
  const length = matchingEnd(input, 0, effective, budget, longest ? "longest" : "shortest");
  if (side === "suffix") characters.reverse();
  if (length === void 0) return value;
  return side === "prefix" ? characters.slice(length).join("") : characters.slice(0, characters.length - length).join("");
}
function findReplacementMatch(characters, pattern, startAt, budget) {
  if (pattern.tokens.length === 0) return void 0;
  for (let start = startAt; start < characters.length; start += 1) {
    if (!pattern.hasStar) {
      const end2 = start + pattern.minimumCharacters;
      if (end2 <= characters.length && matchesWithoutStar(characters, start, pattern, budget)) {
        return { start, end: end2 };
      }
      continue;
    }
    const end = matchingEnd(characters, start, pattern, budget, "longest-nonempty");
    if (end !== void 0) return { start, end };
  }
  return void 0;
}
function replaceShellPattern(value, pattern, replacement, all, budget) {
  const characters = boundedCharacters(value, budget);
  const compiled = compilePattern(pattern, budget);
  const replacementCharacters = codePointLength(replacement);
  let cursor = 0;
  let outputCharacters = 0;
  let output = "";
  while (cursor < characters.length) {
    const match = findReplacementMatch(characters, compiled, cursor, budget);
    if (match === void 0) break;
    outputCharacters += match.start - cursor + replacementCharacters;
    if (outputCharacters > (budget.limits?.maxExpansionChars ?? Number.POSITIVE_INFINITY)) {
      throw new VfsError("E2BIG", "shell expansion character limit exceeded");
    }
    output += characters.slice(cursor, match.start).join("");
    output += replacement;
    cursor = match.end;
    if (!all) break;
  }
  outputCharacters += characters.length - cursor;
  if (outputCharacters > (budget.limits?.maxExpansionChars ?? Number.POSITIVE_INFINITY)) {
    throw new VfsError("E2BIG", "shell expansion character limit exceeded");
  }
  return `${output}${characters.slice(cursor).join("")}`;
}

// src/shell/expand.ts
function append(fields2, value, activeGlob) {
  const field = fields2.at(-1);
  if (field === void 0) return;
  field.value += value;
  field.pattern += activeGlob ? value : escapeGlob(value);
  field.characters += codePointLength(value);
}
function alternatives(fields2, expanded, activeGlob) {
  const { values } = expanded;
  if (values.length === 0) return;
  append(fields2, values[0] ?? "", activeGlob);
  for (const value of values.slice(1)) {
    fields2.push({
      value,
      pattern: activeGlob ? value : escapeGlob(value),
      characters: codePointLength(value)
    });
  }
}
function splitValues(inputs, quoted, budget, existingCharacters, existingFields) {
  const values = [];
  let characters = 0;
  const add2 = (value) => {
    const added = codePointLength(value);
    const nextCount = values.length + 1;
    budget.checkExpansionOutput(
      existingCharacters + characters + added,
      existingFields + Math.max(0, nextCount - 1)
    );
    values.push(value);
    characters += added;
  };
  for (const input of inputs) {
    budget.expansionWork(input.length);
    if (quoted) {
      add2(input);
      continue;
    }
    for (const match of input.matchAll(/[^ \t\n]+/gu)) add2(match[0]);
  }
  return { values, characters };
}
function assertNoNul(value) {
  if (value.includes("\0")) throw new VfsError("EINVAL", "shell expansion produced a NUL byte");
  return value;
}
async function scalarParts(parts, session, fileSystem, budget, runtime) {
  let output = "";
  let characters = 0;
  for (const part of parts) {
    const value = await partValue(part, session, fileSystem, budget, runtime);
    budget.expansionWork(value.length);
    characters += codePointLength(value);
    budget.checkExpansionOutput(characters, 0);
    output += value;
  }
  return assertNoNul(output);
}
async function patternParts(word, session, fileSystem, budget, runtime) {
  let pattern = "";
  let characters = 0;
  for (const part of word.parts) {
    const value = await partValue(part, session, fileSystem, budget, runtime);
    const fragment = part.quoted ? escapeGlob(value) : value;
    budget.expansionWork(fragment.length);
    characters += codePointLength(fragment);
    budget.checkExpansionOutput(characters, 0);
    pattern += fragment;
  }
  return assertNoNul(pattern);
}
async function parameterOperand(expansion, session, fileSystem, budget, runtime) {
  return expansion.word === void 0 ? "" : await scalarParts(expansion.word.parts, session, fileSystem, budget, runtime);
}
function parameterLengthValue(expansion, session, budget) {
  if (expansion.name === "@" || expansion.name === "*") return String(session.args.length);
  const state = variableState(expansion.name, session);
  if (!state.set && session.nounset) throw new ShellNounsetError(expansion.name);
  budget.expansionWork(state.value.length);
  return String(codePointLength(state.value));
}
async function operatedParameterValue(expansion, session, fileSystem, budget, runtime) {
  const state = variableState(expansion.name, session);
  const absent = !state.set || expansion.operator.startsWith(":") && state.value.length === 0;
  if (expansion.operator.endsWith("-")) {
    return absent ? await parameterOperand(expansion, session, fileSystem, budget, runtime) : state.value;
  }
  if (expansion.operator.endsWith("+")) {
    return absent ? "" : await parameterOperand(expansion, session, fileSystem, budget, runtime);
  }
  if (expansion.operator.endsWith("=")) {
    if (!absent) return state.value;
    const value = await parameterOperand(expansion, session, fileSystem, budget, runtime);
    assignParameter(expansion.name, value, session);
    return value;
  }
  if (!absent) return state.value;
  return missingParameter(
    expansion.name,
    session,
    await parameterOperand(expansion, session, fileSystem, budget, runtime)
  );
}
async function basicParameterValue(expansion, session, fileSystem, budget, runtime) {
  if (expansion.length) return parameterLengthValue(expansion, session, budget);
  const state = variableState(expansion.name, session);
  const operator = expansion.operator;
  if (operator === void 0) {
    if (!state.set && session.nounset && expansion.name !== "@" && expansion.name !== "*") {
      throw new ShellNounsetError(expansion.name);
    }
    return state.value;
  }
  return await operatedParameterValue(
    { ...expansion, operator },
    session,
    fileSystem,
    budget,
    runtime
  );
}
async function substringParameterValue(expansion, value, session, fileSystem, budget, runtime) {
  const offset = expansionInteger(
    await scalarParts(expansion.offset.parts, session, fileSystem, budget, runtime),
    "substring offset"
  );
  const length = expansion.substringLength === void 0 ? void 0 : expansionInteger(
    await scalarParts(expansion.substringLength.parts, session, fileSystem, budget, runtime),
    "substring length"
  );
  if (length !== void 0 && length < 0) {
    throw new VfsError("EINVAL", "substring length must not be negative");
  }
  return substringByCodePoint(value, offset, length, budget);
}
async function parameterValue(expansion, session, fileSystem, budget, runtime) {
  if (!("kind" in expansion)) {
    return await basicParameterValue(expansion, session, fileSystem, budget, runtime);
  }
  const state = variableState(expansion.name, session);
  if (!state.set && session.nounset) throw new ShellNounsetError(expansion.name);
  if (expansion.kind === "indirect") return indirectParameterValue(session, state.value);
  if (expansion.kind === "remove") {
    const pattern = await patternParts(expansion.pattern, session, fileSystem, budget, runtime);
    return removeShellPattern(
      state.value,
      pattern,
      expansion.removalOperator.startsWith("#") ? "prefix" : "suffix",
      expansion.removalOperator.length === 2,
      budget
    );
  }
  if (expansion.kind === "replace") {
    const pattern = await patternParts(expansion.pattern, session, fileSystem, budget, runtime);
    const replacement = await scalarParts(
      expansion.replacement.parts,
      session,
      fileSystem,
      budget,
      runtime
    );
    return replaceShellPattern(state.value, pattern, replacement, expansion.all, budget);
  }
  if (expansion.kind === "substring")
    return await substringParameterValue(
      expansion,
      state.value,
      session,
      fileSystem,
      budget,
      runtime
    );
  throw new VfsError("EINVAL", "unsupported parameter expansion");
}
async function partValue(part, session, fileSystem, budget, runtime) {
  if (part.kind === "literal") return assertNoNul(part.value);
  if (part.kind === "parameter") {
    return assertNoNul(await parameterValue(part.expansion, session, fileSystem, budget, runtime));
  }
  if (part.kind === "arithmetic") {
    return String(evaluateArithmetic(part.expression, session.env, session.nounset === true));
  }
  return assertNoNul(await runtime.commandSubstitute(part.script, session));
}
async function partValues(part, session, fileSystem, budget, runtime, existingCharacters, existingFields) {
  if (part.kind === "parameter" && part.expansion.name === "@" && !("kind" in part.expansion)) {
    const expansion = part.expansion;
    if (!expansion.length) {
      const operator = expansion.operator;
      const checkNull = operator?.startsWith(":") ?? false;
      const absent = session.args.length === 0 || checkNull && session.args.join(" ").length === 0;
      const preservesArguments = operator === void 0 || !absent && !operator.endsWith("+");
      if (preservesArguments) {
        return splitValues(session.args, part.quoted, budget, existingCharacters, existingFields);
      }
    }
  }
  const value = await partValue(part, session, fileSystem, budget, runtime);
  return splitValues([value], part.quoted, budget, existingCharacters, existingFields);
}
async function expandWord(word, session, fileSystem, budget, runtime) {
  const braced = expandBraces(word, budget);
  const single = braced.length === 1 ? braced[0] : void 0;
  if (single !== void 0) return expandOneWord(single, session, fileSystem, budget, runtime);
  const output = [];
  for (const candidate of braced) {
    output.push(...await expandOneWord(candidate, session, fileSystem, budget, runtime));
  }
  return output;
}
async function expandFieldGlobs(fields2, session, fileSystem, budget) {
  const output = [];
  let outputCharacters = 0;
  for (const field of fields2) {
    if (!hasGlob(field.pattern)) {
      budget.checkExpansionOutput(outputCharacters + field.characters, output.length + 1);
      output.push(field.value);
      outputCharacters += field.characters;
      continue;
    }
    const matches = await expandGlob(field.value, field.pattern, session, fileSystem, budget);
    for (const value of matches.length === 0 ? [field.value] : matches) {
      budget.expansionWork(value.length);
      const characters = codePointLength(value);
      budget.checkExpansionOutput(outputCharacters + characters, output.length + 1);
      output.push(value);
      outputCharacters += characters;
    }
  }
  budget.expansionOutput(outputCharacters, output.length);
  return output;
}
async function expandOneWord(word, session, fileSystem, budget, runtime) {
  const fields2 = [{ value: "", pattern: "", characters: 0 }];
  let materializedCharacters = 0;
  let preservesEmptyField = false;
  let removedByExpansion = false;
  for (const part of withTildePrefix(word.parts, session, budget)) {
    if (part.kind === "literal") {
      const value = assertNoNul(part.value);
      preservesEmptyField ||= part.quoted;
      budget.expansionWork(value.length);
      const characters = codePointLength(value);
      budget.checkExpansionOutput(materializedCharacters + characters, fields2.length);
      append(fields2, value, !part.quoted);
      materializedCharacters += characters;
      continue;
    }
    const expanded = await partValues(
      part,
      session,
      fileSystem,
      budget,
      runtime,
      materializedCharacters,
      fields2.length
    );
    if (expanded.values.length === 0) removedByExpansion = true;
    else preservesEmptyField ||= part.quoted;
    alternatives(fields2, expanded, !part.quoted);
    materializedCharacters += expanded.characters;
  }
  if (fields2.length === 1 && fields2[0]?.value === "" && removedByExpansion && !preservesEmptyField) {
    budget.expansionOutput(0, 0);
    return [];
  }
  return await expandFieldGlobs(fields2, session, fileSystem, budget);
}
async function expandScalarWord(word, session, fileSystem, budget, runtime) {
  const value = await scalarParts(
    withTildePrefix(word.parts, session, budget),
    session,
    fileSystem,
    budget,
    runtime
  );
  budget.expansionOutput(codePointLength(value));
  return value;
}
async function expandAssignmentValue(word, name, session, fileSystem, budget, runtime) {
  const [first, ...rest] = word.parts;
  if (first?.kind !== "literal") throw new VfsError("EINVAL", "invalid assignment word");
  const parts = withTildePrefix([first, ...rest], session, budget);
  const expandedFirst = parts[0];
  if (expandedFirst?.kind !== "literal") {
    throw new VfsError("EIO", "assignment expansion lost its literal prefix");
  }
  const value = await scalarParts(
    [
      {
        ...expandedFirst,
        value: expandedFirst.value.slice(name.length + 1)
      },
      ...parts.slice(1)
    ],
    session,
    fileSystem,
    budget,
    runtime
  );
  budget.expansionOutput(codePointLength(value));
  return value;
}
async function expandWords(words, session, fileSystem, budget, runtime) {
  const output = [];
  for (const word of words)
    output.push(...await expandWord(word, session, fileSystem, budget, runtime));
  return output;
}
async function expandCasePattern(word, session, fileSystem, budget, runtime) {
  const pattern = await patternParts(word, session, fileSystem, budget, runtime);
  budget.expansionOutput(codePointLength(pattern));
  return pattern;
}
function matchesCasePattern(value, pattern, budget) {
  return matchesShellPattern(value, pattern, budget);
}

// src/shell/script.ts
var SHELL_INTERPRETERS = [
  "/bin/sh",
  "/bin/bash",
  "/usr/bin/sh",
  "/usr/bin/bash"
];
var SHELL_PROFILE_COMMAND = "sh";
var ENV_INTERPRETERS = ["/usr/bin/env", "/bin/env"];
var ENV_INTERPRETER_NAMES = ["sh", "bash"];
var MAX_SHEBANG_BYTES = 256;
var HASH = 35;
var BANG = 33;
var NEWLINE = 10;
var NUL = 0;
function readShebangLine(bytes2) {
  if (bytes2.length < 2 || bytes2[0] !== HASH || bytes2[1] !== BANG) return { line: void 0 };
  const limit = Math.min(bytes2.length, MAX_SHEBANG_BYTES);
  let end = 2;
  while (end < limit && bytes2[end] !== NEWLINE) end += 1;
  if (end === limit && (bytes2[end] ?? NEWLINE) !== NEWLINE) {
    throw new VfsError("ENOEXEC", `interpreter line exceeds ${MAX_SHEBANG_BYTES} bytes`);
  }
  let line = "";
  for (let index = 2; index < end; index += 1) {
    const byte = bytes2[index] ?? NUL;
    if (byte === NUL || byte > 127) {
      throw new VfsError("ENOEXEC", "interpreter line is not ASCII");
    }
    line += String.fromCharCode(byte);
  }
  return { line: line.endsWith("\r") ? line.slice(0, -1) : line };
}
function selectsShellProfile(line) {
  const trimmed = line.trim();
  if (trimmed === "") return false;
  const separator = trimmed.search(/\s/u);
  const interpreter = separator < 0 ? trimmed : trimmed.slice(0, separator);
  const argument = separator < 0 ? "" : trimmed.slice(separator).trim();
  if (SHELL_INTERPRETERS.includes(interpreter)) return argument === "";
  if (!ENV_INTERPRETERS.includes(interpreter)) return false;
  return ENV_INTERPRETER_NAMES.includes(argument);
}
function isExecutableMode(mode) {
  return (mode & 73) !== 0;
}

// src/shell/shell-resolve.ts
function resolveApplet(name, session, runtime) {
  const registry = runtime.commands;
  const viaPath = registry.findPath(name);
  if (viaPath !== void 0) {
    return { command: viaPath.command, kind: "program", path: name };
  }
  const entry = registry.find(name);
  if (entry === void 0) return void 0;
  const searchPath = runtime.pathLookup ? session.env.get("PATH") : void 0;
  const hasProgramForm = entry.kind !== "session-builtin";
  const found = hasProgramForm ? findAppletPath(name, searchPath, runtime) : void 0;
  if (entry.kind !== "program") {
    return { command: entry.command, kind: "builtin", path: found };
  }
  if (searchPath === void 0) return { command: entry.command, kind: "program", path: void 0 };
  return found === void 0 ? void 0 : { command: entry.command, kind: "program", path: found };
}
function findAppletPath(name, searchPath, runtime) {
  if (searchPath === void 0) return void 0;
  for (const component of splitSearchPath(searchPath)) {
    const directory = normalizePath(component === "" ? "/" : component);
    if (runtime.commands.isAppletDirectory(directory)) return `${directory}/${name}`;
  }
  return void 0;
}
function executableCandidates(name, session, runtime) {
  if (name.includes("/")) return [normalizeFileSystemPath(name, session.cwd)];
  if (!runtime.pathLookup) return [];
  const searchPath = session.env.get("PATH");
  if (searchPath === void 0) return [];
  const candidates = [];
  for (const component of splitSearchPath(searchPath)) {
    const directory = component === "" ? session.cwd : normalizePath(component);
    if (runtime.commands.isAppletDirectory(directory)) continue;
    candidates.push(
      normalizeFileSystemPath(
        name,
        component === "" ? session.cwd : normalizeFileSystemPath(component, session.cwd)
      )
    );
  }
  return candidates;
}
function unusable(code, message, path) {
  return {
    kind: "unusable",
    error: code === "EACCES" ? new ShellRefusalError(message, path) : new VfsError(code, message, path)
  };
}
function classifyCandidate(path, runtime) {
  try {
    return { stat: runtime.fileSystem.stat(path) };
  } catch (error) {
    if (!isVfsError(error)) throw error;
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { probe: { kind: "absent" } };
    if (error.code === "EACCES") {
      return {
        probe: {
          kind: "denied",
          error: error instanceof ShellRefusalError ? error : new ShellRefusalError(error.message, error.path)
        }
      };
    }
    throw error;
  }
}
async function probeExecutableScript(path, session, runtime) {
  const classified = classifyCandidate(path, runtime);
  if ("probe" in classified) return classified.probe;
  const stat = classified.stat;
  if (stat.kind !== "file") return unusable("ENOEXEC", "is not a regular file", path);
  if (session.credentials === void 0 ? !isExecutableMode(stat.mode) : !shellModeAllows(stat, session.credentials, 1))
    return unusable("EACCES", "is not executable", path);
  return await loadScriptSource(path, stat, runtime);
}
async function probeShellOperand(path, runtime) {
  const classified = classifyCandidate(path, runtime);
  return "probe" in classified ? classified.probe : await loadScriptSource(path, classified.stat, runtime);
}
async function loadScriptSource(path, stat, runtime) {
  if (stat.kind !== "file") return unusable("ENOEXEC", "is not a regular file", path);
  if (stat.contentClass === "opaque") {
    return unusable("ENOEXEC", "opaque content cannot be executed", path);
  }
  const bytes2 = await readScriptBytes(path, runtime);
  if (bytes2 instanceof VfsError) return { kind: "unusable", error: bytes2 };
  const interpreterError = validateInterpreter(bytes2, path);
  if (interpreterError !== void 0) return interpreterError;
  const release = runtime.budget.buffered(bytes2.byteLength);
  try {
    runtime.budget.io(bytes2.byteLength);
    const source = decodeScript(bytes2);
    if (source === void 0) {
      release();
      return unusable("ENOEXEC", "is not valid UTF-8", path);
    }
    if (source.includes("\0")) {
      release();
      return unusable("ENOEXEC", "contains a NUL byte", path);
    }
    return { kind: "loaded", source, release };
  } catch (error) {
    release();
    throw error;
  }
}
async function readScriptBytes(path, runtime) {
  try {
    return await readAllBytes(
      runtime.fileSystem.readFile(path).stream,
      runtime.limits.maxScriptBytes
    );
  } catch (error) {
    if (isVfsError(error) && (error.code === "EFBIG" || error.code === "E2BIG")) {
      return new VfsError("ENOEXEC", "exceeds the script byte limit", path);
    }
    throw error;
  }
}
function validateInterpreter(bytes2, path) {
  let line;
  try {
    line = readShebangLine(bytes2).line;
  } catch (error) {
    if (!isVfsError(error)) throw error;
    return unusable("ENOEXEC", error.message, path);
  }
  if (line === void 0 || selectsShellProfile(line)) return void 0;
  const spelling = line.trim();
  return unusable(
    "ENOEXEC",
    spelling === "" ? "interpreter line is empty" : `unsupported interpreter: ${spelling}`,
    path
  );
}
function decodeScript(bytes2) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes2);
  } catch {
    return void 0;
  }
}
async function resolveExecutableScript(name, session, runtime) {
  if (name === "") return void 0;
  const explicit = name.includes("/");
  let refusal;
  for (const candidate of executableCandidates(name, session, runtime)) {
    runtime.budget.step();
    const probe = await probeExecutableScript(candidate, session, runtime);
    if (probe.kind === "loaded") {
      return { source: probe.source, release: probe.release, path: candidate };
    }
    if (probe.kind === "absent") continue;
    if (explicit) throw probe.error;
    if (probe.kind === "unusable") refusal ??= probe.error;
  }
  if (refusal !== void 0) throw refusal;
  return void 0;
}
function hasAppletSpec(command) {
  return "spec" in command;
}
function describeCommands(registry) {
  const described = [];
  for (const name of registry.commands.names()) {
    const entry = registry.commands.find(name);
    if (entry === void 0) continue;
    const spec = hasAppletSpec(entry.command) ? entry.command.spec : void 0;
    described.push({
      name,
      kind: entry.kind,
      usage: spec?.usage ?? "",
      summary: spec?.summary ?? ""
    });
  }
  return described;
}
async function findExecutablePath(name, session, runtime) {
  if (name === "") return void 0;
  for (const candidate of executableCandidates(name, session, runtime)) {
    runtime.budget.step();
    const classified = classifyCandidate(candidate, runtime);
    if ("probe" in classified) continue;
    const stat = classified.stat;
    if (stat.kind === "file" && (session.credentials === void 0 ? isExecutableMode(stat.mode) : shellModeAllows(stat, session.credentials, 1)))
      return candidate;
  }
  return void 0;
}
async function resolveShellCommand(name, session, runtime) {
  if (session.functions.has(name)) return { kind: "function", name };
  const allowed2 = runtime.policy.allowedCommands;
  const resolved = resolveApplet(name, session, runtime);
  if (resolved !== void 0) {
    if (allowed2 !== void 0 && !allowed2.includes(resolved.command.name)) return void 0;
    return { kind: resolved.kind, name: resolved.command.name, path: resolved.path };
  }
  if (allowed2 !== void 0 && !allowed2.includes(SHELL_PROFILE_COMMAND)) return void 0;
  const path = await findExecutablePath(name, session, runtime);
  if (path === void 0) return void 0;
  return { kind: "program", name, path: name.includes("/") ? name : path };
}
async function prepareSimpleCommand(node, session, runtime, expansion) {
  const assignments = [];
  const assignmentSession = cloneShellSession(session);
  let wordIndex = 0;
  while (node.words[wordIndex]?.assignmentName !== void 0) {
    const word = node.words[wordIndex];
    if (word === void 0 || word.assignmentName === void 0) break;
    const value = await expandAssignmentValue(
      word,
      word.assignmentName,
      assignmentSession,
      runtime.fileSystem,
      runtime.budget,
      expansion
    );
    assignments.push({ name: word.assignmentName, value });
    assignmentSession.env.set(word.assignmentName, value);
    wordIndex += 1;
  }
  const assignmentNames = new Set(assignments.map((value) => value.name));
  for (const [name, value] of assignmentSession.env) {
    if (!assignmentNames.has(name) && session.env.get(name) !== value) session.env.set(name, value);
  }
  const argv = await expandWords(
    node.words.slice(wordIndex),
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion
  );
  return { assignments, argv };
}

// src/shell/content.ts
function scopedContentReader(reader, assertReadable) {
  return {
    async open(path, range, signal) {
      assertReadable(path);
      return reader.open(path, range, signal);
    }
  };
}
async function openContent(fileSystem, path, options = {}) {
  if (options.reader === void 0 || (options.access ?? "metadata") !== "stream") {
    return openInline(fileSystem, path, options.range);
  }
  try {
    return openInline(fileSystem, path, options.range);
  } catch (error) {
    if (!isVfsError(error) || error.code !== "ENOTSUP") throw error;
  }
  return options.reader.open(path, options.range, options.signal);
}
function openInline(fileSystem, path, range) {
  try {
    const inline = fileSystem.readFile(path, range === void 0 ? void 0 : { range });
    return { stat: inline.stat, stream: inline.stream };
  } catch (error) {
    if (isVfsError(error) && (error.code === "EISDIR" || error.code === "ENOTSUP")) {
      throw new VfsError(error.code, error.message, path);
    }
    throw error;
  }
}

// src/shell/input.ts
var ShellInputCursor = class {
  source;
  pending;
  done = false;
  reading = false;
  constructor(source) {
    this.source = source;
  }
  takePending() {
    const pending = this.pending;
    if (pending === void 0) return void 0;
    this.pending = void 0;
    pending.release();
    return pending.bytes;
  }
  retain(bytes2, budget) {
    if (bytes2.byteLength === 0) return;
    const release = budget.buffered(bytes2.byteLength);
    try {
      this.pending = { bytes: bytes2.slice(), release };
    } catch (error) {
      release();
      throw error;
    }
  }
  async readChunk(signal) {
    if (signal?.aborted === true) {
      throw signal.reason instanceof VfsError ? signal.reason : new VfsError("ECANCELED", "execution was cancelled");
    }
    const pending = this.takePending();
    if (pending !== void 0) return { done: false, value: pending };
    if (this.done) return { done: true, value: void 0 };
    if (this.reading) throw new VfsError("EIO", "shell input is already being consumed");
    this.reading = true;
    const reader = this.source.getReader();
    const cancelled = () => signal?.reason instanceof VfsError ? signal.reason : new VfsError("ECANCELED", "execution was cancelled");
    const abort = () => {
      const error = cancelled();
      void reader.cancel(error).catch(() => void 0);
    };
    try {
      const result = await new Promise((resolve, reject) => {
        const abortRead = () => {
          const error = cancelled();
          abort();
          reject(error);
        };
        signal?.addEventListener("abort", abortRead, { once: true });
        void reader.read().then(resolve, reject).finally(() => {
          signal?.removeEventListener("abort", abortRead);
        });
      });
      if (result.done) this.done = true;
      return result;
    } finally {
      reader.releaseLock();
      this.reading = false;
    }
  }
  async readRecord(budget, signal) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let value = "";
    let contentBytes = 0;
    let release = () => void 0;
    const decode = (bytes2, stream) => {
      if (bytes2.byteLength === 0) return;
      contentBytes += bytes2.byteLength;
      release();
      release = budget.buffered(contentBytes);
      try {
        value += decoder.decode(bytes2, { stream });
      } catch {
        throw new VfsError("EIO", "read: input is not valid UTF-8");
      }
    };
    const finish = () => {
      try {
        value += decoder.decode();
      } catch {
        throw new VfsError("EIO", "read: input is not valid UTF-8");
      }
      if (value.includes("\0")) throw new VfsError("EINVAL", "read: input contains a NUL byte");
      return value;
    };
    try {
      while (true) {
        const result = await this.readChunk(signal);
        if (result.done) {
          if (contentBytes === 0) return { value: "", terminated: false, empty: true };
          return {
            value: finish(),
            terminated: false,
            empty: false
          };
        }
        const newline = result.value.indexOf(10);
        const consumedBytes = newline < 0 ? result.value.byteLength : newline + 1;
        budget.io(consumedBytes);
        if (contentBytes + consumedBytes > budget.limits.maxLineBytes) {
          throw new VfsError("E2BIG", "read: line byte limit exceeded");
        }
        if (newline < 0) {
          decode(result.value, true);
          continue;
        }
        decode(result.value.subarray(0, newline), true);
        this.retain(result.value.subarray(newline + 1), budget);
        return {
          value: finish(),
          terminated: true,
          empty: false
        };
      }
    } catch (error) {
      await this.cancel(error).catch(() => void 0);
      throw error;
    } finally {
      release();
    }
  }
  async cancel(reason) {
    this.done = true;
    const pending = this.pending;
    this.pending = void 0;
    pending?.release();
    await this.source.cancel(reason);
  }
};
var cursors = /* @__PURE__ */ new WeakMap();
function shellInput(source) {
  if (cursors.has(source)) return source;
  const cursor = new ShellInputCursor(source);
  const stream = new ReadableStream(
    {
      async pull(controller) {
        try {
          const result = await cursor.readChunk();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await cursor.cancel(reason);
      }
    },
    { highWaterMark: 0 }
  );
  cursors.set(stream, cursor);
  return stream;
}

// src/shell/pipe.ts
var DownstreamClosedError = class extends VfsError {
  downstreamClosed = true;
  constructor(message) {
    super("EPIPE", message);
    this.name = "DownstreamClosedError";
  }
};
function isDownstreamClosedError(error) {
  return error instanceof DownstreamClosedError || typeof error === "object" && error !== null && "downstreamClosed" in error && error.downstreamClosed === true;
}
var SharedSink = class _SharedSink {
  state;
  released = false;
  constructor(state) {
    this.state = state;
  }
  clone() {
    if (this.released || this.state.terminal) throw new VfsError("EPIPE", "sink is closed");
    this.state.references += 1;
    return new _SharedSink(this.state);
  }
  async write(chunk) {
    if (this.released || this.state.terminal) throw new VfsError("EPIPE", "sink is closed");
    await this.state.writer.write(chunk.slice());
  }
  async close() {
    if (this.released) return;
    this.released = true;
    if (this.state.terminal) return;
    this.state.references -= 1;
    if (this.state.references === 0) {
      this.state.terminal = true;
      await this.state.writer.close();
    }
  }
  async abort(reason) {
    if (this.released) return;
    this.released = true;
    if (this.state.terminal) return;
    this.state.references = 0;
    this.state.terminal = true;
    await this.state.writer.abort(reason);
  }
};
function sinkFromWritable(writable) {
  return new SharedSink({ writer: writable.getWriter(), references: 1, terminal: false });
}
var BytePipeState = class {
  #controller;
  #bytesWritten = 0;
  #cancelled;
  #pullWaiters = [];
  options;
  readable;
  writable;
  constructor(options) {
    this.options = options;
    this.readable = this.#createReadable();
    this.writable = this.#createWritable();
  }
  #cancellationError() {
    return this.options.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled");
  }
  #closedError() {
    return this.#cancelled instanceof Error ? this.#cancelled : new VfsError("EPIPE", `${this.options.name} consumer closed early`);
  }
  #wakeWriters() {
    if (this.#cancelled === void 0 && (this.#controller?.desiredSize ?? 0) <= 0) return;
    const waiters = this.#pullWaiters;
    this.#pullWaiters = [];
    for (const resolve of waiters) resolve();
  }
  #consumerCancelled(reason) {
    this.#cancelled = this.options.onConsumerCancel === void 0 ? new DownstreamClosedError(`${this.options.name} consumer closed early`) : reason ?? new VfsError("ECANCELED", `${this.options.name} consumer cancelled execution`);
    if (this.options.onConsumerCancel !== void 0) {
      const cancelExecution = this.options.onConsumerCancel;
      const cancellation = this.#cancelled;
      void Promise.resolve().then(() => cancelExecution(cancellation));
    }
    this.#wakeWriters();
  }
  #createReadable() {
    return new ReadableStream(
      {
        start: (controller) => {
          this.#controller = controller;
        },
        pull: () => this.#wakeWriters(),
        cancel: (reason) => this.#consumerCancelled(reason)
      },
      {
        highWaterMark: Math.min(this.options.maximumBytes, 64 * 1024),
        size: (chunk) => chunk.byteLength
      }
    );
  }
  abortFromSignal = () => {
    if (this.#cancelled !== void 0) return;
    this.#cancelled = this.#cancellationError();
    try {
      this.#controller?.error(this.#cancelled);
    } catch {
    }
    this.#wakeWriters();
  };
  #removeAbortListener() {
    this.options.signal.removeEventListener("abort", this.abortFromSignal);
  }
  #accept(chunk) {
    if (this.options.signal.aborted) throw this.#cancellationError();
    if (this.#cancelled !== void 0) throw this.#closedError();
    this.#bytesWritten += chunk.byteLength;
    this.options.account?.(chunk.byteLength);
    if (this.#bytesWritten > this.options.maximumBytes) {
      throw new VfsError(
        "E2BIG",
        `${this.options.name} exceeds the ${this.options.maximumBytes}-byte limit`
      );
    }
    this.#controller?.enqueue(chunk);
  }
  async #waitForCapacity() {
    if ((this.#controller?.desiredSize ?? 1) > 0) return;
    let idleTimer;
    if (this.options.idleTimeoutMs !== void 0 && this.options.onIdle !== void 0) {
      idleTimer = setTimeout(this.options.onIdle, this.options.idleTimeoutMs);
    }
    try {
      await new Promise((resolve) => this.#pullWaiters.push(resolve));
    } finally {
      if (idleTimer !== void 0) clearTimeout(idleTimer);
    }
    if (this.options.signal.aborted) throw this.#cancellationError();
    if (this.#cancelled !== void 0) throw this.#closedError();
  }
  #fail(error) {
    if (this.#cancelled === void 0) {
      this.#cancelled = error;
      try {
        this.#controller?.error(error);
      } catch {
      }
    }
    this.#wakeWriters();
  }
  #createWritable() {
    return new WritableStream({
      write: async (chunk) => {
        try {
          this.#accept(chunk);
          await this.#waitForCapacity();
        } catch (error) {
          this.#fail(error);
          throw error;
        }
      },
      close: () => {
        this.#removeAbortListener();
        if (this.#cancelled === void 0) this.#controller?.close();
        this.#wakeWriters();
      },
      abort: (reason) => {
        this.#removeAbortListener();
        if (this.#cancelled === void 0) this.#controller?.error(reason);
        this.#wakeWriters();
      }
    });
  }
};
function createBytePipe(options) {
  const state = new BytePipeState(options);
  if (options.signal.aborted) state.abortFromSignal();
  else options.signal.addEventListener("abort", state.abortFromSignal, { once: true });
  return { readable: state.readable, sink: sinkFromWritable(state.writable) };
}

// src/shell/redirection.ts
function atomicFileSink(fileSystem, path, append2, maximumBytes, budget) {
  const stat = fileSystem.inspectWriteTarget(path);
  const mutationToken = stat?.path === path ? stat.mutationToken : fileSystem.getMutationToken(path);
  const exists = stat !== null;
  if (stat !== null) {
    if (stat.kind === "directory") throw new VfsError("EISDIR", "is a directory", path);
    if (append2 && stat.contentClass === "opaque") {
      throw new VfsError("ENOTSUP", "cannot append to opaque R2 content", path);
    }
  }
  const chunks = [];
  let total = 0;
  let release = () => void 0;
  let aborted = false;
  const writable = new WritableStream({
    write(chunk) {
      total += chunk.byteLength;
      if (total > maximumBytes) {
        throw new VfsError("EFBIG", `redirection exceeds the ${maximumBytes}-byte limit`, path);
      }
      release();
      release = budget.buffered(total);
      chunks.push(chunk);
    },
    async close() {
      if (aborted) return;
      const single = chunks[0];
      const body = chunks.length <= 1 ? single ?? new Uint8Array(0) : new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      });
      try {
        if (append2 && exists) {
          await fileSystem.appendFile(path, body, { ifMutationToken: mutationToken });
        } else {
          await fileSystem.writeFile(path, body, {
            ifMutationToken: mutationToken,
            disposition: exists ? "replace" : "create"
          });
        }
      } finally {
        chunks.length = 0;
        release();
      }
    },
    abort() {
      aborted = true;
      release();
      chunks.length = 0;
    }
  });
  return sinkFromWritable(writable);
}
async function targetPath(target, session, fileSystem, budget, runtime) {
  const values = await expandWord(target, session, fileSystem, budget, runtime);
  if (values.length !== 1 || values[0] === void 0) {
    throw new VfsError("EINVAL", "ambiguous redirection target");
  }
  return normalizeFileSystemPath(values[0], session.cwd);
}
var RedirectionState = class {
  constructor(initial, session, fileSystem, budget, cancelReplacedInput, runtime, input) {
    this.session = session;
    this.fileSystem = fileSystem;
    this.budget = budget;
    this.cancelReplacedInput = cancelReplacedInput;
    this.runtime = runtime;
    this.input = input;
    this.fds = { 0: initial[0], 1: initial[1], 2: initial[2] };
  }
  session;
  fileSystem;
  budget;
  cancelReplacedInput;
  runtime;
  input;
  fds;
  redirected = /* @__PURE__ */ new Set();
  #inputRedirected = false;
  get inputRedirected() {
    return this.#inputRedirected;
  }
  async #duplicate(from, to) {
    await this.fds[to].close();
    this.fds[to] = this.fds[from].clone();
    if (this.redirected.has(from)) this.redirected.add(to);
    else this.redirected.delete(to);
  }
  async #replaceInput(stream) {
    if (this.cancelReplacedInput || this.#inputRedirected) {
      await this.fds[0].cancel(new VfsError("EPIPE", "pipeline input was replaced by redirection"));
    }
    this.fds[0] = shellInput(stream);
    this.#inputRedirected = true;
  }
  async #scalarInput(word, newline) {
    const value = await expandScalarWord(
      word,
      this.session,
      this.fileSystem,
      this.budget,
      this.runtime
    );
    await this.#replaceInput(bodyToStream(newline ? `${value}
` : value));
  }
  async #pathInput(path, device) {
    if (device === "stdin") return;
    const replacement = device === void 0 ? (await openContent(this.fileSystem, path, {
      reader: this.input.content,
      access: this.input.access,
      signal: this.input.signal
    })).stream : deviceInput(device, this.fds, path);
    await this.#replaceInput(replacement);
  }
  async #bothOutputs(replacement) {
    const errorReplacement = replacement.clone();
    try {
      await Promise.all([this.fds[1].close(), this.fds[2].close()]);
    } catch (error) {
      await replacement.abort(error).catch(() => void 0);
      throw error;
    }
    this.fds[1] = replacement;
    this.fds[2] = errorReplacement;
    this.redirected.add(1);
    this.redirected.add(2);
  }
  async #oneOutput(replacement, descriptor) {
    try {
      await this.fds[descriptor].close();
    } catch (error) {
      await replacement.abort(error).catch(() => void 0);
      throw error;
    }
    this.fds[descriptor] = replacement;
    this.redirected.add(descriptor);
  }
  async #pathOutput(path, device, operator) {
    const replacement = device === void 0 ? atomicFileSink(
      this.fileSystem,
      path,
      operator.endsWith(">>"),
      this.budget.limits.maxPipelineBytes,
      this.budget
    ) : deviceSink(device, this.fds, path);
    if (operator === "&>" || operator === "&>>") return await this.#bothOutputs(replacement);
    await this.#oneOutput(replacement, operator.startsWith("2") ? 2 : 1);
  }
  async apply(redirection) {
    if (redirection.operator === "2>&1") return await this.#duplicate(1, 2);
    if (redirection.operator === ">&2") return await this.#duplicate(2, 1);
    if (redirection.operator === "<<<") return await this.#scalarInput(redirection.target, true);
    if ("document" in redirection) return await this.#scalarInput(redirection.document, false);
    const path = await targetPath(
      redirection.target,
      this.session,
      this.fileSystem,
      this.budget,
      this.runtime
    );
    const device = shellDevice(path);
    if (device !== void 0) {
      if (redirection.operator === "<") this.fileSystem.assertReadable(path);
      else this.fileSystem.assertWritable(path);
    }
    return redirection.operator === "<" ? await this.#pathInput(path, device) : await this.#pathOutput(path, device, redirection.operator);
  }
};
async function applyRedirections(redirections2, initial, session, fileSystem, budget, cancelReplacedInput, runtime, input = {}) {
  const state = new RedirectionState(
    initial,
    session,
    fileSystem,
    budget,
    cancelReplacedInput,
    runtime,
    input
  );
  try {
    for (const redirection of redirections2) await state.apply(redirection);
    return {
      fds: state.fds,
      redirected: state.redirected,
      inputRedirected: state.inputRedirected
    };
  } catch (error) {
    await Promise.allSettled([
      state.fds[0] === initial[0] ? Promise.resolve() : state.fds[0].cancel(error),
      state.redirected.has(1) ? state.fds[1].abort(error) : state.fds[1].close(),
      state.redirected.has(2) ? state.fds[2].abort(error) : state.fds[2].close()
    ]);
    throw error;
  }
}

// src/core/decimal-integer.ts
function normalizeDecimalInteger(value) {
  if (!/^-?[0-9]+$/u.test(value)) return void 0;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const digits = unsigned.replace(/^0+/u, "") || "0";
  return { negative: negative && digits !== "0", digits };
}
function compareDecimalIntegers(left, right) {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  let order = left.digits.length - right.digits.length;
  if (order === 0 && left.digits !== right.digits) order = left.digits < right.digits ? -1 : 1;
  return left.negative ? -order : order;
}

// src/shell/commands/format.ts
var FILE_TYPE_MASK = 61440;
var REGULAR_FILE_TYPE = 32768;
var CHARACTER_DEVICE_TYPE = 8192;
function isRegularFile(stat) {
  return (stat.mode & FILE_TYPE_MASK) === REGULAR_FILE_TYPE;
}
function isCharacterDevice(stat) {
  return (stat.mode & FILE_TYPE_MASK) === CHARACTER_DEVICE_TYPE;
}

// src/shell/shell-condition.ts
function consumeLoopFlow(session) {
  const flow = session.flow;
  if (flow.type !== "break" && flow.type !== "continue") return "none";
  if (flow.levels > 1) {
    session.flow = { type: flow.type, levels: flow.levels - 1 };
    return "propagate";
  }
  session.flow = { type: "none" };
  return flow.type;
}
function flowActive(session) {
  return session.flow.type !== "none";
}
function normalizeConditionalInteger(value, budget) {
  budget.expansionWork(value.length);
  const normalized = normalizeDecimalInteger(value);
  if (normalized === void 0) {
    throw new VfsError("EINVAL", "[[: integer expression expected");
  }
  return normalized;
}
function compareConditionalIntegers(left, right, budget) {
  return compareDecimalIntegers(
    normalizeConditionalInteger(left, budget),
    normalizeConditionalInteger(right, budget)
  );
}
function conditionalFileTest(operator, stat, session) {
  switch (operator) {
    case "-e":
      return true;
    case "-L":
    case "-h":
      return stat.kind === "symlink";
    case "-c":
      return isCharacterDevice(stat);
    case "-f":
      return stat.kind === "file" && isRegularFile(stat);
    case "-d":
      return stat.kind === "directory";
    case "-s":
      return stat.sizeBytes > 0;
    // Effective mode bits when credentials exist; compatibility fallback
    // otherwise. See the `test` profile.
    case "-r":
      return shellModeAllows(stat, session.credentials, 4);
    case "-w":
      return shellModeAllows(stat, session.credentials, 2);
    case "-x":
      return shellModeAllows(stat, session.credentials, 1);
    default:
      throw new VfsError("EINVAL", `[[: unsupported unary operator ${operator}`);
  }
}
function descendConditional(expression, pending, runtime) {
  let current = expression;
  while (current.type === "conditional-not" || current.type === "conditional-group" || current.type === "conditional-boolean") {
    runtime.budget.step();
    if (current.type === "conditional-not") {
      pending.push({ type: "not" });
      current = current.expression;
    } else if (current.type === "conditional-group") {
      current = current.expression;
    } else {
      pending.push({ type: "boolean", operator: current.operator, right: current.right });
      current = current.left;
    }
  }
  runtime.budget.step();
  return current;
}
async function evaluateConditionalLeaf(expression, session, runtime, expansion) {
  if (expression.type === "conditional-word") {
    const value = await expandScalarWord(
      expression.word,
      session,
      runtime.fileSystem,
      runtime.budget,
      expansion
    );
    return value.length > 0;
  }
  if (expression.type === "conditional-unary") {
    return await evaluateConditionalUnary(expression, session, runtime, expansion);
  }
  return await evaluateConditionalBinary(expression, session, runtime, expansion);
}
async function evaluateConditionalUnary(expression, session, runtime, expansion) {
  const operand = await expandScalarWord(
    expression.operand,
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion
  );
  if (expression.operator === "-n") return operand.length > 0;
  if (expression.operator === "-z") return operand.length === 0;
  if (expression.operator === "-v") return isShellParameterSet(operand, session);
  if (operand.length === 0) return false;
  try {
    const path = normalizePathPreservingTrailingSlash(operand, session.cwd);
    const asksAboutLink = expression.operator === "-L" || expression.operator === "-h";
    const stat = asksAboutLink ? runtime.fileSystem.lstat(path) : runtime.fileSystem.stat(path);
    return conditionalFileTest(expression.operator, stat, session);
  } catch (error) {
    if (error instanceof VfsError && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return false;
    }
    throw error;
  }
}
async function evaluateConditionalBinary(expression, session, runtime, expansion) {
  const left = await expandScalarWord(
    expression.left,
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion
  );
  if (expression.operator === "==" || expression.operator === "!=") {
    const pattern = await expandCasePattern(
      expression.right,
      session,
      runtime.fileSystem,
      runtime.budget,
      expansion
    );
    const matches = matchesCasePattern(left, pattern, runtime.budget);
    return expression.operator === "==" ? matches : !matches;
  }
  const right = await expandScalarWord(
    expression.right,
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion
  );
  if (expression.operator === "<" || expression.operator === ">") {
    runtime.budget.expansionWork(left.length + right.length);
    const order = compareUtf8(left, right);
    return expression.operator === "<" ? order < 0 : order > 0;
  }
  return compareConditionalNumbers(expression.operator, left, right, runtime.budget);
}
function compareConditionalNumbers(operator, left, right, budget) {
  const order = compareConditionalIntegers(left, right, budget);
  if (operator === "-eq") return order === 0;
  if (operator === "-ne") return order !== 0;
  if (operator === "-lt") return order < 0;
  if (operator === "-le") return order <= 0;
  if (operator === "-gt") return order > 0;
  return order >= 0;
}
function resumeConditional(initialValue, pending) {
  let value = initialValue;
  for (let frame = pending.pop(); frame !== void 0; frame = pending.pop()) {
    if (frame.type === "not") {
      value = !value;
      continue;
    }
    const shortCircuited = frame.operator === "&&" ? !value : value;
    if (!shortCircuited) return { done: false, expression: frame.right };
  }
  return { done: true, value };
}
async function evaluateConditional(expression, session, runtime, expansion) {
  const pending = [];
  let current = expression;
  while (true) {
    const leaf = descendConditional(current, pending, runtime);
    const value = await evaluateConditionalLeaf(leaf, session, runtime, expansion);
    const continuation = resumeConditional(value, pending);
    if (continuation.done) return continuation.value;
    current = continuation.expression;
  }
}

// src/shell/parser-errors.ts
var IncompleteShellSyntaxError = class extends VfsError {
  constructor(message) {
    super("EINVAL", message);
    this.name = "IncompleteShellSyntaxError";
  }
};
function incompleteShellSyntaxError(message) {
  return new IncompleteShellSyntaxError(message);
}
function isIncompleteShellSyntaxError(error) {
  return error instanceof IncompleteShellSyntaxError;
}

// src/shell/parser-support.ts
var PATH_REDIRECTION_OPERATORS = ["<", ">", ">>", "2>", "2>>", "&>", "&>>"];
var PATH_REDIRECTIONS = new Set(PATH_REDIRECTION_OPERATORS);
var HEREDOC_REDIRECTIONS = /* @__PURE__ */ new Set(["<<", "<<-"]);
var REDIRECTIONS = /* @__PURE__ */ new Set([
  ...PATH_REDIRECTIONS,
  ...HEREDOC_REDIRECTIONS,
  "2>&1",
  ">&2",
  "<<<"
]);
function isPathRedirectionOperator(value) {
  return PATH_REDIRECTIONS.has(value);
}
var UNSUPPORTED_RESERVED = /* @__PURE__ */ new Set([
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "in",
  "esac",
  "select",
  "function",
  "time",
  "coproc",
  "[[",
  "]]"
]);
var UNSUPPORTED_CONDITIONAL_UNARY = /* @__PURE__ */ new Set([
  "-a",
  "-b",
  "-g",
  "-k",
  "-N",
  "-O",
  "-p",
  "-r",
  "-R",
  "-s",
  "-S",
  "-t",
  "-u",
  "-w",
  "-x"
]);
var CONDITIONAL_UNARY_OPERATORS = [
  "-n",
  "-z",
  "-e",
  "-f",
  "-d",
  "-s",
  "-r",
  "-w",
  "-x",
  "-L",
  "-h",
  "-c",
  "-v"
];
function conditionalUnaryOperator(value) {
  return CONDITIONAL_UNARY_OPERATORS.find((candidate) => candidate === value);
}
function conditionalBinaryOperator(token) {
  if (token?.type === "operator" && (token.value === "<" || token.value === ">")) {
    return token.value;
  }
  if (token?.type !== "word") return void 0;
  const value = staticWord(token.word);
  if (value === "==" || value === "=" || value === "!=" || value === "-eq" || value === "-ne" || value === "-lt" || value === "-le" || value === "-gt" || value === "-ge") {
    return value === "=" ? "==" : value;
  }
  return void 0;
}
var BYTE_OFFSET_CHECKPOINT_STRIDE = 256;
function utf8PrefixDelta(source, index) {
  const value = source.charCodeAt(index);
  if (value >= 56320 && value <= 57343) {
    const previous = source.charCodeAt(index - 1);
    if (previous >= 55296 && previous <= 56319) return 1;
  }
  return value <= 127 ? 1 : value <= 2047 ? 2 : 3;
}
function utf8ByteOffsets(source, checkDeadline) {
  const offsets = new Uint32Array(Math.floor(source.length / BYTE_OFFSET_CHECKPOINT_STRIDE) + 1);
  let bytes2 = 0;
  for (let index = 0; index < source.length; index += 1) {
    if ((index & 4095) === 0) checkDeadline();
    bytes2 += utf8PrefixDelta(source, index);
    const next = index + 1;
    if (next % BYTE_OFFSET_CHECKPOINT_STRIDE === 0) {
      offsets[next / BYTE_OFFSET_CHECKPOINT_STRIDE] = bytes2;
    }
  }
  checkDeadline();
  return offsets;
}
function utf8ByteOffset(source, offsets, offset) {
  const checkpoint = Math.floor(offset / BYTE_OFFSET_CHECKPOINT_STRIDE);
  let bytes2 = offsets[checkpoint] ?? 0;
  for (let index = checkpoint * BYTE_OFFSET_CHECKPOINT_STRIDE; index < offset; index += 1) {
    bytes2 += utf8PrefixDelta(source, index);
  }
  return bytes2;
}
var TopLevelDelimiterScanner = class {
  constructor(source, delimiter, offsets) {
    this.source = source;
    this.delimiter = delimiter;
    this.offsets = offsets;
  }
  source;
  delimiter;
  offsets;
  braces = 0;
  parentheses = 0;
  quote;
  consumeQuote(character) {
    if (this.quote !== void 0) {
      if (character === this.quote) this.quote = void 0;
      return true;
    }
    if (character !== "'" && character !== '"') return false;
    this.quote = character;
    return true;
  }
  consumeNesting(index, character) {
    if (this.source.startsWith("${", index)) this.braces += 1;
    else if (this.source.startsWith("$(", index)) this.parentheses += 1;
    else if (character === "(" && this.parentheses > 0) this.parentheses += 1;
    else if (character === ")" && this.parentheses > 0) this.parentheses -= 1;
    else if (character === "}" && this.braces > 0) this.braces -= 1;
    else return false;
    return true;
  }
  advance(index) {
    const character = this.source[index];
    if (character === "\\" && this.quote !== "'") return 2;
    if (this.consumeQuote(character)) return 1;
    if (this.consumeNesting(index, character)) {
      return this.source.startsWith("$", index) ? 2 : 1;
    }
    if (character === this.delimiter && this.braces === 0 && this.parentheses === 0) {
      this.offsets.push(index);
    }
    return 1;
  }
};
function topLevelDelimiters(source, delimiter, checkDeadline, start = 0) {
  const offsets = [];
  const scanner = new TopLevelDelimiterScanner(source, delimiter, offsets);
  for (let index = start; index < source.length; ) {
    if ((index & 4095) === 0) checkDeadline();
    index += scanner.advance(index);
  }
  return offsets;
}
var ParseContext = class {
  maximumNodes;
  maximumDepth;
  accountNodes;
  check;
  nodes = 0;
  constructor(maximumNodes, maximumDepth, accountNodes, checkDeadline) {
    this.maximumNodes = maximumNodes;
    this.maximumDepth = maximumDepth;
    this.accountNodes = accountNodes;
    this.check = checkDeadline;
  }
  add(count = 1) {
    this.check();
    this.nodes += count;
    this.accountNodes(count);
    if (this.nodes > this.maximumNodes)
      throw new VfsError("E2BIG", "shell AST node limit exceeded");
  }
  depth(value) {
    this.check();
    if (value > this.maximumDepth)
      throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
  }
  checkDeadline() {
    this.check();
  }
  remainingNodes() {
    return this.maximumNodes - this.nodes;
  }
};
function isHorizontalWhitespace(value) {
  return value === " " || value === "	" || value === "\r";
}
function isBoundary(value) {
  return value === void 0 || isHorizontalWhitespace(value) || ";\n|&<>()".includes(value);
}
function staticWord(word) {
  if (word === void 0 || word.parts.some((part) => part.kind !== "literal" || part.quoted))
    return void 0;
  return word.parts.map((part) => part.kind === "literal" ? part.value : "").join("");
}
function literalWordValue(word) {
  let value = "";
  let quoted = false;
  for (const part of word.parts) {
    if (part.kind !== "literal") {
      throw new VfsError("EINVAL", "here-document delimiter must be a literal word");
    }
    value += part.value;
    quoted ||= part.quoted;
  }
  return { value, quoted };
}
function assignmentName(parts) {
  const first = parts[0];
  if (first?.kind !== "literal" || first.quoted) return void 0;
  return /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(first.value)?.[1];
}
var MULTI_CHARACTER_OPERATORS = [
  "2>&1",
  ">&2",
  "<<<",
  "<<-",
  "&&",
  "||",
  ";;",
  "2>>",
  ">>",
  "<<",
  "2>"
];
var BOUNDARY_PREFIX_OPERATORS = /* @__PURE__ */ new Set(["2>&1", "2>>", "2>"]);
var BOUNDARY_SUFFIX_OPERATORS = /* @__PURE__ */ new Set(["2>&1", ">&2"]);
var SINGLE_CHARACTER_OPERATORS = /* @__PURE__ */ new Set([";", "\n", "|", ">", "<", "(", ")"]);
function validMultiCharacterOperator(source, offset, candidate, atBoundary) {
  if (!source.startsWith(candidate, offset)) return false;
  if (BOUNDARY_PREFIX_OPERATORS.has(candidate) && !atBoundary) return false;
  const next = source[offset + candidate.length];
  return !BOUNDARY_SUFFIX_OPERATORS.has(candidate) || isBoundary(next);
}
function singleCharacterOperator(source, offset, atBoundary) {
  const character = source[offset] ?? "";
  if (character === "&") {
    if (source[offset + 1] !== ">") return "&";
    return source[offset + 2] === ">" ? "&>>" : "&>";
  }
  if (SINGLE_CHARACTER_OPERATORS.has(character)) return character;
  const boundaryOperator = character === "{" || character === "}" || character === "!";
  return boundaryOperator && atBoundary && isBoundary(source[offset + 1]) ? character : null;
}
function operatorAt(source, offset, atBoundary) {
  for (const candidate of MULTI_CHARACTER_OPERATORS) {
    if (validMultiCharacterOperator(source, offset, candidate, atBoundary)) return candidate;
  }
  return singleCharacterOperator(source, offset, atBoundary);
}

// src/shell/parser-cursor.ts
var ParserCursor = class {
  tokens;
  context;
  depth;
  index = 0;
  constructor(tokens, context, depth) {
    this.tokens = tokens;
    this.context = context;
    this.depth = depth;
  }
  parse(stop = {}) {
    const before = this.context.nodes;
    this.context.add();
    const lists = [];
    this.skipSeparators();
    while (this.peek() !== void 0 && !this.stopped(stop)) {
      lists.push(this.andOr());
      const token = this.peek();
      if (token === void 0 || this.stopped(stop)) break;
      if (!this.isSeparator(token)) throw this.tokenError("expected command separator", token);
      this.skipSeparators();
    }
    return { type: "script", lists, nodeCount: this.context.nodes - before };
  }
  finished() {
    return this.peek() === void 0;
  }
  add() {
    this.context.add();
  }
  peek(offset = 0) {
    return this.tokens[this.index + offset];
  }
  take() {
    const token = this.tokens[this.index++];
    if (token === void 0) throw incompleteShellSyntaxError("unexpected end of script");
    return token;
  }
  isSeparator(token) {
    return token?.type === "operator" && (token.value === ";" || token.value === "\n");
  }
  skipSeparators() {
    while (this.isSeparator(this.peek())) this.index += 1;
  }
  skipNewlines() {
    while (this.peekOperator() === "\n") this.index += 1;
  }
  requiredList(stop, description, requireSeparator) {
    const body = this.parse(stop);
    const token = this.peek();
    if (body.lists.length === 0) this.throwEmptyList(description, token);
    if (requireSeparator && token !== void 0 && !this.isSeparator(this.tokens[this.index - 1])) {
      throw this.tokenError(`${description} requires a separator before its terminator`, token);
    }
    return body;
  }
  tokenError(message, token) {
    const offset = token.type === "word" ? token.word.sourceOffset : token.offset;
    return new VfsError("EINVAL", `${message} at byte ${offset}`);
  }
  expectWord(value) {
    const token = this.peek();
    if (token?.type !== "word" || staticWord(token.word) !== value) {
      if (token === void 0)
        throw incompleteShellSyntaxError(`expected ${value} at end of script`);
      throw this.tokenError(`expected ${value}`, token);
    }
    this.index += 1;
  }
  expectOperator(value) {
    const token = this.peek();
    if (token?.type !== "operator" || token.value !== value) {
      if (token === void 0)
        throw incompleteShellSyntaxError(`expected ${value} at end of script`);
      throw this.tokenError(`expected ${value}`, token);
    }
    this.index += 1;
  }
  peekOperator(offset = 0) {
    const token = this.peek(offset);
    return token?.type === "operator" ? token.value : void 0;
  }
  withDepth(run) {
    this.context.depth(this.depth + 1);
    this.depth += 1;
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }
  takeWord() {
    const token = this.take();
    if (token.type !== "word") throw this.tokenError("expected word", token);
    return token.word;
  }
  peekWord() {
    const token = this.peek();
    return token?.type === "word" ? token.word : void 0;
  }
  takeWordOffset() {
    return this.takeWord().sourceOffset;
  }
  stopped(stop) {
    const token = this.peek();
    if (token?.type === "operator") return stop.operators?.has(token.value) === true;
    const word = token?.type === "word" ? staticWord(token.word) : void 0;
    return word !== void 0 && stop.words?.has(word) === true;
  }
  throwEmptyList(description, token) {
    if (token === void 0) {
      throw incompleteShellSyntaxError(
        `${description} requires a non-empty command list at end of script`
      );
    }
    throw this.tokenError(`${description} requires a non-empty command list`, token);
  }
};

// src/shell/parser-conditional.ts
var ConditionalParser = class extends ParserCursor {
  doubleBracketCommand() {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      this.skipNewlines();
      const expression = this.conditionalExpression(1);
      const close = this.peek();
      if (close?.type !== "word" || staticWord(close.word) !== "]]") {
        if (close === void 0) {
          throw incompleteShellSyntaxError(`unterminated [[ at byte ${sourceOffset}`);
        }
        throw this.tokenError(
          `unexpected token ${this.conditionalTokenValue(close)} in [[ expression`,
          close
        );
      }
      this.take();
      const redirections2 = this.redirections();
      this.add();
      return { type: "double-bracket", expression, redirections: redirections2, sourceOffset };
    });
  }
  conditionalEnd() {
    const token = this.peek();
    return token?.type === "word" && staticWord(token.word) === "]]";
  }
  conditionalTokenValue(token) {
    if (token.type === "operator") return token.value;
    if (token.type === "arithmetic-command") return "((...))";
    return staticWord(token.word) ?? "expanded word";
  }
  conditionalOperand(description) {
    const token = this.peek();
    if (token?.type !== "word" || this.conditionalEnd()) {
      if (token === void 0) {
        throw incompleteShellSyntaxError(`[[ ${description} is missing at end of script`);
      }
      throw this.tokenError(`[[ ${description} is missing`, token);
    }
    this.take();
    return token.word;
  }
  conditionalExpression(depth) {
    this.context.depth(this.depth + depth);
    return this.conditionalOr(depth);
  }
  conditionalOr(depth) {
    let left = this.conditionalAnd(depth);
    while (this.peekOperator() === "||") {
      this.take();
      this.skipNewlines();
      const right = this.conditionalAnd(depth);
      this.add();
      left = { type: "conditional-boolean", operator: "||", left, right };
    }
    return left;
  }
  conditionalAnd(depth) {
    let left = this.conditionalNot(depth);
    while (this.peekOperator() === "&&") {
      this.take();
      this.skipNewlines();
      const right = this.conditionalNot(depth);
      this.add();
      left = { type: "conditional-boolean", operator: "&&", left, right };
    }
    return left;
  }
  conditionalNot(depth) {
    if (this.peekOperator() !== "!") return this.conditionalPrimary(depth);
    this.take();
    this.skipNewlines();
    this.context.depth(this.depth + depth + 1);
    const expression = this.conditionalNot(depth + 1);
    this.add();
    return { type: "conditional-not", expression };
  }
  conditionalPrimary(depth) {
    if (this.peekOperator() !== "(") return this.conditionalTest();
    this.take();
    this.skipNewlines();
    this.context.depth(this.depth + depth + 1);
    const expression = this.conditionalOr(depth + 1);
    const close = this.peek();
    if (close?.type !== "operator" || close.value !== ")") {
      if (close === void 0) throw incompleteShellSyntaxError("[[ expected ) at end of script");
      throw this.tokenError("[[ expected )", close);
    }
    this.take();
    this.add();
    return { type: "conditional-group", expression };
  }
  conditionalTest() {
    const first = this.peek();
    if (first === void 0 || this.conditionalEnd() || this.isConditionalGroupEnd(first)) {
      if (first === void 0) {
        throw incompleteShellSyntaxError("[[ expression is missing at end of script");
      }
      throw this.tokenError("[[ expression is missing", first);
    }
    if (first.type !== "word") throw this.tokenError("[[ expected an operand", first);
    const left = this.takeWord();
    const staticLeft = staticWord(left);
    const unary = conditionalUnaryOperator(staticLeft);
    if (unary !== void 0) {
      const operand = this.conditionalOperand(`operand for ${unary}`);
      this.add();
      return { type: "conditional-unary", operator: unary, operand };
    }
    if (staticLeft !== void 0 && UNSUPPORTED_CONDITIONAL_UNARY.has(staticLeft)) {
      throw new VfsError(
        "EINVAL",
        `unsupported [[ unary operator ${staticLeft} at byte ${left.sourceOffset}`
      );
    }
    return this.conditionalBinaryOrWord(left);
  }
  conditionalBinaryOrWord(left) {
    const operatorToken = this.peek();
    const operator = conditionalBinaryOperator(operatorToken);
    if (operator !== void 0) {
      this.take();
      const right = this.conditionalOperand(`right operand for ${operator}`);
      this.add();
      return { type: "conditional-binary", operator, left, right };
    }
    if (operatorToken !== void 0 && !this.isConditionalTerminator(operatorToken)) {
      throw this.tokenError(
        `unsupported [[ operator ${this.conditionalTokenValue(operatorToken)}`,
        operatorToken
      );
    }
    this.add();
    return { type: "conditional-word", word: left };
  }
  isConditionalGroupEnd(token) {
    return token.type === "operator" && token.value === ")";
  }
  isConditionalTerminator(token) {
    if (token.type === "word") return staticWord(token.word) === "]]";
    return token.type === "operator" && ["&&", "||", ")"].includes(token.value);
  }
};

// src/shell/parser-lexer-base.ts
var ShellLexerBase = class {
  constructor(source, context, baseByteOffset, depth, parseNested) {
    this.source = source;
    this.context = context;
    this.baseByteOffset = baseByteOffset;
    this.depth = depth;
    this.parseNested = parseNested;
    this.byteOffsets = utf8ByteOffsets(source, () => context.checkDeadline());
  }
  source;
  context;
  baseByteOffset;
  depth;
  parseNested;
  byteOffsets;
  offset = 0;
  tokens = [];
  pendingHereDocuments = [];
  expectedHereDocument;
  lex() {
    while (this.offset < this.source.length) this.readToken();
    if (this.expectedHereDocument !== void 0) {
      throw this.error("here-document redirection requires a delimiter", this.source.length);
    }
    if (this.pendingHereDocuments.length > 0) this.readPendingHereDocuments();
    return this.tokens;
  }
  skipComment() {
    while (this.offset < this.source.length && this.source[this.offset] !== "\n") {
      this.checkOffset(this.offset);
      this.offset += 1;
    }
  }
  readOperatorToken() {
    const operator = operatorAt(this.source, this.offset, true);
    if (operator === null) return false;
    const token = {
      type: "operator",
      value: operator,
      offset: this.absoluteOffset(this.offset)
    };
    this.tokens.push(token);
    this.offset += operator.length;
    if (HEREDOC_REDIRECTIONS.has(operator)) this.expectedHereDocument = token;
    if (operator === "\n") this.readPendingHereDocuments();
    return true;
  }
  readToken() {
    this.checkOffset(this.offset);
    const character = this.source[this.offset];
    if (character === void 0) return;
    if (isHorizontalWhitespace(character)) {
      this.offset += 1;
      return;
    }
    if (character === "#") {
      this.skipComment();
      return;
    }
    if (this.source.startsWith("((", this.offset)) {
      this.tokens.push(this.readArithmeticCommand());
      return;
    }
    if (this.source.startsWith("1>&2", this.offset) && isBoundary(this.source[this.offset + 4])) {
      this.offset += 1;
      return;
    }
    if (this.source.startsWith("2>&", this.offset) && operatorAt(this.source, this.offset, true) === null) {
      throw this.error(
        "arbitrary file descriptors are not supported by this language version",
        this.offset
      );
    }
    if (!this.readOperatorToken()) this.readWordToken();
  }
  readWordToken() {
    const word = this.readWord(this.expectedHereDocument !== void 0);
    this.tokens.push({ type: "word", word });
    if (this.expectedHereDocument === void 0) return;
    const delimiter = literalWordValue(word);
    this.pendingHereDocuments.push({
      token: this.expectedHereDocument,
      delimiter: delimiter.value,
      quoted: delimiter.quoted,
      stripTabs: this.expectedHereDocument.value === "<<-"
    });
    this.expectedHereDocument = void 0;
  }
  standaloneWord(inheritedQuoted) {
    return this.readWord(false, false, inheritedQuoted);
  }
  standaloneHereDocumentWord() {
    return this.readWord(false, false, true, true);
  }
  absoluteOffset(offset) {
    return this.baseByteOffset + utf8ByteOffset(this.source, this.byteOffsets, offset);
  }
  checkOffset(offset) {
    if ((offset & 4095) === 0) this.context.checkDeadline();
  }
  error(message, offset) {
    return new VfsError("EINVAL", `${message} at byte ${this.absoluteOffset(offset)}`);
  }
  incompleteError(message, offset) {
    return incompleteShellSyntaxError(`${message} at byte ${this.absoluteOffset(offset)}`);
  }
  parseArithmetic(source, sourceOffset) {
    try {
      return parseArithmetic(source, this.context.remainingNodes(), this.context.maximumDepth);
    } catch (error) {
      if (!(error instanceof ArithmeticSyntaxError)) throw error;
      throw new VfsError(
        "EINVAL",
        `${error.detail} in arithmetic expression at byte ${this.absoluteOffset(sourceOffset) + error.byteOffset}`
      );
    }
  }
  append(parts, part) {
    const previous = parts.at(-1);
    if (part.kind === "literal" && previous?.kind === "literal" && previous.quoted === part.quoted) {
      previous.value += part.value;
    } else parts.push(part);
  }
};

// src/shell/parser-lexer-word.ts
var DEFAULT_OPERATORS = [":-", ":=", ":+", ":?", "-", "=", "+", "?"];
var REMOVAL_OPERATORS = ["##", "%%", "#", "%"];
var ShellWordLexer = class extends ShellLexerBase {
  wordEnded(stopAtWhitespace, parts) {
    const character = this.source[this.offset];
    if (character === void 0) return true;
    if (!stopAtWhitespace) return false;
    if (isHorizontalWhitespace(character) || character === "\n") return true;
    return operatorAt(this.source, this.offset, parts.length === 0) !== null;
  }
  readSingleQuoted(parts) {
    const quote = this.offset++;
    let value = "";
    while (this.offset < this.source.length && this.source[this.offset] !== "'") {
      this.checkOffset(this.offset);
      value += this.source[this.offset++] ?? "";
    }
    if (this.source[this.offset] !== "'") {
      throw this.incompleteError("unterminated single quote", quote);
    }
    this.offset += 1;
    this.append(parts, { kind: "literal", value, quoted: true });
  }
  readEscaped(parts, literalQuotes) {
    const next = this.source[this.offset + 1];
    if (next === void 0) throw this.incompleteError("unterminated escape", this.offset);
    this.offset += 2;
    if (next === "\n") return;
    const value = literalQuotes && next !== "$" && next !== "\\" && next !== "`" ? `\\${next}` : next;
    this.append(parts, { kind: "literal", value, quoted: true });
  }
  readDollar(parts, inheritedQuoted) {
    const next = this.source[this.offset + 1];
    if (next === "'" || next === '"') {
      throw this.error(
        "locale and ANSI-C quotes are not supported by this language version",
        this.offset
      );
    }
    const expansion = this.readExpansion(inheritedQuoted);
    if (expansion === void 0) return false;
    this.append(parts, expansion);
    return true;
  }
  readSpecialPart(parts, character, delimiterMode, inheritedQuoted, literalQuotes) {
    if (literalQuotes && (character === "'" || character === '"')) {
      this.append(parts, { kind: "literal", value: character, quoted: true });
      this.offset += 1;
    } else if (character === "'") this.readSingleQuoted(parts);
    else if (character === '"') this.readDoubleQuoted(parts, delimiterMode);
    else if (character === "\\") this.readEscaped(parts, literalQuotes);
    else if (character === "`" && !delimiterMode) {
      this.append(parts, {
        kind: "command",
        script: this.readBacktickSubstitution(),
        quoted: inheritedQuoted
      });
    } else if (character === "$" && !delimiterMode) return this.readDollar(parts, inheritedQuoted);
    else return false;
    return true;
  }
  rejectAdjacentDescriptor(parts, start) {
    const unquoted = parts.every((part) => part.kind === "literal" && !part.quoted) ? parts.map((part) => part.kind === "literal" ? part.value : "").join("") : void 0;
    const adjacent = operatorAt(this.source, this.offset, false);
    if (unquoted !== void 0 && /^[0-9]+$/u.test(unquoted) && (adjacent === "<" || adjacent === ">" || adjacent === ">>")) {
      throw this.error(
        "arbitrary file descriptors are not supported by this language version",
        start
      );
    }
  }
  readWord(delimiterMode, stopAtWhitespace = true, inheritedQuoted = false, literalQuotes = false) {
    const start = this.offset;
    const parts = [];
    while (!this.wordEnded(stopAtWhitespace, parts)) {
      this.checkOffset(this.offset);
      const character = this.source[this.offset] ?? "";
      if (this.readSpecialPart(parts, character, delimiterMode, inheritedQuoted, literalQuotes))
        continue;
      this.append(parts, { kind: "literal", value: character, quoted: inheritedQuoted });
      this.offset += 1;
    }
    if (parts.length === 0) throw this.error("expected word", start);
    this.rejectAdjacentDescriptor(parts, start);
    const name = assignmentName(parts);
    return {
      parts,
      sourceOffset: this.absoluteOffset(start),
      ...name === void 0 ? {} : { assignmentName: name }
    };
  }
  readDoubleQuotedEscape(parts) {
    const next = this.source[this.offset + 1];
    if (next === void 0) throw this.incompleteError("unterminated escape", this.offset);
    this.offset += 2;
    if (next === "$" || next === '"' || next === "\\" || next === "\n") {
      if (next !== "\n") this.append(parts, { kind: "literal", value: next, quoted: true });
    } else this.append(parts, { kind: "literal", value: `\\${next}`, quoted: true });
  }
  readDoubleQuotedSpecial(parts, character, delimiterMode) {
    if (character === "\\") this.readDoubleQuotedEscape(parts);
    else if (character === "`" && !delimiterMode) {
      this.append(parts, {
        kind: "command",
        script: this.readBacktickSubstitution(),
        quoted: true
      });
    } else if (character === "$" && !delimiterMode) {
      const expansion = this.readExpansion(true);
      if (expansion === void 0) return false;
      this.append(parts, expansion);
    } else return false;
    return true;
  }
  readDoubleQuoted(parts, delimiterMode) {
    const start = this.offset++;
    const before = parts.length;
    while (this.offset < this.source.length && this.source[this.offset] !== '"') {
      this.checkOffset(this.offset);
      const character = this.source[this.offset];
      if (this.readDoubleQuotedSpecial(parts, character, delimiterMode)) continue;
      this.append(parts, { kind: "literal", value: character ?? "", quoted: true });
      this.offset += 1;
    }
    if (this.source[this.offset] !== '"') {
      throw this.incompleteError("unterminated double quote", start);
    }
    this.offset += 1;
    if (parts.length === before) this.append(parts, { kind: "literal", value: "", quoted: true });
  }
  readParenthesizedExpansion(quoted) {
    if (this.source[this.offset + 2] === "(") {
      return { kind: "arithmetic", expression: this.readArithmeticExpansion(), quoted };
    }
    return { kind: "command", script: this.readCommandSubstitution(), quoted };
  }
  readSimpleParameter(next, quoted) {
    this.offset += 2;
    let name = next;
    if (/[A-Za-z_]/u.test(next)) {
      const suffix = /^[A-Za-z0-9_]*/u.exec(this.source.slice(this.offset))?.[0] ?? "";
      name += suffix;
      this.offset += suffix.length;
    }
    return { kind: "parameter", expansion: { name, length: false }, quoted };
  }
  readExpansion(quoted) {
    const start = this.offset;
    const next = this.source[this.offset + 1];
    if (next === "(") return this.readParenthesizedExpansion(quoted);
    if (next === "{") {
      const expansion = this.readBracedParameter();
      return { kind: "parameter", expansion, quoted };
    }
    if (next !== void 0 && /[A-Za-z_?#@*0-9-]/u.test(next))
      return this.readSimpleParameter(next, quoted);
    if (next === "$") {
      throw this.error("special parameter is not supported by this language version", start);
    }
    return void 0;
  }
  readIndirectParameter(start) {
    this.offset += 1;
    const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(this.source.slice(this.offset))?.[0];
    if (name === void 0) throw this.error("invalid indirect parameter expansion", start);
    this.offset += name.length;
    if (this.source[this.offset] !== "}") {
      throw this.error("unsupported indirect parameter expansion", this.offset);
    }
    this.offset += 1;
    return { kind: "indirect", name, length: false };
  }
  readDefaultParameter(name, operator) {
    this.offset += operator.length;
    const operandStart = this.offset;
    const close = this.findParameterClose();
    const word = this.expansionWord(
      this.source.slice(operandStart, close),
      this.absoluteOffset(operandStart),
      this.depth + 1
    );
    this.offset = close + 1;
    return { name, length: false, operator, word };
  }
  readRemovalParameter(name, removalOperator) {
    this.offset += removalOperator.length;
    const patternStart = this.offset;
    const close = this.findParameterClose();
    const pattern = this.expansionWord(
      this.source.slice(patternStart, close),
      this.absoluteOffset(patternStart),
      this.depth + 1
    );
    this.offset = close + 1;
    return { kind: "remove", name, length: false, removalOperator, pattern };
  }
  readReplacementParameter(name) {
    const all = this.source[this.offset + 1] === "/";
    this.offset += all ? 2 : 1;
    const patternStart = this.offset;
    const close = this.findParameterClose();
    const contents = this.source.slice(patternStart, close);
    const separator = topLevelDelimiters(contents, "/", () => this.context.checkDeadline())[0];
    const patternSource = separator === void 0 ? contents : contents.slice(0, separator);
    const replacementSource = separator === void 0 ? "" : contents.slice(separator + 1);
    if (patternSource.startsWith("#") || patternSource.startsWith("%")) {
      throw this.error("anchored parameter replacement is not supported", patternStart);
    }
    const pattern = this.expansionWord(
      patternSource,
      this.absoluteOffset(patternStart),
      this.depth + 1
    );
    const replacementStart = patternStart + (separator ?? contents.length) + (separator === void 0 ? 0 : 1);
    const replacement = this.expansionWord(
      replacementSource,
      this.absoluteOffset(replacementStart),
      this.depth + 1
    );
    this.offset = close + 1;
    return { kind: "replace", name, length: false, all, pattern, replacement };
  }
  readSubstringParameter(name) {
    this.offset += 1;
    const offsetStart = this.offset;
    const close = this.findParameterClose();
    const contents = this.source.slice(offsetStart, close);
    const separators = topLevelDelimiters(contents, ":", () => this.context.checkDeadline());
    if (separators.length > 1) {
      throw this.error("substring expansion accepts at most one length", offsetStart);
    }
    const separator = separators[0];
    const offsetSource = separator === void 0 ? contents : contents.slice(0, separator);
    const lengthSource = separator === void 0 ? void 0 : contents.slice(separator + 1);
    if (offsetSource.trim().length === 0 || lengthSource?.trim().length === 0) {
      throw this.error("substring offset and length must not be empty", offsetStart);
    }
    const offset = this.expansionWord(
      offsetSource,
      this.absoluteOffset(offsetStart),
      this.depth + 1
    );
    const lengthStart = offsetStart + (separator ?? contents.length) + 1;
    const substringLength = lengthSource === void 0 ? void 0 : this.expansionWord(lengthSource, this.absoluteOffset(lengthStart), this.depth + 1);
    this.offset = close + 1;
    return {
      kind: "substring",
      name,
      length: false,
      offset,
      ...substringLength === void 0 ? {} : { substringLength }
    };
  }
  readBracedParameter() {
    const start = this.offset;
    this.offset += 2;
    if (this.source[this.offset] === "!") return this.readIndirectParameter(start);
    let length = false;
    if (this.source[this.offset] === "#") {
      length = true;
      this.offset += 1;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[?#@*-]|[0-9]+)/u.exec(
      this.source.slice(this.offset)
    )?.[0];
    if (name === void 0) throw this.error("invalid parameter expansion", start);
    this.offset += name.length;
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return { name, length };
    }
    if (length) throw this.error("parameter length expansion does not accept an operator", start);
    const operator = DEFAULT_OPERATORS.find(
      (candidate) => this.source.startsWith(candidate, this.offset)
    );
    if (operator !== void 0) return this.readDefaultParameter(name, operator);
    if (name === "@") {
      throw this.error("array-style parameter operations are not supported", start);
    }
    const removal = REMOVAL_OPERATORS.find(
      (candidate) => this.source.startsWith(candidate, this.offset)
    );
    if (removal !== void 0) return this.readRemovalParameter(name, removal);
    if (this.source[this.offset] === "/") return this.readReplacementParameter(name);
    if (this.source[this.offset] === ":") return this.readSubstringParameter(name);
    throw this.error("unsupported parameter expansion operator", this.offset);
  }
  findParameterClose() {
    const close = topLevelDelimiters(
      this.source,
      "}",
      () => this.context.checkDeadline(),
      this.offset
    )[0];
    if (close !== void 0) return close;
    throw this.incompleteError("unterminated parameter expansion", this.offset);
  }
};

// src/shell/parser-lexer.ts
var CommandSubstitutionScanner = class {
  constructor(source) {
    this.source = source;
  }
  source;
  depth = 1;
  quote;
  advance(index) {
    const character = this.source[index];
    if (character === "\\" && this.quote !== "'") return { step: 2, candidate: false };
    if (this.quote !== void 0) {
      if (character === this.quote) this.quote = void 0;
      return { step: 1, candidate: false };
    }
    if (character === "'" || character === '"') {
      this.quote = character;
      return { step: 1, candidate: false };
    }
    if (character === "(") this.depth += 1;
    else if (character === ")" && this.depth > 1) this.depth -= 1;
    else return { step: 1, candidate: character === ")" };
    return { step: 1, candidate: false };
  }
};
var Lexer = class extends ShellWordLexer {
  /**
   * Reads a backtick command substitution, the older spelling of `$(...)`.
   *
   * The closing backtick is found by scanning, not by parsing: quotes do not
   * protect one, and a backslash escapes only `` ` ``, `\`, and `$`. That is
   * why the form nests only through escaping, and why `$(...)` is the spelling
   * to reach for — but it is what a generated script tends to contain, so it
   * runs rather than being refused.
   *
   * Removing those backslashes shifts the offsets the inner parse reports. The
   * shift is the number of escapes removed before the point in question, and is
   * zero for a substitution that contains none.
   */
  readBacktickSubstitution() {
    const start = this.offset;
    let index = start + 1;
    let content = "";
    for (; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "`") break;
      if (character === "\\") {
        const next = this.source[index + 1];
        if (next === "`" || next === "\\" || next === "$") {
          content += next;
          index += 1;
          continue;
        }
      }
      content += character ?? "";
    }
    if (this.source[index] !== "`") {
      throw this.incompleteError("unterminated backtick command substitution", start);
    }
    const probe = new ParseContext(
      this.context.remainingNodes(),
      this.context.maximumDepth,
      () => void 0,
      () => this.context.checkDeadline()
    );
    const script = this.parseNested(content, probe, this.absoluteOffset(start + 1), this.depth + 1);
    this.context.add(probe.nodes);
    this.offset = index + 1;
    return script;
  }
  readCommandSubstitution() {
    const start = this.offset;
    const contentStart = this.offset + 2;
    let lastSyntaxError;
    const attempted = /* @__PURE__ */ new Set();
    const accept = (close) => {
      attempted.add(close);
      const probe = new ParseContext(
        this.context.remainingNodes(),
        this.context.maximumDepth,
        () => void 0,
        () => this.context.checkDeadline()
      );
      try {
        const script = this.parseNested(
          this.source.slice(contentStart, close),
          probe,
          this.absoluteOffset(contentStart),
          this.depth + 1
        );
        this.context.add(probe.nodes);
        this.offset = close + 1;
        return script;
      } catch (error) {
        if (!(error instanceof VfsError) || error.code !== "EINVAL") throw error;
        lastSyntaxError = isIncompleteShellSyntaxError(error) ? new VfsError(error.code, error.message, error.path) : error;
        return void 0;
      }
    };
    const scanner = new CommandSubstitutionScanner(this.source);
    for (let index = contentStart; index < this.source.length; ) {
      this.checkOffset(index);
      const scanned = scanner.advance(index);
      if (scanned.candidate) {
        const script = accept(index);
        if (script !== void 0) return script;
      }
      index += scanned.step;
    }
    for (let index = contentStart; index < this.source.length; index += 1) {
      this.checkOffset(index);
      if (this.source[index] !== ")" || attempted.has(index)) continue;
      const script = accept(index);
      if (script !== void 0) return script;
    }
    if (lastSyntaxError !== void 0) throw lastSyntaxError;
    throw this.incompleteError("unterminated command substitution", start);
  }
  readArithmeticBody(kind, contentStart) {
    const start = this.offset;
    let parentheses = 0;
    let index = contentStart;
    for (; index < this.source.length; index += 1) {
      this.checkOffset(index);
      const character = this.source[index];
      if (character === "(") parentheses += 1;
      else if (character === ")") {
        if (parentheses === 0 && this.source[index + 1] === ")") break;
        parentheses -= 1;
        if (parentheses < 0) throw this.error(`invalid arithmetic ${kind}`, start);
      }
    }
    if (index >= this.source.length) {
      throw this.incompleteError(`unterminated arithmetic ${kind}`, start);
    }
    const parsed = this.parseArithmetic(this.source.slice(contentStart, index), contentStart);
    this.context.add(parsed.nodeCount);
    this.offset = index + 2;
    return parsed.node;
  }
  readArithmeticExpansion() {
    return this.readArithmeticBody("expansion", this.offset + 3);
  }
  readArithmeticCommand() {
    const start = this.offset;
    return {
      type: "arithmetic-command",
      expression: this.readArithmeticBody("command", this.offset + 2),
      offset: this.absoluteOffset(start)
    };
  }
  expansionWord(source, baseByteOffset, depth) {
    return parseExpansionWord(source, this.context, baseByteOffset, depth, this.parseNested);
  }
  readHereDocumentBody(item) {
    const lines = [];
    while (this.offset <= this.source.length) {
      this.checkOffset(this.offset);
      const lineStart = this.offset;
      const newline = this.source.indexOf("\n", lineStart);
      const lineEnd = newline < 0 ? this.source.length : newline;
      const rawLine = this.source.slice(lineStart, lineEnd);
      const bodyLine = item.stripTabs ? rawLine.replace(/^\t+/u, "") : rawLine;
      this.offset = newline < 0 ? this.source.length : newline + 1;
      if (bodyLine === item.delimiter) return lines.join("");
      lines.push(`${bodyLine}${newline < 0 ? "" : "\n"}`);
      if (newline < 0) break;
    }
    throw this.incompleteError(
      `unterminated here-document (wanted ${item.delimiter})`,
      this.offset
    );
  }
  hereDocumentWord(item, body) {
    if (item.quoted) {
      return {
        parts: [{ kind: "literal", value: body, quoted: true }],
        sourceOffset: item.token.offset
      };
    }
    return parseHereDocumentWord(
      body,
      this.context,
      item.token.offset,
      this.depth + 1,
      this.parseNested
    );
  }
  readPendingHereDocuments() {
    if (this.pendingHereDocuments.length === 0) return;
    for (const item of this.pendingHereDocuments.splice(0)) {
      item.token.document = this.hereDocumentWord(item, this.readHereDocumentBody(item));
    }
  }
};
function parseExpansionWord(source, context, baseByteOffset, depth, parseNested) {
  context.depth(depth);
  if (source.length === 0)
    return { parts: [{ kind: "literal", value: "", quoted: false }], sourceOffset: baseByteOffset };
  const lexer = new Lexer(source, context, baseByteOffset, depth, parseNested);
  return lexer.standaloneWord(false);
}
function parseHereDocumentWord(source, context, baseByteOffset, depth, parseNested) {
  context.depth(depth);
  if (source.length === 0)
    return { parts: [{ kind: "literal", value: "", quoted: true }], sourceOffset: baseByteOffset };
  const lexer = new Lexer(source, context, baseByteOffset, depth, parseNested);
  return lexer.standaloneHereDocumentWord();
}

// src/shell/parser-validation.ts
function assertDepth(maximumDepth, depth) {
  if (depth > maximumDepth) throw new VfsError("E2BIG", "shell nesting depth limit exceeded");
}
function validateExpansionDepth(expansion, maximumDepth, depth) {
  if (!("kind" in expansion)) {
    if (expansion.word !== void 0) validateWordDepth(expansion.word, maximumDepth, depth);
    return;
  }
  if (expansion.kind === "remove") {
    validateWordDepth(expansion.pattern, maximumDepth, depth);
    return;
  }
  if (expansion.kind === "replace") {
    validateWordDepth(expansion.pattern, maximumDepth, depth);
    validateWordDepth(expansion.replacement, maximumDepth, depth);
    return;
  }
  if (expansion.kind === "substring") {
    validateWordDepth(expansion.offset, maximumDepth, depth);
    if (expansion.substringLength !== void 0) {
      validateWordDepth(expansion.substringLength, maximumDepth, depth);
    }
  }
}
function validateWordDepth(word, maximumDepth, depth) {
  assertDepth(maximumDepth, depth);
  for (const part of word.parts) {
    if (part.kind === "command") validateScriptDepth(part.script, maximumDepth, depth + 1);
    if (part.kind === "parameter") {
      validateExpansionDepth(part.expansion, maximumDepth, depth + 1);
    }
  }
}
function validateRedirections(redirections2, maximumDepth, depth) {
  for (const redirection of redirections2) {
    if ("target" in redirection) validateWordDepth(redirection.target, maximumDepth, depth);
    if ("document" in redirection) validateWordDepth(redirection.document, maximumDepth, depth);
  }
}
function validateConditionalDepth(expression, maximumDepth, depth) {
  const pending = [
    { expression, depth }
  ];
  for (let current = pending.pop(); current !== void 0; current = pending.pop()) {
    assertDepth(maximumDepth, current.depth);
    const item = current.expression;
    if (item.type === "conditional-word") {
      validateWordDepth(item.word, maximumDepth, current.depth);
    } else if (item.type === "conditional-unary") {
      validateWordDepth(item.operand, maximumDepth, current.depth);
    } else if (item.type === "conditional-binary") {
      validateWordDepth(item.left, maximumDepth, current.depth);
      validateWordDepth(item.right, maximumDepth, current.depth);
    } else if (item.type === "conditional-not" || item.type === "conditional-group") {
      pending.push({ expression: item.expression, depth: current.depth + 1 });
    } else {
      pending.push(
        { expression: item.right, depth: current.depth },
        { expression: item.left, depth: current.depth }
      );
    }
  }
}
function validateIfDepth(node, maximumDepth, depth) {
  for (const branch2 of node.branches) {
    validateScriptDepth(branch2.condition, maximumDepth, depth + 1);
    validateScriptDepth(branch2.body, maximumDepth, depth + 1);
  }
  if (node.alternate !== void 0) validateScriptDepth(node.alternate, maximumDepth, depth + 1);
}
function validateLoopDepth(node, maximumDepth, depth) {
  validateScriptDepth(node.condition, maximumDepth, depth + 1);
  validateScriptDepth(node.body, maximumDepth, depth + 1);
}
function validateForDepth(node, maximumDepth, depth) {
  for (const word of node.words ?? []) validateWordDepth(word, maximumDepth, depth);
  validateScriptDepth(node.body, maximumDepth, depth + 1);
}
function validateCaseDepth(node, maximumDepth, depth) {
  validateWordDepth(node.word, maximumDepth, depth);
  for (const clause of node.clauses) {
    for (const pattern of clause.patterns) validateWordDepth(pattern, maximumDepth, depth);
    validateScriptDepth(clause.body, maximumDepth, depth + 1);
  }
}
function validateCompoundDepth(node, maximumDepth, depth) {
  if (node.type === "group") validateScriptDepth(node.body, maximumDepth, depth + 1);
  if (node.type === "if") validateIfDepth(node, maximumDepth, depth);
  if (node.type === "loop") validateLoopDepth(node, maximumDepth, depth);
  if (node.type === "for") validateForDepth(node, maximumDepth, depth);
  if (node.type === "case") validateCaseDepth(node, maximumDepth, depth);
  if (node.type === "double-bracket") {
    validateConditionalDepth(node.expression, maximumDepth, depth + 1);
  }
}
function validateCommandDepth(node, maximumDepth, depth) {
  assertDepth(maximumDepth, depth);
  if (node.type === "command") {
    for (const word of node.words) validateWordDepth(word, maximumDepth, depth);
    validateRedirections(node.redirections, maximumDepth, depth);
    return;
  }
  if (node.type === "function-definition") {
    validateCommandDepth(node.body, maximumDepth, depth + 1);
    return;
  }
  validateRedirections(node.redirections, maximumDepth, depth);
  validateCompoundDepth(node, maximumDepth, depth);
}
function validateScriptDepth(script, maximumDepth, depth) {
  assertDepth(maximumDepth, depth);
  for (const list of script.lists) {
    for (const pipeline of [list.first, ...list.rest.map((item) => item.pipeline)]) {
      for (const command of pipeline.commands) validateCommandDepth(command, maximumDepth, depth);
    }
  }
}

// src/shell/parser.ts
var Parser = class extends ConditionalParser {
  andOr() {
    this.add();
    const first = this.pipeline();
    const rest = [];
    while (true) {
      const token = this.peek();
      if (token?.type !== "operator" || token.value !== "&&" && token.value !== "||") break;
      this.take();
      this.skipNewlines();
      rest.push({ operator: token.value, pipeline: this.pipeline() });
    }
    return { type: "and-or", first, rest };
  }
  pipeline() {
    this.add();
    let negated = false;
    if (this.peekOperator() === "!") {
      this.take();
      negated = true;
    }
    const commands = [this.command()];
    while (this.peekOperator() === "|") {
      this.take();
      this.skipNewlines();
      commands.push(this.command());
    }
    return { type: "pipeline", negated, commands };
  }
  command() {
    const token = this.peek();
    if (token === void 0) throw incompleteShellSyntaxError("expected command at end of script");
    if (token.type === "operator") return this.operatorCommand(token);
    if (token.type === "arithmetic-command") return this.arithmeticCommand();
    return this.wordCommand(staticWord(token.word));
  }
  operatorCommand(token) {
    if (token.value === "{") return this.group(false);
    if (token.value === "(") return this.group(true);
    if (token.value === "&") throw this.tokenError("background jobs are not supported", token);
    if (REDIRECTIONS.has(token.value)) return this.simpleCommand();
    throw this.tokenError("expected command", token);
  }
  wordCommand(value) {
    if (value === "[[") return this.doubleBracketCommand();
    if (value === "if") return this.ifCommand();
    if (value === "while" || value === "until") return this.loopCommand(value === "until");
    if (value === "for") return this.forCommand();
    if (value === "case") return this.caseCommand();
    if (value !== void 0 && this.isFunctionStart(value)) return this.functionDefinition(value);
    return this.simpleCommand();
  }
  isFunctionStart(value) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) && this.peekOperator(1) === "(" && this.peekOperator(2) === ")";
  }
  group(subshell) {
    return this.withDepth(() => {
      const open = this.take();
      const sourceOffset = open.type === "operator" ? open.offset : 0;
      const close = subshell ? ")" : "}";
      const body = this.requiredList(
        { operators: /* @__PURE__ */ new Set([close]) },
        subshell ? "subshell" : "brace group",
        !subshell
      );
      if (this.peek() === void 0) {
        throw incompleteShellSyntaxError(`expected ${close} at byte ${sourceOffset}`);
      }
      this.expectOperator(close);
      const redirections2 = this.redirections();
      this.add();
      return { type: "group", body, subshell, redirections: redirections2, sourceOffset };
    });
  }
  ifCommand() {
    return this.withDepth(() => this.parseIfCommand());
  }
  parseIfCommand() {
    const sourceOffset = this.takeWordOffset();
    const branches = [];
    let condition = this.requiredList({ words: /* @__PURE__ */ new Set(["then"]) }, "if condition", true);
    this.expectWord("then");
    while (true) {
      const body = this.requiredList({ words: /* @__PURE__ */ new Set(["elif", "else", "fi"]) }, "if branch", true);
      branches.push({ condition, body });
      const keyword = this.ifTerminator();
      if (keyword !== "elif") return this.finishIf(sourceOffset, branches, keyword);
      this.take();
      condition = this.requiredList({ words: /* @__PURE__ */ new Set(["then"]) }, "elif condition", true);
      this.expectWord("then");
    }
  }
  ifTerminator() {
    const next = this.peek();
    if (next?.type === "word") return staticWord(next.word);
    if (next === void 0) throw incompleteShellSyntaxError("expected fi at end of script");
    throw this.tokenError("expected elif, else, or fi", next);
  }
  finishIf(sourceOffset, branches, keyword) {
    let alternate;
    if (keyword === "else") {
      this.take();
      alternate = this.requiredList({ words: /* @__PURE__ */ new Set(["fi"]) }, "else branch", true);
    }
    this.expectWord("fi");
    const redirections2 = this.redirections();
    this.add();
    return {
      type: "if",
      branches,
      ...alternate === void 0 ? {} : { alternate },
      redirections: redirections2,
      sourceOffset
    };
  }
  loopCommand(until) {
    return this.withDepth(() => {
      const sourceOffset = this.takeWordOffset();
      const condition = this.requiredList(
        { words: /* @__PURE__ */ new Set(["do"]) },
        until ? "until condition" : "while condition",
        true
      );
      this.expectWord("do");
      const body = this.requiredList(
        { words: /* @__PURE__ */ new Set(["done"]) },
        until ? "until body" : "while body",
        true
      );
      this.expectWord("done");
      const redirections2 = this.redirections();
      this.add();
      return { type: "loop", condition, body, until, redirections: redirections2, sourceOffset };
    });
  }
  forCommand() {
    return this.withDepth(() => this.parseForCommand());
  }
  parseForCommand() {
    const sourceOffset = this.takeWordOffset();
    const nameToken = this.take();
    const name = nameToken.type === "word" ? staticWord(nameToken.word) : void 0;
    if (name === void 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw this.tokenError("for requires a variable name", nameToken);
    }
    let words;
    if (this.peek()?.type === "word" && staticWord(this.peekWord()) === "in") {
      this.take();
      words = [];
      while (this.peek()?.type === "word") words.push(this.takeWord());
    }
    if (!this.isSeparator(this.peek())) {
      const token = this.peek();
      if (token === void 0) {
        throw incompleteShellSyntaxError("for requires do at end of script");
      }
      throw this.tokenError("for word list requires a separator", token);
    }
    this.skipSeparators();
    this.expectWord("do");
    const body = this.requiredList({ words: /* @__PURE__ */ new Set(["done"]) }, "for body", true);
    this.expectWord("done");
    const redirections2 = this.redirections();
    this.add();
    return {
      type: "for",
      name,
      ...words === void 0 ? {} : { words },
      body,
      redirections: redirections2,
      sourceOffset
    };
  }
  caseCommand() {
    return this.withDepth(() => this.parseCaseCommand());
  }
  parseCaseCommand() {
    const sourceOffset = this.takeWordOffset();
    const word = this.takeWord();
    this.skipNewlines();
    this.expectWord("in");
    this.skipSeparators();
    const clauses = [];
    while (this.peek()?.type !== "word" || staticWord(this.peekWord()) !== "esac") {
      if (this.peekOperator() === "(") this.take();
      const patterns = [this.takeWord()];
      while (this.peekOperator() === "|") {
        this.take();
        patterns.push(this.takeWord());
      }
      this.expectOperator(")");
      const body = this.parse({ words: /* @__PURE__ */ new Set(["esac"]), operators: /* @__PURE__ */ new Set([";;"]) });
      clauses.push({ patterns, body });
      if (this.peekOperator() === ";;") {
        this.take();
        this.skipSeparators();
      } else if (this.peek()?.type !== "word" || staticWord(this.peekWord()) !== "esac") {
        const token = this.peek();
        if (token === void 0) {
          throw incompleteShellSyntaxError("expected esac at end of script");
        }
        throw this.tokenError("case clause requires ;; or esac", token);
      }
    }
    this.expectWord("esac");
    const redirections2 = this.redirections();
    this.add();
    return { type: "case", word, clauses, redirections: redirections2, sourceOffset };
  }
  arithmeticCommand() {
    const token = this.take();
    if (token.type !== "arithmetic-command")
      throw this.tokenError("expected arithmetic command", token);
    const redirections2 = this.redirections();
    this.add();
    return {
      type: "arithmetic-command",
      expression: token.expression,
      redirections: redirections2,
      sourceOffset: token.offset
    };
  }
  functionDefinition(name) {
    return this.withDepth(() => this.parseFunctionDefinition(name));
  }
  parseFunctionDefinition(name) {
    const token = this.take();
    const sourceOffset = token.type === "word" ? token.word.sourceOffset : 0;
    this.expectOperator("(");
    this.expectOperator(")");
    this.skipNewlines();
    const body = this.command();
    if (body.type === "command" || body.type === "function-definition") {
      throw new VfsError(
        "EINVAL",
        `function body must be a compound command at byte ${sourceOffset}`
      );
    }
    this.add();
    return { type: "function-definition", name, body, sourceOffset };
  }
  simpleCommand() {
    this.add();
    const first = this.peek();
    const sourceOffset = this.tokenOffset(first);
    const words = [];
    const redirections2 = [];
    this.collectSimpleCommand(words, redirections2);
    this.assertCommandParts(first, words, redirections2);
    this.validateCommandWord(words, sourceOffset);
    return { type: "command", words, redirections: redirections2, sourceOffset };
  }
  collectSimpleCommand(words, redirections2) {
    while (true) {
      const token = this.peek();
      if (token?.type === "word") {
        words.push(token.word);
        this.take();
        continue;
      }
      if (token?.type === "operator" && REDIRECTIONS.has(token.value)) {
        redirections2.push(this.redirection());
        continue;
      }
      return;
    }
  }
  assertCommandParts(first, words, redirections2) {
    if (words.length === 0 && redirections2.length === 0) {
      if (first === void 0)
        throw incompleteShellSyntaxError("expected command at end of script");
      throw this.tokenError("expected command", first);
    }
  }
  validateCommandWord(words, sourceOffset) {
    const commandWord = words.find((word) => word.assignmentName === void 0);
    const rawCommand = staticWord(commandWord);
    if (rawCommand !== void 0 && UNSUPPORTED_RESERVED.has(rawCommand)) {
      throw new VfsError(
        "EINVAL",
        `reserved syntax ${rawCommand} is not supported at byte ${commandWord?.sourceOffset ?? sourceOffset}`
      );
    }
    if (rawCommand === "[[" || rawCommand === "]]" || /\[[^\]]*\]=/u.test(rawCommand ?? "")) {
      throw new VfsError(
        "EINVAL",
        `array and extended-test syntax is not supported at byte ${commandWord?.sourceOffset ?? sourceOffset}`
      );
    }
  }
  tokenOffset(token) {
    if (token === void 0) return 0;
    return token.type === "word" ? token.word.sourceOffset : token.offset;
  }
  redirections() {
    const output = [];
    while (this.peek()?.type === "operator" && REDIRECTIONS.has(this.peekOperator() ?? ";")) {
      output.push(this.redirection());
    }
    return output;
  }
  redirection() {
    const token = this.take();
    if (token.type !== "operator" || !REDIRECTIONS.has(token.value)) {
      throw this.tokenError("expected redirection", token);
    }
    if (token.value === "2>&1") return { operator: "2>&1" };
    if (token.value === ">&2") return { operator: ">&2" };
    const target = this.take();
    if (target.type !== "word") throw this.tokenError("redirection requires a word", target);
    if (token.value === "<<" || token.value === "<<-") {
      if (token.document === void 0)
        throw this.tokenError("here-document body is missing", token);
      return { operator: token.value, document: token.document };
    }
    if (token.value === "<<<") return { operator: "<<<", target: target.word };
    if (!isPathRedirectionOperator(token.value))
      throw this.tokenError("unsupported redirection", token);
    return { operator: token.value, target: target.word };
  }
};
function parseInternal(source, context, baseByteOffset, depth) {
  context.depth(depth);
  const tokens = new Lexer(source, context, baseByteOffset, depth, parseInternal).lex();
  const parser = new Parser(tokens, context, depth);
  const script = parser.parse();
  if (!parser.finished()) throw new VfsError("EINVAL", "unexpected trailing shell syntax");
  return script;
}
function parseShellScript(script, maximumNodes, maximumDepth = 64, accountNodes = () => void 0, checkDeadline = () => void 0) {
  const context = new ParseContext(maximumNodes, maximumDepth, accountNodes, checkDeadline);
  const parsed = parseInternal(script, context, 0, 1);
  const result = { ...parsed, nodeCount: context.nodes };
  validateScriptDepth(result, maximumDepth, 1);
  return result;
}

// src/shell/shell-runtime.ts
function emptyInput() {
  return new ReadableStream({
    start(controller) {
      controller.close();
    }
  });
}
function statusFor(error) {
  return error instanceof ShellNounsetError ? 1 : error.code === "EINVAL" ? 2 : error instanceof ShellRefusalError || error.code === "ENOEXEC" ? 126 : 1;
}
function formatError(error) {
  return `${error.path === void 0 ? "" : `${error.path}: `}${error.message}`;
}
async function runIsolatedShellScope(run, stderr) {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ShellNounsetError)) throw error;
    await stderr.write(encodeUtf8(`${formatError(error)}
`));
    return evaluationResult(statusFor(error));
  }
}
async function closeDescriptors(fds) {
  const results = await Promise.allSettled([fds[1].close(), fds[2].close()]);
  const failed = results.find(
    (result) => result.status === "rejected"
  );
  if (failed !== void 0) throw failed.reason;
}
async function abortRedirectedDescriptors(fds, redirected, reason) {
  await Promise.allSettled([
    redirected.has(1) ? fds[1].abort(reason) : fds[1].close(),
    redirected.has(2) ? fds[2].abort(reason) : fds[2].close()
  ]);
}
var ACTIVE_EVALUATION_CONTEXT = Object.freeze({
  errexitSuppressed: false
});
var SUPPRESSED_EVALUATION_CONTEXT = Object.freeze({
  errexitSuppressed: true
});
function suppressErrexit(context) {
  return context.errexitSuppressed ? context : SUPPRESSED_EVALUATION_CONTEXT;
}
function evaluationResult(status, errexitEligible = true) {
  return { status, errexitEligible };
}
function requestErrexit(status, session, context) {
  if (status !== 0 && session.errexit === true && !context.errexitSuppressed && !session.exitRequested && session.flow.type === "none") {
    session.flow = { type: "errexit" };
  }
}
function parseScriptUnit(source, limits, budget, executionBudget, path) {
  const sourceBytes = utf8ByteLength(source);
  if (sourceBytes > limits.maxScriptBytes) {
    throw new VfsError("E2BIG", "shell source exceeds the script byte limit", path);
  }
  if (budget.sourceBytes + sourceBytes > limits.maxTotalSourceBytes) {
    throw new VfsError("E2BIG", "shell total source byte limit exceeded", path);
  }
  budget.sourceBytes += sourceBytes;
  try {
    const parsed = parseShellScript(
      source,
      limits.maxAstNodes - budget.astNodes,
      limits.maxNestingDepth,
      (count) => {
        budget.astNodes += count;
      },
      () => executionBudget.checkDeadline()
    );
    return parsed;
  } catch (error) {
    if (path === void 0 || !isVfsError(error)) throw error;
    throw new VfsError(error.code, error.message, path);
  }
}
async function collectSubstitutionOutput(stream, runtime) {
  const reader = stream.getReader();
  const chunks = [];
  const chunkReleases = [];
  let total = 0;
  let releaseOutput;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > runtime.limits.maxCommandSubstitutionBytes) {
        throw new VfsError("E2BIG", "command substitution output limit exceeded");
      }
      const release = runtime.budget.buffered(result.value.byteLength);
      try {
        chunks.push(result.value.slice());
        chunkReleases.push(release);
      } catch (error) {
        release();
        throw error;
      }
    }
    releaseOutput = runtime.budget.buffered(total);
    const bytes2 = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes2.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    for (const release of chunkReleases.splice(0)) release();
    return { bytes: bytes2, release: releaseOutput };
  } catch (error) {
    await reader.cancel(error).catch(() => void 0);
    releaseOutput?.();
    throw error;
  } finally {
    for (const release of chunkReleases) release();
    reader.releaseLock();
  }
}
function redirections(node) {
  return node.type === "function-definition" ? [] : node.redirections;
}
function expansionRuntime(fds, runtime) {
  let lastStatus;
  return {
    async commandSubstitute(script, session) {
      const output = createBytePipe({
        maximumBytes: runtime.limits.maxCommandSubstitutionBytes,
        signal: runtime.signal,
        name: "command substitution",
        account: (bytes2) => runtime.budget.io(bytes2)
      });
      const child = cloneShellSession(session);
      child.errexit = false;
      const childFds = {
        0: fds[0],
        1: output.sink,
        2: fds[2].clone()
      };
      const completed = (async () => {
        try {
          return await runIsolatedShellScope(
            async () => await runtime.runScript(script, child, childFds, runtime, ACTIVE_EVALUATION_CONTEXT),
            fds[2]
          );
        } finally {
          await closeDescriptors(childFds);
        }
      })();
      let retained;
      try {
        const [collected, result] = await Promise.all([
          collectSubstitutionOutput(output.readable, runtime).then((value2) => {
            retained = value2;
            return value2;
          }),
          completed
        ]);
        lastStatus = result.status;
        let value;
        try {
          value = new TextDecoder("utf-8", { fatal: true }).decode(collected.bytes);
        } catch {
          throw new VfsError("EIO", "command substitution output is not valid UTF-8");
        }
        if (value.includes("\0"))
          throw new VfsError("EINVAL", "command substitution produced a NUL byte");
        return value.replace(/\n+$/u, "");
      } finally {
        retained?.release();
      }
    },
    lastSubstitutionStatus() {
      return lastStatus;
    }
  };
}

// src/shell/shell-execute.ts
function restoreVariables(session, previous, preserved) {
  for (const [name, value] of previous) {
    if (preserved.has(name)) continue;
    if (value === void 0) session.env.delete(name);
    else session.env.set(name, value);
  }
}
function restoreLocals(session, frame) {
  for (const [name, value] of frame) {
    if (value === void 0) session.env.delete(name);
    else session.env.set(name, value);
  }
}
async function runFunction(definition, argv, session, fds, runtime, context) {
  if (session.functionDepth >= runtime.limits.maxFunctionDepth) {
    throw new VfsError("E2BIG", "shell function recursion limit exceeded");
  }
  const previousArgs = session.args;
  const frame = /* @__PURE__ */ new Map();
  const getoptsFrame = { captured: false, state: void 0 };
  session.args = [...argv];
  session.functionDepth += 1;
  session.localFrames.push(frame);
  session.localGetoptsFrames.push(getoptsFrame);
  try {
    let status = (await runtime.runCommandNode(
      definition.body,
      session,
      { 0: fds[0], 1: fds[1].clone(), 2: fds[2].clone() },
      runtime,
      false,
      context
    )).status;
    if (session.flow.type === "return") {
      status = session.flow.status;
      session.flow = { type: "none" };
    }
    return status;
  } finally {
    session.localFrames.pop();
    session.localGetoptsFrames.pop();
    restoreLocals(session, frame);
    if (getoptsFrame.captured) {
      session.getopts = getoptsFrame.state === void 0 ? void 0 : { ...getoptsFrame.state, optindGeneration: optindGeneration(session.env) };
    }
    session.functionDepth -= 1;
    session.args = previousArgs;
  }
}
async function runSourcedUnit(source, path, args, session, fds, runtime, context) {
  if (session.sourceDepth >= runtime.limits.maxSourceDepth) {
    throw new VfsError("E2BIG", "shell source nesting limit exceeded", path);
  }
  const parsed = parseScriptUnit(
    source,
    runtime.limits,
    runtime.parserBudget,
    runtime.budget,
    path
  );
  const previousArgs = session.args;
  if (args.length > 0) session.args = [...args];
  session.sourceDepth += 1;
  try {
    let status = (await runtime.runScript(parsed, session, fds, runtime, context)).status;
    if (session.flow.type === "return") {
      status = session.flow.status;
      session.flow = { type: "none" };
    }
    return status;
  } finally {
    session.sourceDepth -= 1;
    if (args.length > 0) session.args = previousArgs;
  }
}
async function runScriptUnit(source, name, args, session, fds, runtime) {
  if (session.scriptDepth >= runtime.limits.maxScriptDepth) {
    throw new VfsError("E2BIG", "shell script nesting limit exceeded", name);
  }
  const parsed = parseScriptUnit(
    source,
    runtime.limits,
    runtime.parserBudget,
    runtime.budget,
    name
  );
  const child = cloneShellSession(session);
  prepareShellSessionUnit(child);
  child.scriptDepth = session.scriptDepth + 1;
  child.args = [...args];
  child.env.set("0", name);
  const result = await runIsolatedShellScope(
    async () => await runtime.runScript(parsed, child, fds, runtime, ACTIVE_EVALUATION_CONTEXT),
    fds[2]
  );
  return child.exitRequested ? child.requestedExitCode : result.status;
}
function applyAssignments(assignments, session) {
  const previous = /* @__PURE__ */ new Map();
  for (const value of assignments) {
    previous.set(value.name, session.env.get(value.name));
    session.env.set(value.name, value.value);
  }
  return previous;
}
function selectCommand(prepared, session, runtime) {
  const [name = "", ...argv] = prepared.argv;
  const definition = prepared.bypassFunctions === true ? void 0 : session.functions.get(name);
  const command = definition === void 0 ? resolveApplet(name, session, runtime)?.command : void 0;
  const canonicalName = command?.name ?? name;
  authorizeCommand(definition, command, canonicalName, runtime);
  return { name, argv, canonicalName, definition, command };
}
function authorizeCommand(definition, command, canonicalName, runtime) {
  const allowed2 = runtime.policy.allowedCommands;
  if (definition !== void 0 || allowed2 === void 0) return;
  const permitted = command === void 0 ? allowed2.includes(SHELL_PROFILE_COMMAND) : allowed2.includes(canonicalName);
  if (!permitted) throw new ShellRefusalError(`command is not allowed: ${canonicalName}`);
}
async function executeSelection(selected, session, fds, runtime, context) {
  if (selected.definition !== void 0) {
    const exitCode = await runFunction(
      selected.definition,
      selected.argv,
      session,
      fds,
      runtime,
      context
    );
    return { exitCode, eventName: selected.canonicalName, preserveAssignments: false };
  }
  if (selected.command !== void 0) {
    const exitCode = await runApplet(
      selected.command,
      selected.argv,
      session,
      fds,
      runtime,
      context
    );
    return { exitCode, eventName: selected.canonicalName, preserveAssignments: true };
  }
  return await runExternalScript(selected.name, selected.argv, session, fds, runtime);
}
async function runExternalScript(name, argv, session, fds, runtime) {
  const script = await resolveExecutableScript(name, session, runtime);
  if (script === void 0) {
    await fds[2].write(encodeUtf8(`${name}: command not found
`));
    return { exitCode: 127, eventName: name, preserveAssignments: false };
  }
  runtime.budget.command();
  try {
    const exitCode = await runScriptUnit(script.source, name, argv, session, fds, runtime);
    return { exitCode, eventName: script.path, preserveAssignments: false };
  } finally {
    script.release();
  }
}
function commandContext(session, runtime, context) {
  return {
    fileSystem: runtime.fileSystem,
    ...runtime.identities === void 0 ? {} : { identities: runtime.identities },
    session,
    signal: runtime.signal,
    budget: runtime.budget,
    policy: runtime.policy,
    ...runtime.content === void 0 ? {} : { content: runtime.content },
    ...runtime.network === void 0 || runtime.policy.network !== "allow" ? {} : { network: runtime.network },
    executeSource: async (source, path, args, fds) => await runSourcedUnit(source, path, args, session, fds, runtime, context),
    executeCommand: async (argv, fds, options) => {
      runtime.budget.command();
      return await executeSimpleCommand(
        {
          assignments: [],
          argv: [...argv],
          ...options?.bypassFunctions === true ? { bypassFunctions: true } : {}
        },
        session,
        fds,
        runtime,
        SUPPRESSED_EVALUATION_CONTEXT
      );
    },
    resolveCommand: async (name) => await resolveShellCommand(name, session, runtime),
    listCommands: () => describeCommands(runtime),
    now: () => runtime.now(),
    executeScript: async (source, name, args, fds) => await runScriptUnit(source, name, args, session, fds, runtime),
    executeScriptFile: async (path, args, fds, invokedAs) => await executeScriptFile(path, args, fds, invokedAs, session, runtime)
  };
}
async function executeScriptFile(path, args, fds, invokedAs, session, runtime) {
  const probe = await probeShellOperand(path, runtime);
  if (probe.kind === "absent") return void 0;
  if (probe.kind !== "loaded") throw probe.error;
  try {
    return await runScriptUnit(probe.source, invokedAs ?? path, args, session, fds, runtime);
  } finally {
    probe.release();
  }
}
async function runApplet(command, argv, session, fds, runtime, context) {
  const exitCode = (await command.run(commandContext(session, runtime, context), argv, fds).completed).exitCode;
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new RangeError(`command ${command.name} returned an invalid exit status: ${exitCode}`);
  }
  return exitCode;
}
async function executeSimpleCommand(prepared, session, fds, runtime, context) {
  if (prepared.argv.length === 0) {
    for (const value of prepared.assignments) session.env.set(value.name, value.value);
    return prepared.substitutionStatus ?? 0;
  }
  const previous = applyAssignments(prepared.assignments, session);
  const assignmentArgs = prepared.argv.slice(1);
  let preserveAssignments = false;
  try {
    const selected = selectCommand(prepared, session, runtime);
    const outcome = await executeSelection(selected, session, fds, runtime, context);
    preserveAssignments = outcome.preserveAssignments && selected.canonicalName === "export";
    emitShellEvent(runtime.onEvent, {
      type: "shell.command",
      name: outcome.eventName,
      exitCode: outcome.exitCode
    });
    return outcome.exitCode;
  } finally {
    const preserved = preserveAssignments ? new Set(assignmentArgs.map((value) => value.split("=", 1)[0] ?? "")) : /* @__PURE__ */ new Set();
    restoreVariables(session, previous, preserved);
  }
}

// src/shell/shell-evaluate.ts
async function runLoopBody(body, session, fds, runtime, context) {
  runtime.budget.loop();
  const result = await runScript(body, session, fds, runtime, context);
  return { result, action: consumeLoopFlow(session) };
}
async function executeGroup(node, session, fds, runtime, context) {
  const target = node.subshell ? cloneShellSession(session) : session;
  const result = await runScript(node.body, target, fds, runtime, context);
  return node.subshell ? evaluationResult(result.status) : result;
}
async function executeIf(node, session, fds, runtime, context) {
  for (const branch2 of node.branches) {
    const condition = await runScript(
      branch2.condition,
      session,
      fds,
      runtime,
      suppressErrexit(context)
    );
    if (session.exitRequested || session.flow.type !== "none") return condition;
    if (condition.status === 0) {
      return await runScript(branch2.body, session, fds, runtime, context);
    }
  }
  return node.alternate === void 0 ? evaluationResult(0) : await runScript(node.alternate, session, fds, runtime, context);
}
async function executeLoop(node, session, fds, runtime, context) {
  let result = evaluationResult(0);
  session.loopDepth += 1;
  try {
    while (true) {
      const condition = await runScript(
        node.condition,
        session,
        fds,
        runtime,
        suppressErrexit(context)
      );
      if (session.exitRequested || session.flow.type !== "none") return condition;
      if (condition.status === 0 === node.until) return result;
      const iteration = await runLoopBody(node.body, session, fds, runtime, context);
      result = iteration.result;
      if (iteration.action === "break") return result;
      if (iteration.action === "propagate") return result;
      if (session.exitRequested || flowActive(session)) return result;
    }
  } finally {
    session.loopDepth -= 1;
  }
}
async function executeFor(node, session, fds, runtime, expansion, context) {
  const values = node.words === void 0 ? [...session.args] : await expandWords(node.words, session, runtime.fileSystem, runtime.budget, expansion);
  let result = evaluationResult(0);
  session.loopDepth += 1;
  try {
    for (const value of values) {
      session.env.set(node.name, value);
      const iteration = await runLoopBody(node.body, session, fds, runtime, context);
      result = iteration.result;
      if (iteration.action === "break") return result;
      if (iteration.action === "propagate") return result;
      if (session.exitRequested || flowActive(session)) return result;
    }
    return result;
  } finally {
    session.loopDepth -= 1;
  }
}
async function executeCase(node, session, fds, runtime, expansion, context) {
  const value = await expandScalarWord(
    node.word,
    session,
    runtime.fileSystem,
    runtime.budget,
    expansion
  );
  for (const clause of node.clauses) {
    for (const patternWord of clause.patterns) {
      const pattern = await expandCasePattern(
        patternWord,
        session,
        runtime.fileSystem,
        runtime.budget,
        expansion
      );
      if (matchesCasePattern(value, pattern, runtime.budget)) {
        return await runScript(clause.body, session, fds, runtime, context);
      }
    }
  }
  return evaluationResult(0);
}
async function executeCompoundCommand(node, session, fds, runtime, expansion, context) {
  if (node.type === "group") return await executeGroup(node, session, fds, runtime, context);
  if (node.type === "if") return await executeIf(node, session, fds, runtime, context);
  if (node.type === "loop") return await executeLoop(node, session, fds, runtime, context);
  if (node.type === "for") return await executeFor(node, session, fds, runtime, expansion, context);
  if (node.type === "case")
    return await executeCase(node, session, fds, runtime, expansion, context);
  if (node.type === "arithmetic-command") {
    const value = evaluateArithmetic(node.expression, session.env, session.nounset === true);
    return evaluationResult(value === 0n ? 1 : 0);
  }
  const matches = await evaluateConditional(node.expression, session, runtime, expansion);
  return evaluationResult(matches ? 0 : 1);
}
async function executeCommandNode(node, prepared, session, fds, runtime, expansion, context) {
  if (node.type === "command") {
    if (prepared === void 0) throw new VfsError("EIO", "simple command was not expanded");
    return evaluationResult(await executeSimpleCommand(prepared, session, fds, runtime, context));
  }
  if (node.type === "function-definition") {
    session.functions.set(node.name, node);
    return evaluationResult(0);
  }
  return await executeCompoundCommand(node, session, fds, runtime, expansion, context);
}
var FATAL_COMMAND_ERRORS = /* @__PURE__ */ new Set([
  "E2BIG",
  "EFBIG",
  "ETIMEDOUT",
  "ECANCELED"
]);
function isFatalCommandError(error) {
  return FATAL_COMMAND_ERRORS.has(error.code);
}
async function handleCommandError(error, fds, redirected, semanticStderr) {
  if (isDownstreamClosedError(error)) {
    await Promise.allSettled([fds[1].close(), fds[2].close()]);
    return { result: evaluationResult(0), semanticFailure: false };
  }
  if (!isVfsError(error)) {
    await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
    throw error;
  }
  if (isFatalCommandError(error) || error instanceof ShellNounsetError) {
    await abortRedirectedDescriptors(fds, redirected, error);
    throw error;
  }
  try {
    await semanticStderr.write(encodeUtf8(`${formatError(error)}
`));
  } finally {
    await Promise.allSettled([fds[1].close(), fds[2].close()]);
  }
  return { result: evaluationResult(statusFor(error)), semanticFailure: true };
}
async function runCommandNode(node, session, initialFds, runtime, cancelUnreadInput, context) {
  let fds = initialFds;
  let redirected = /* @__PURE__ */ new Set();
  const fallbackStderr = initialFds[2].clone();
  let semanticStderr = fallbackStderr;
  let semanticFailure = false;
  let shouldCancelInput = cancelUnreadInput;
  const expansion = expansionRuntime(initialFds, runtime);
  try {
    runtime.budget.command();
    let prepared = node.type === "command" ? await prepareSimpleCommand(node, session, runtime, expansion) : void 0;
    let applied;
    try {
      applied = await applyRedirections(
        redirections(node),
        fds,
        session,
        runtime.fileSystem,
        runtime.budget,
        cancelUnreadInput,
        expansion,
        {
          content: runtime.content,
          access: runtime.policy.opaqueContent,
          signal: runtime.signal
        }
      );
    } catch (error) {
      fds = { 0: initialFds[0], 1: initialFds[1], 2: fallbackStderr };
      throw error;
    }
    fds = applied.fds;
    semanticStderr = fds[2];
    redirected = applied.redirected;
    shouldCancelInput ||= applied.inputRedirected;
    if (prepared !== void 0) {
      const substitutionStatus = expansion.lastSubstitutionStatus();
      if (substitutionStatus !== void 0) prepared = { ...prepared, substitutionStatus };
    }
    const status = await executeCommandNode(
      node,
      prepared,
      session,
      fds,
      runtime,
      expansion,
      context
    );
    semanticStderr = fallbackStderr;
    await closeDescriptors(fds);
    return status;
  } catch (error) {
    const failure = await handleCommandError(error, fds, redirected, semanticStderr);
    semanticFailure = failure.semanticFailure;
    return failure.result;
  } finally {
    if (shouldCancelInput) {
      await fds[0].cancel(new VfsError("EPIPE", "command stopped reading input")).catch(() => void 0);
    }
    await fallbackStderr.close().catch(() => void 0);
    if (semanticFailure) runtime.budget.step();
  }
}
function buildPipelineStages(pipeline, session, outerFds, runtime, pipelineContext) {
  const stages = [];
  let input = outerFds[0];
  for (const [index, node] of pipeline.commands.entries()) {
    const last = index === pipeline.commands.length - 1;
    const pipe = last ? void 0 : createBytePipe({
      maximumBytes: runtime.limits.maxPipelineBytes,
      signal: runtime.signal,
      name: `pipeline edge ${index + 1}`,
      account: (bytes2) => runtime.budget.io(bytes2)
    });
    stages.push({
      node,
      session: pipeline.commands.length === 1 ? session : cloneShellSession(session),
      fds: { 0: input, 1: pipe?.sink ?? outerFds[1].clone(), 2: outerFds[2].clone() },
      context: last ? pipelineContext : suppressErrexit(pipelineContext)
    });
    if (pipe !== void 0) input = shellInput(pipe.readable);
  }
  return stages;
}
async function runPipelineStages(stages, isolated, outerStderr, runtime) {
  return await Promise.all(
    stages.map((stage, index) => {
      const run = async () => await runCommandNode(
        stage.node,
        stage.session,
        stage.fds,
        runtime,
        index > 0,
        stage.context
      );
      return isolated ? runIsolatedShellScope(run, outerStderr) : run();
    })
  );
}
function selectPipelineResult(results, pipefail) {
  if (pipefail) {
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const candidate = results[index];
      if (candidate !== void 0 && candidate.status !== 0) return candidate;
    }
  }
  return results.at(-1) ?? evaluationResult(0);
}
async function runPipeline(pipeline, session, outerFds, runtime, context) {
  const pipelineContext = pipeline.negated ? suppressErrexit(context) : context;
  const stages = buildPipelineStages(pipeline, session, outerFds, runtime, pipelineContext);
  const isolated = pipeline.commands.length > 1 || pipeline.commands[0]?.type === "group" && pipeline.commands[0].subshell;
  const results = await runPipelineStages(stages, isolated, outerFds[2], runtime);
  const selected = selectPipelineResult(results, session.pipefail);
  const status = pipeline.negated ? selected.status === 0 ? 1 : 0 : selected.status;
  const result = evaluationResult(
    status,
    !pipelineContext.errexitSuppressed && !pipeline.negated && (pipeline.commands.length > 1 || selected.errexitEligible)
  );
  session.lastExitCode = result.status;
  if (result.errexitEligible) requestErrexit(result.status, session, pipelineContext);
  return result;
}
async function runAndOr(node, session, fds, runtime, context) {
  let result = await runPipeline(
    node.first,
    session,
    fds,
    runtime,
    node.rest.length === 0 ? context : suppressErrexit(context)
  );
  for (const [index, item] of node.rest.entries()) {
    if (session.exitRequested || session.flow.type !== "none") break;
    if (item.operator === "&&" && result.status === 0 || item.operator === "||" && result.status !== 0) {
      result = await runPipeline(
        item.pipeline,
        session,
        fds,
        runtime,
        index === node.rest.length - 1 ? context : suppressErrexit(context)
      );
    }
  }
  return result;
}
async function runScript(script, session, fds, runtime, context = ACTIVE_EVALUATION_CONTEXT) {
  let result = evaluationResult(0);
  for (const list of script.lists) {
    runtime.budget.step();
    result = await runAndOr(list, session, fds, runtime, context);
    session.lastExitCode = result.status;
    if (session.exitRequested) return evaluationResult(session.requestedExitCode);
    if (session.flow.type !== "none") return result;
  }
  return result;
}

// src/shell/shell-session-execution.ts
function parseInitialUnit(source, services, parserBudget, budget) {
  try {
    return {
      script: parseScriptUnit(source, services.limits, parserBudget, budget),
      error: void 0
    };
  } catch (error) {
    if (!isVfsError(error)) throw error;
    return { script: void 0, error };
  }
}
function cancellationError(reason) {
  return isVfsError(reason) ? reason : new VfsError("ECANCELED", "execution was cancelled");
}
function attachExternalAbort(signal, controller) {
  if (signal === void 0) return void 0;
  const abort = () => controller.abort(cancellationError(signal.reason));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return abort;
}
function createOutputPipe(name, maximumBytes, controller, budget, services) {
  return createBytePipe({
    maximumBytes,
    signal: controller.signal,
    name,
    account: (bytes2) => budget.io(bytes2),
    idleTimeoutMs: services.limits.outputIdleTimeoutMs,
    onIdle: () => {
      emitShellEvent(services.onEvent, {
        type: "shell.limit",
        limit: "outputIdleTimeoutMs",
        used: services.limits.outputIdleTimeoutMs,
        max: services.limits.outputIdleTimeoutMs
      });
      controller.abort(new VfsError("ETIMEDOUT", `${name} consumer did not relieve backpressure`));
    },
    onConsumerCancel: (reason) => controller.abort(cancellationError(reason))
  });
}
async function runParsedUnit(parsed, session, fds, scoped, content, identities, controller, parserBudget, budget, services) {
  const result = await runScript(parsed, session, fds, {
    commands: services.commands,
    pathLookup: services.pathLookup,
    now: services.now,
    fileSystem: scoped,
    budget,
    policy: services.policy,
    content,
    network: services.network,
    identities,
    signal: controller.signal,
    limits: services.limits,
    parserBudget,
    onEvent: services.onEvent,
    runScript,
    runCommandNode
  });
  await closeDescriptors(fds);
  return { exitCode: result.status };
}
async function reportParseError(error, session, fds, outcome) {
  await fds[2].write(encodeUtf8(`${error.message}
`));
  await closeDescriptors(fds);
  const exitCode = error.code === "EINVAL" ? 2 : 1;
  session.lastExitCode = exitCode;
  outcome.failureCode = error.code;
  return { exitCode };
}
async function handleExecutionError(error, session, fds, controller, outcome) {
  if (!isVfsError(error)) {
    await Promise.allSettled([fds[1].abort(error), fds[2].abort(error)]);
    throw error;
  }
  const exitCode = statusFor(error);
  session.lastExitCode = exitCode;
  outcome.failureCode = error.code;
  if (!controller.signal.aborted || error.code === "ETIMEDOUT") {
    try {
      await fds[2].write(encodeUtf8(`${formatError(error)}
`));
    } catch {
    }
  }
  await Promise.allSettled([fds[1].close(), fds[2].close()]);
  return { exitCode };
}
async function completeExecution(parsed, session, fds, scoped, content, identities, controller, parserBudget, budget, services, outcome, timeout, externalAbort, externalSignal) {
  try {
    if (parsed.error !== void 0) {
      return await reportParseError(parsed.error, session, fds, outcome);
    }
    if (parsed.script === void 0) throw new VfsError("EIO", "parser produced no script");
    return await runParsedUnit(
      parsed.script,
      session,
      fds,
      scoped,
      content,
      identities,
      controller,
      parserBudget,
      budget,
      services
    );
  } catch (error) {
    return await handleExecutionError(error, session, fds, controller, outcome);
  } finally {
    const reason = controller.signal.reason ?? new VfsError("EPIPE", "shell execution stopped reading input");
    await fds[0].cancel(reason).catch(() => void 0);
    clearTimeout(timeout);
    if (externalAbort !== void 0) externalSignal?.removeEventListener("abort", externalAbort);
  }
}
function observeExecution(completed, budget, outcome, services) {
  return completed.then(
    (result) => {
      emitShellEvent(services.onEvent, {
        type: "shell.execution",
        exitCode: result.exitCode,
        durationMs: budget.elapsedMs(),
        ...outcome.failureCode === void 0 ? {} : { failureCode: outcome.failureCode }
      });
      return result;
    },
    (error) => {
      emitShellEvent(services.onEvent, {
        type: "shell.execution",
        exitCode: 1,
        durationMs: budget.elapsedMs(),
        ...isVfsError(error) ? { failureCode: error.code } : {}
      });
      throw error;
    }
  );
}
function executeShellSessionStream(options, session, services) {
  const parserBudget = { sourceBytes: 0, astNodes: 0 };
  const budget = new ExecutionBudget(services.limits, services.now, services.onEvent);
  const parsed = parseInitialUnit(options.script, services, parserBudget, budget);
  const controller = new AbortController();
  const externalAbort = attachExternalAbort(options.signal, controller);
  const scoped = services.fileSystem(budget, session);
  const identities = services.identityResolver === void 0 ? void 0 : { resolver: services.identityResolver, signal: controller.signal };
  const content = services.content === void 0 ? void 0 : scopedContentReader(services.content, (path) => scoped.assertReadable(path));
  const stdout = createOutputPipe(
    "stdout",
    services.limits.maxStdoutBytes,
    controller,
    budget,
    services
  );
  const stderr = createOutputPipe(
    "stderr",
    services.limits.maxStderrBytes,
    controller,
    budget,
    services
  );
  const timeout = setTimeout(() => {
    controller.abort(new VfsError("ETIMEDOUT", "shell execution deadline exceeded"));
  }, budget.remainingDeadlineMs());
  const fds = {
    0: shellInput(options.stdin ?? emptyInput()),
    1: stdout.sink,
    2: stderr.sink
  };
  const outcome = {};
  const completed = completeExecution(
    parsed,
    session,
    fds,
    scoped,
    content,
    identities,
    controller,
    parserBudget,
    budget,
    services,
    outcome,
    timeout,
    externalAbort,
    options.signal
  );
  return {
    stdout: stdout.readable,
    stderr: stderr.readable,
    completed: observeExecution(completed, budget, outcome, services),
    cancel(reason) {
      controller.abort(cancellationError(reason));
    }
  };
}

// src/shell/shell.ts
var Shell = class {
  commands;
  #appletListing;
  pathLookup;
  fileSystem;
  policy;
  content;
  network;
  identityResolver;
  limits;
  now;
  onEvent;
  constructor(options) {
    this.commands = createAppletRegistry(options.commands);
    this.pathLookup = options.commandResolution === "path";
    this.fileSystem = options.fileSystem;
    this.content = options.content;
    this.network = options.network;
    this.identityResolver = options.identityResolver;
    this.policy = Object.freeze({
      ...options.policy?.readRoots === void 0 ? {} : {
        readRoots: Object.freeze(options.policy.readRoots.map((path) => normalizePath(path)))
      },
      ...options.policy?.writeRoots === void 0 ? {} : {
        writeRoots: Object.freeze(options.policy.writeRoots.map((path) => normalizePath(path)))
      },
      ...options.policy?.opaqueContent === void 0 ? {} : { opaqueContent: options.policy.opaqueContent },
      ...options.policy?.network === void 0 ? {} : { network: options.policy.network },
      ...options.policy?.allowedCommands === void 0 ? {} : { allowedCommands: Object.freeze([...options.policy.allowedCommands]) },
      ...options.policy?.maxMutations === void 0 ? {} : { maxMutations: options.policy.maxMutations }
    });
    this.limits = Object.freeze(
      resolveShellLimits({
        ...options.limits,
        ...options.policy?.maxMutations === void 0 ? {} : { maxMutations: options.policy.maxMutations }
      })
    );
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }
  /**
   * Describes every registered applet, in UTF-8 byte order by name.
   *
   * The same list `help` sees. It is public because completion runs before any
   * command exists, in the interactive layer, which has no command context to
   * ask.
   */
  listCommands() {
    return describeCommands({ commands: this.commands });
  }
  /**
   * What a session may be offered, from the same rules that would run it.
   *
   * Built here rather than assembled by a subclass out of fields, because both
   * halves are policy decisions the shell owns. The filesystem is the scoped
   * one every execution uses, so completion cannot list a directory the
   * session could not read — discovery through a different door than
   * execution is how a sandbox leaks. The names are filtered by the command
   * allowlist and include the applet path spellings that actually resolve, so
   * completion never advertises a command that would fail with 126 or 127.
   */
  /**
   * The names this session could actually run, in resolution order.
   *
   * Filtered by the command allowlist and joined with the session's own
   * functions, so nothing offered or listed is a command that would be refused.
   */
  #runnableNames(functions) {
    const allowed2 = this.policy.allowedCommands;
    const names = [];
    for (const command of this.commands.names()) {
      if (allowed2 !== void 0 && !allowed2.includes(command)) continue;
      names.push(command);
    }
    for (const name of functions) if (!names.includes(name)) names.push(name);
    return names.sort();
  }
  /**
   * The filesystem a session sees: the policy's, with the reserved paths in
   * front of it.
   *
   * The applet directories are listable rather than absent, so `which cat`
   * answering `/bin/cat` and `ls /bin` showing it are the same fact. They hold
   * no rows — a row there could be removed while `/bin/cat` kept working —
   * which is why they are reserved here instead of provisioned.
   */
  #reservedView(budget, fileSystem = this.fileSystem) {
    this.#appletListing ??= this.#buildAppletListing();
    const view = new ReservedPathFileSystem(new ScopedFileSystem(fileSystem, this.policy, budget), {
      applets: { directories: APPLET_DIRECTORIES, names: this.#appletListing }
    });
    registerFileSystemOrigin(view, this.fileSystem);
    return view;
  }
  #sessionFileSystem(session) {
    if (session.credentials === void 0) return this.fileSystem;
    if (!supportsPosixCredentials(this.fileSystem)) {
      throw new VfsError("ENOTSUP", "filesystem does not support POSIX credentials");
    }
    return this.fileSystem.forCredentials(session.credentials, { umask: session.umask });
  }
  /**
   * The applet directory listing, which depends only on the registry and the
   * policy and so is computed once rather than per execution.
   *
   * Session functions are deliberately not an input: a function is not a
   * program, so it has no path form and the filter below would drop it anyway.
   */
  #buildAppletListing() {
    const directory = APPLET_DIRECTORIES[0] ?? "/bin";
    const allowed2 = this.policy.allowedCommands;
    const listed = [];
    for (const name of this.commands.names()) {
      if (allowed2 !== void 0 && !allowed2.includes(name)) continue;
      if (this.commands.findPath(`${directory}/${name}`) === void 0) continue;
      if (name === "." || name === ".." || name.includes("/")) continue;
      listed.push(name);
    }
    return listed.sort();
  }
  completionSource(session) {
    const budget = new ExecutionBudget(this.limits, this.now, this.onEvent);
    const names = this.#runnableNames(new Set(session.functions.keys()));
    return {
      fileSystem: this.#reservedView(budget, this.#sessionFileSystem(session)),
      commands: names,
      // An absolute applet path resolves before any PATH search, so these
      // spell a runnable command whether or not PATH lookup is enabled.
      appletDirectories: APPLET_DIRECTORIES
    };
  }
  executeStream(options) {
    return this.executeSessionStream(options, createShellSession(options));
  }
  executeSessionStream(options, session) {
    return executeShellSessionStream(options, session, {
      commands: this.commands,
      pathLookup: this.pathLookup,
      now: this.now,
      fileSystem: (budget, activeSession) => this.#reservedView(budget, this.#sessionFileSystem(activeSession)),
      content: this.content,
      network: this.network,
      identityResolver: this.identityResolver,
      limits: this.limits,
      policy: this.policy,
      onEvent: this.onEvent
    });
  }
  async executeText(options) {
    return this.executeSessionText(options, createShellSession(options));
  }
  async executeSessionText(options, session) {
    const result = await this.executeSessionBytes(options, session);
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdoutBytes),
      stderr: new TextDecoder().decode(result.stderrBytes)
    };
  }
  async executeBytes(options) {
    return this.executeSessionBytes(options, createShellSession(options));
  }
  async executeSessionBytes(options, session) {
    const { stdin: input, ...streamOptions } = options;
    const stdin = typeof input === "string" || input instanceof Uint8Array ? bodyToStream(input) : input;
    const execution = this.executeSessionStream(
      {
        ...streamOptions,
        ...stdin === void 0 ? {} : { stdin }
      },
      session
    );
    const collectOutput = async (stream, maximumBytes) => {
      try {
        return await readAllBytes(stream, maximumBytes);
      } catch (error) {
        if (isVfsError(error)) return new Uint8Array();
        throw error;
      }
    };
    const [stdoutBytes, stderrBytes, result] = await Promise.all([
      collectOutput(execution.stdout, this.limits.maxStdoutBytes),
      collectOutput(execution.stderr, this.limits.maxStderrBytes),
      execution.completed
    ]);
    if (stdoutBytes.byteLength + stderrBytes.byteLength > this.limits.maxMaterializedOutputBytes) {
      return {
        exitCode: 1,
        stdoutBytes: new Uint8Array(),
        stderrBytes: new Uint8Array()
      };
    }
    return {
      exitCode: result.exitCode,
      stdoutBytes,
      stderrBytes
    };
  }
};

// demo/benchmark-git-checkout-recovery.ts
import * as git8 from "isomorphic-git";

// src/shell/commands/git.ts
import * as git7 from "isomorphic-git";

// src/shell/commands/git-checkout-writes.ts
var GitCheckoutWrites = class {
  constructor(context) {
    this.context = context;
  }
  context;
  pending = [];
  bytes = 0;
  scheduled = false;
  chain = Promise.resolve();
  write(path, body, mode) {
    if (this.context.fileSystem.canUseBulkOperation?.("write-target", path) !== true)
      return void 0;
    const backend = this.context.fileSystem.availableWriteBufferBytes ?? 0;
    const available = this.context.budget.remainingBufferedBytes?.() ?? 0;
    if (body.byteLength > 128 * 1024 || backend < 256 * 1024 || available < body.byteLength)
      return void 0;
    if (this.bytes + body.byteLength > 128 * 1024) this.flush();
    const release = this.context.budget.buffered(body.byteLength);
    const result = new Promise((resolve, reject) => {
      this.pending.push({
        entry: mode === void 0 ? { path, body } : { path, body, mode },
        release,
        resolve,
        reject
      });
      this.bytes += body.byteLength;
    });
    if (this.pending.length === 32) this.flush();
    if (!this.scheduled) {
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        this.flush();
      }, 0);
    }
    return result;
  }
  flush() {
    const pending = this.pending;
    if (pending.length === 0) return;
    this.pending = [];
    this.bytes = 0;
    this.chain = this.chain.then(async () => {
      try {
        if (this.context.signal.aborted)
          throw new VfsError("ECANCELED", "Git execution was cancelled");
        this.context.budget.step();
        await this.publish(pending);
      } catch (error) {
        for (const item of pending) item.reject(error);
      } finally {
        for (const item of pending) item.release();
      }
    });
  }
  async publish(pending) {
    const write = this.context.fileSystem.writeFiles;
    if (write === void 0) throw new VfsError("ENOTSUP", "batch writes are unavailable");
    const eligible = pending.filter(
      (item) => this.context.fileSystem.canUseBulkOperation?.("write-target", item.entry.path) === true
    );
    if (eligible.length > 0)
      await write.call(
        this.context.fileSystem,
        eligible.map((item) => item.entry)
      );
    for (const item of eligible) item.resolve();
    for (const item of pending) {
      if (eligible.includes(item)) continue;
      await this.context.fileSystem.writeFile(
        item.entry.path,
        item.entry.body,
        item.entry.mode === void 0 ? void 0 : { mode: item.entry.mode }
      );
      item.resolve();
    }
  }
};

// src/shell/commands/git-object-writes.ts
function isLooseGitObject(path, prefix) {
  return path.startsWith(prefix) && /^[a-f0-9]{2}\/[a-f0-9]{38}$/u.test(path.slice(prefix.length));
}
var GitObjectWrites = class {
  constructor(context, prefix, capacity2, release, mkdir) {
    this.context = context;
    this.prefix = prefix;
    this.capacity = capacity2;
    this.release = release;
    this.mkdir = mkdir;
  }
  context;
  prefix;
  capacity;
  release;
  mkdir;
  pending = /* @__PURE__ */ new Map();
  held = 0;
  failure;
  flushing;
  matches(path) {
    return isLooseGitObject(path, this.prefix);
  }
  async retain(path, body, mode) {
    if (this.flushing !== void 0) await this.flushing;
    if (this.held + body.byteLength > this.capacity) return false;
    const previous = this.pending.get(path);
    this.held -= previous?.body instanceof Uint8Array ? previous.body.byteLength : 0;
    this.pending.set(path, mode === 33188 ? { path, body } : { path, body, mode });
    this.held += body.byteLength;
    return true;
  }
  async beforeRead(path) {
    if (this.pending.has(path) || this.flushing !== void 0) await this.flush();
  }
  async flush() {
    if (this.failure !== void 0) throw this.failure;
    if (this.flushing !== void 0) return this.flushing;
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    this.held = 0;
    const work = this.commit(entries);
    this.flushing = work;
    try {
      await work;
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.flushing = void 0;
    }
  }
  async commit(entries) {
    for (const path of new Set(entries.map((entry) => dirname(entry.path)))) this.mkdir(path);
    const writes = entries.map(
      (entry) => entry.mode === void 0 || this.context.fileSystem.inspectWriteTarget(entry.path) === null ? entry : { path: entry.path, body: entry.body }
    );
    const write = this.context.fileSystem.writeFiles;
    if (write === void 0) throw new Error("Git object batch lost its writer");
    if (writes.every(
      (entry) => this.context.fileSystem.canUseBulkOperation?.("write-target", entry.path) === true
    )) {
      await write.call(this.context.fileSystem, writes);
    } else {
      for (const entry of writes)
        await this.context.fileSystem.writeFile(
          entry.path,
          entry.body,
          entry.mode === void 0 ? void 0 : { mode: entry.mode }
        );
    }
  }
  close() {
    this.pending.clear();
    this.release();
  }
};

// src/shell/commands/git-stat-reads.ts
function gitStatReads(read) {
  let pending = [];
  const flush = () => {
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    try {
      const results = read(batch.map((entry) => entry.path));
      if (results.length !== batch.length) throw new VfsError("EIO", "incomplete metadata batch");
      for (const [index, entry] of batch.entries()) {
        const result = results[index];
        if (result === void 0) throw new VfsError("EIO", "incomplete metadata batch");
        entry.resolve(result);
      }
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    }
  };
  return (path) => new Promise((resolve, reject) => {
    if (pending.length === 0) queueMicrotask(flush);
    pending.push({ path, resolve, reject });
    if (pending.length === 1e3) flush();
  });
}

// src/shell/commands/helpers.ts
function commandPath(context, path = ".") {
  return normalizeFileSystemPath(path, context.session.cwd);
}
async function writeBytes2(sink, bytes2) {
  if (bytes2.byteLength > 0) await sink.write(bytes2);
}
async function writeText(sink, value) {
  await writeBytes2(sink, encodeUtf8(value));
}
async function readWithAbort(reader, signal) {
  const cancellation = () => signal.reason instanceof VfsError ? signal.reason : new VfsError("ECANCELED", "execution was cancelled");
  if (signal.aborted) throw cancellation();
  return await new Promise((resolve, reject) => {
    const abort = () => {
      const error = cancellation();
      void reader.cancel(error).catch(() => void 0);
      reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
async function collectStream(context, stream, maximumBytes = context.budget.limits.maxBufferedBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let release = () => void 0;
  let retained = false;
  try {
    for (; ; ) {
      const result = await readWithAbort(reader, context.signal);
      if (result.done) break;
      total += result.value.byteLength;
      context.budget.io(result.value.byteLength);
      if (total > maximumBytes)
        throw new VfsError("E2BIG", "buffered command input limit exceeded");
      release();
      release = context.budget.buffered(total);
      chunks.push(result.value.slice());
    }
    const only = chunks.length === 1 ? chunks[0] : void 0;
    if (only !== void 0) {
      context.budget.step(0);
      retained = true;
      return { value: only, release };
    }
    const releaseOutput = context.budget.buffered(total);
    const bytes2 = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes2.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0;
    release();
    release = releaseOutput;
    retained = true;
    return { value: bytes2, release: releaseOutput };
  } catch (error) {
    await reader.cancel(error).catch(() => void 0);
    throw error;
  } finally {
    reader.releaseLock();
    if (!retained) release();
  }
}
function readFile(context, path) {
  return context.fileSystem.readFile(commandPath(context, path));
}
async function readFileBytes(context, path) {
  const read = readFile(context, path);
  return await collectStream(context, read.stream);
}

// src/shell/commands/git-fs.ts
var GitFileSystem = class {
  constructor(context) {
    this.context = context;
  }
  context;
  failure;
  workReads;
  objectWrites;
  commitObjectPrefix;
  checkoutWrites;
  objectDirectories = /* @__PURE__ */ new Set();
  configPath;
  pendingConfig;
  statReads;
  beginWorkReads(limit) {
    this.workReads = { limit, snapshots: /* @__PURE__ */ new Map(), stats: /* @__PURE__ */ new Map() };
    const fileSystem = this.context.fileSystem;
    const read = fileSystem.statMany;
    if (read !== void 0)
      this.statReads = gitStatReads((paths) => read.call(fileSystem, paths, { follow: false }));
  }
  workReadSnapshot(path) {
    return this.workReads?.snapshots.get(path);
  }
  workStatSnapshot(path) {
    return this.workReads?.stats.get(path);
  }
  async readBytes(path) {
    const resolved = commandPath(this.context, path);
    const read = this.context.fileSystem.readFile(resolved);
    const work = this.workReads;
    if (work !== void 0 && (work.snapshots.size < work.limit || work.snapshots.has(resolved)))
      work.snapshots.set(resolved, read.stat);
    return collectStream(this.context, read.stream);
  }
  /** Share only overlapping reads, never a completed configuration snapshot. */
  coalesceConfigReads(gitdir) {
    this.configPath = `${gitdir}/config`;
  }
  beginObjectWrites(gitdir, inputBytes, files) {
    const backend = this.context.fileSystem.availableWriteBufferBytes ?? 0;
    const capacity2 = Math.min(2 * inputBytes + 128 * files, backend - inputBytes);
    const available = this.context.budget.remainingBufferedBytes?.() ?? 0;
    if (files < 32 || capacity2 <= 0 || this.context.fileSystem.writeFiles === void 0 || available < capacity2 + inputBytes)
      return;
    this.startObjectWrites(`${gitdir}/objects/`, capacity2);
  }
  /** Reserve lazily: reading the index and parent commit needs full headroom. */
  beginCommitWrites(gitdir) {
    this.commitObjectPrefix = `${gitdir}/objects/`;
  }
  endCommitWrites() {
    this.endObjectWrites();
    this.commitObjectPrefix = void 0;
  }
  retainCommitObjects(path) {
    const prefix = this.commitObjectPrefix;
    if (prefix === void 0 || this.objectWrites !== void 0 || !isLooseGitObject(path, prefix))
      return;
    const capacity2 = Math.min(
      128 * 1024,
      this.context.fileSystem.availableWriteBufferBytes ?? 0,
      this.context.budget.remainingBufferedBytes?.() ?? 0
    );
    if (capacity2 > 0 && this.context.fileSystem.writeFiles !== void 0)
      this.startObjectWrites(prefix, capacity2);
  }
  async flushCommitObjects() {
    if (this.commitObjectPrefix === void 0 || this.objectWrites === void 0) return;
    await this.objectWrites.flush();
    this.endObjectWrites();
  }
  async retainObject(writer, path, bytes2, mode) {
    if (writer.matches(path) && await writer.retain(path, bytes2, mode)) return true;
    await writer.flush();
    if (this.commitObjectPrefix !== void 0) this.endObjectWrites();
    return false;
  }
  beforeObjectRead(path) {
    return this.commitObjectPrefix === void 0 ? this.objectWrites?.beforeRead(path) : this.flushCommitObjects();
  }
  startObjectWrites(prefix, capacity2) {
    const release = this.context.budget.buffered(capacity2);
    this.objectWrites = new GitObjectWrites(this.context, prefix, capacity2, release, (path) => {
      if (this.objectDirectories.has(path)) return;
      try {
        this.mkdir(path);
      } catch (error) {
        if (!(error instanceof VfsError)) throw error;
        if (error.code === "ENOENT") this.mkdir(path, true);
        else if (error.code !== "EEXIST") throw error;
      }
      this.objectDirectories.add(path);
    });
  }
  beginCheckoutWrites(dir, gitdir) {
    if (this.context.fileSystem.writeFiles !== void 0 && this.context.fileSystem.canUseBulkOperation !== void 0)
      this.checkoutWrites = {
        dir: `${dir}/`,
        gitdir: `${gitdir}/`,
        writer: new GitCheckoutWrites(this.context)
      };
  }
  endCheckoutWrites() {
    this.checkoutWrites = void 0;
  }
  endObjectWrites() {
    this.objectWrites?.close();
    this.objectWrites = void 0;
  }
  async loadConfig(path) {
    const lease = await readFileBytes(this.context, path);
    try {
      return { value: new TextDecoder().decode(lease.value), byteLength: lease.value.byteLength };
    } finally {
      lease.release();
    }
  }
  async readConfig(path) {
    if (this.pendingConfig !== void 0) {
      const value = await this.pendingConfig;
      this.context.budget.io(value.byteLength);
      return value;
    }
    const pending = this.loadConfig(path);
    this.pendingConfig = pending;
    try {
      return await pending;
    } finally {
      this.pendingConfig = void 0;
    }
  }
  check() {
    if (this.failure !== void 0) throw this.failure;
    if (this.context.signal.aborted) throw new VfsError("ECANCELED", "Git execution was cancelled");
    this.context.budget.step();
  }
  async operation(run) {
    try {
      this.check();
      return await run();
    } catch (error) {
      if (error instanceof VfsError && !["ENOENT", "EEXIST", "ENOTDIR", "EISDIR"].includes(error.code))
        this.failure = error;
      throw error;
    }
  }
  mkdir(path, recursive = false) {
    this.check();
    return this.context.fileSystem.mkdir(
      commandPath(this.context, path),
      recursive,
      16895 & ~this.context.session.umask
    );
  }
  /** Keep the metadata already returned by a directory read for local transfers. */
  listEntries(path) {
    this.check();
    const entries = this.context.fileSystem.list(commandPath(this.context, path));
    this.context.budget.glob(entries.length);
    return entries.filter((entry) => entry.ino !== NO_ENTRY_IDENTITY);
  }
  creationMode(path, mode) {
    return mode === 33188 || this.context.fileSystem.inspectWriteTarget(path) !== null ? void 0 : mode;
  }
  checkoutWrite(path, bytes2, mode) {
    const batch = this.checkoutWrites;
    if (batch === void 0 || !path.startsWith(batch.dir) || path.startsWith(batch.gitdir))
      return void 0;
    return batch.writer.write(path, bytes2, mode);
  }
  fileStats(path, follow) {
    const resolved = commandPath(this.context, path);
    const read = () => {
      const entry = follow ? this.context.fileSystem.stat(resolved) : this.context.fileSystem.lstat(resolved);
      const work = this.workReads;
      if (work !== void 0 && (work.stats.size < work.limit || work.stats.has(resolved)))
        work.stats.set(resolved, entry);
      return new FsStats(entry);
    };
    if (!follow && this.statReads !== void 0 && this.objectWrites === void 0)
      return this.statReads(resolved).then((result) => {
        if ("error" in result)
          throw new VfsError(result.error.code, result.error.message, result.error.path);
        const work = this.workReads;
        if (work !== void 0 && (work.stats.size < work.limit || work.stats.has(resolved)))
          work.stats.set(resolved, result.stat);
        return new FsStats(result.stat);
      });
    return this.objectWrites === void 0 ? read() : this.objectWrites.beforeRead(resolved).then(read);
  }
  promises = {
    readFile: (path, options) => this.operation(async () => {
      if (this.objectWrites !== void 0)
        await this.beforeObjectRead(commandPath(this.context, path));
      const encoding2 = typeof options === "string" ? options : options?.encoding;
      if (path === this.configPath && (encoding2 === "utf8" || encoding2 === "utf-8"))
        return (await this.readConfig(path)).value;
      const lease = await this.readBytes(path);
      try {
        if (encoding2 !== void 0 && encoding2 !== "utf8" && encoding2 !== "utf-8")
          throw new VfsError("ENOTSUP", "Git supports only UTF-8 text encoding", path);
        return encoding2 === void 0 ? lease.value : new TextDecoder().decode(lease.value);
      } finally {
        lease.release();
      }
    }),
    writeFile: (path, body, options) => this.operation(async () => {
      const bytes2 = typeof body === "string" ? encodeUtf8(body) : body;
      this.context.budget.io(bytes2.byteLength);
      const resolved = commandPath(this.context, path);
      const mode = (options?.mode ?? 33206) & ~this.context.session.umask;
      this.retainCommitObjects(resolved);
      if (this.objectWrites !== void 0 && await this.retainObject(this.objectWrites, resolved, bytes2, mode))
        return;
      const creationMode = this.creationMode(resolved, mode);
      const pending = this.checkoutWrite(resolved, bytes2, creationMode);
      if (pending !== void 0) return pending;
      const creation = creationMode === void 0 ? void 0 : { mode: creationMode };
      await this.context.fileSystem.writeFile(resolved, bytes2, creation);
    }),
    stat: (path) => this.operation(() => this.fileStats(path, true)),
    lstat: (path) => this.operation(() => this.fileStats(path, false)),
    readdir: (path) => this.operation(() => {
      const list = () => {
        const entries = this.context.fileSystem.list(commandPath(this.context, path));
        this.context.budget.glob(entries.length);
        return entries.filter((entry) => entry.ino !== NO_ENTRY_IDENTITY).map((entry) => entry.name);
      };
      return this.commitObjectPrefix === void 0 ? list() : this.flushCommitObjects().then(list);
    }),
    mkdir: (path) => this.operation(() => this.mkdir(path)),
    unlink: (path) => this.operation(() => {
      const resolved = commandPath(this.context, path);
      if (this.context.fileSystem.lstat(resolved).kind === "directory")
        throw new VfsError("EISDIR", "cannot unlink a directory", resolved);
      return this.context.fileSystem.remove(resolved).then(() => void 0);
    }),
    rmdir: (path) => this.operation(() => {
      const resolved = commandPath(this.context, path);
      if (this.context.fileSystem.lstat(resolved).kind !== "directory")
        throw new VfsError("ENOTDIR", "not a directory", resolved);
      return this.context.fileSystem.remove(resolved).then(() => void 0);
    }),
    readlink: (path) => this.operation(() => this.context.fileSystem.readlink(commandPath(this.context, path))),
    symlink: (target, path) => this.operation(
      () => this.context.fileSystem.symlink(commandPath(this.context, path), target)
    ),
    chmod: (path, mode) => this.operation(
      () => this.context.fileSystem.setMetadata(commandPath(this.context, path), { mode })
    )
  };
};

// src/shell/commands/git-local.ts
import * as git5 from "isomorphic-git";

// src/shell/commands/git-checkout.ts
import * as git from "isomorphic-git";
async function checkoutGit(repo, options) {
  const gitdir = `${repo.gitdir}/.checkout-${crypto.randomUUID()}`;
  const translate = (path) => path === gitdir || path.startsWith(`${gitdir}/`) ? repo.gitdir + path.slice(gitdir.length) : path;
  const promises = new Proxy(repo.fs.promises, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        const index = property === "symlink" ? 1 : 0;
        const path = args[index];
        if (typeof path === "string") args[index] = translate(path);
        return Reflect.apply(value, target, args);
      };
    }
  });
  repo.fs.beginCheckoutWrites(repo.dir, repo.gitdir);
  try {
    return await git.checkout({ ...repo, ...options, fs: { promises }, gitdir });
  } finally {
    repo.fs.endCheckoutWrites();
  }
}

// src/shell/commands/git-object-copy.ts
var GitObjectTree = class {
  constructor(fs) {
    this.fs = fs;
  }
  fs;
  directories = /* @__PURE__ */ new Map();
  consume(path) {
    const entries = this.directories.get(path);
    this.directories.delete(path);
    return entries ?? this.fs.listEntries(path);
  }
  list(path) {
    let entries = this.directories.get(path);
    if (entries === void 0) {
      entries = this.fs.listEntries(path);
      this.directories.set(path, entries);
    }
    return entries;
  }
};
function ordinaryEntry(entry, umask) {
  const expected = (entry.kind === "directory" ? 16895 : 33206) & ~umask;
  return entry.mode === expected && entry.uid === 0 && entry.gid === 0 && (entry.kind === "directory" || entry.kind === "file" && entry.contentClass === "inline" && (entry.nlink ?? 1) === 1);
}
function inspectTree(fs, root, tree) {
  const directories = [root];
  let bytes2 = 0, largest = 0;
  for (const directory of directories) {
    for (const entry of tree.list(directory)) {
      fs.check();
      if (!ordinaryEntry(entry, fs.context.session.umask)) return void 0;
      if (entry.kind === "directory") directories.push(entry.path);
      else {
        bytes2 += entry.sizeBytes;
        largest = Math.max(largest, entry.sizeBytes);
      }
    }
  }
  return { bytes: bytes2, largest };
}
async function copyFreshGitObjects(fs, from, to, tree) {
  const vfs = fs.context.fileSystem;
  if (vfs.canUseBulkOperation?.("copy-source", from) !== true) return false;
  const root = vfs.lstat(from);
  if (root.kind !== "directory" || !ordinaryEntry(root, fs.context.session.umask)) return false;
  const size = inspectTree(fs, from, tree);
  if (size === void 0) return false;
  const placeholders = fs.listEntries(to);
  if (placeholders.some(
    (entry) => entry.kind !== "directory" || fs.listEntries(entry.path).length !== 0
  ))
    return false;
  fs.check();
  if (vfs.canUseBulkOperation?.("copy-source", from) !== true) return false;
  fs.context.budget.io(size.bytes * 2);
  const release = fs.context.budget.buffered(size.largest);
  release();
  for (const entry of placeholders) {
    fs.check();
    await vfs.remove(entry.path);
  }
  fs.check();
  await vfs.copy(from, to, { recursive: true, replace: true });
  return true;
}

// src/shell/commands/git-options.ts
function gitArguments(argv, flags = [], valued = []) {
  const parsed = { operands: [], flags: /* @__PURE__ */ new Set(), values: /* @__PURE__ */ new Map() };
  let literal = false;
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === void 0) continue;
    if (literal || !argument.startsWith("-") || argument === "-") {
      parsed.operands.push(argument);
      continue;
    }
    if (argument === "--") {
      literal = true;
      continue;
    }
    if (flags.includes(argument)) {
      parsed.flags.add(argument);
      continue;
    }
    const option = valueOption(argument, argv[i + 1], valued);
    parsed.values.set(option.name, option.value);
    if (option.consumed) i++;
  }
  return parsed;
}
function gitOperands(args, minimum, maximum = minimum) {
  if (args.operands.length < minimum || args.operands.length > maximum)
    throw new VfsError("EINVAL", "git: incorrect number of operands");
}
function localGitPath(value, cwd) {
  let path = value;
  if (value.startsWith("file://")) {
    const url = new URL(value);
    if (url.hostname !== "" || url.search !== "" || url.hash !== "")
      throw new VfsError("ENOTSUP", "git: only local file URLs are supported");
    path = decodeURIComponent(url.pathname);
  } else if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
    throw new VfsError("ENOTSUP", "git: only local repository paths are supported");
  }
  return normalizeFileSystemPath(path, cwd);
}
function valueOption(argument, next, allowed2) {
  const split = argument.indexOf("=");
  const name = split < 0 ? argument : argument.slice(0, split);
  if (!allowed2.includes(name)) throw new VfsError("EINVAL", `git: unsupported option ${argument}`);
  const value = split < 0 ? next : argument.slice(split + 1);
  if (value === void 0 || value === "")
    throw new VfsError("EINVAL", `git: ${name} requires a value`);
  return { name, value, consumed: split < 0 };
}

// src/shell/commands/git-repository.ts
import * as git2 from "isomorphic-git";
function gitExists(fs, path) {
  fs.check();
  try {
    fs.context.fileSystem.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof VfsError && error.code === "ENOENT") return false;
    throw error;
  }
}
function gitRepository(fs, path, parents = true) {
  let dir = fs.context.fileSystem.realpath(path);
  for (; ; ) {
    fs.check();
    if (gitExists(fs, `${dir}/.git/HEAD`)) return { fs, dir, gitdir: normalizePath(`${dir}/.git`) };
    if (gitExists(fs, `${dir}/HEAD`) && gitExists(fs, `${dir}/objects`))
      return { fs, dir, gitdir: dir };
    const parent = dirname(dir);
    if (!parents || parent === dir) throw new VfsError("EINVAL", "git: not a Git repository", path);
    dir = parent;
  }
}
async function gitIdentity(repo) {
  const env = repo.fs.context.session.env;
  const name = env.get("GIT_AUTHOR_NAME") ?? await git2.getConfig({ ...repo, path: "user.name" });
  const email = env.get("GIT_AUTHOR_EMAIL") ?? await git2.getConfig({ ...repo, path: "user.email" });
  if (typeof name !== "string" || name === "" || typeof email !== "string" || email === "")
    throw new VfsError("EINVAL", "git: configure user.name and user.email before committing");
  const timestamp = Math.floor(repo.fs.context.now() / 1e3);
  return { name, email, timestamp, timezoneOffset: 0 };
}
async function gitHead(repo) {
  try {
    return await git2.resolveRef({ ...repo, ref: "HEAD" });
  } catch (error) {
    if (error instanceof git2.Errors.NotFoundError) return void 0;
    throw error;
  }
}

// src/shell/commands/git-status.ts
import * as git4 from "isomorphic-git";

// src/shell/commands/git-work-identity.ts
import * as git3 from "isomorphic-git";
var capacity = 4096;
var filesystems = /* @__PURE__ */ new WeakMap();
function cachedWorkIdentity(repo) {
  const origin = fileSystemOrigin(repo.fs.context.fileSystem);
  let identities = filesystems.get(origin);
  if (identities === void 0) {
    identities = /* @__PURE__ */ new Map();
    filesystems.set(origin, identities);
  }
  const cache = identities;
  repo.fs.beginWorkReads(capacity);
  let config;
  return async (entry, path) => {
    const mode = await entry.mode();
    const full = `${repo.dir}/${path}`;
    const ordinary = (mode & 61440) === 32768;
    config ??= git3.getConfig({ ...repo, path: "core.autocrlf" });
    const conversion = await config;
    const cached = ordinary ? cache.get(full) : void 0;
    const metadata = repo.fs.workStatSnapshot(full);
    if (cached !== void 0 && cached.conversion === conversion && metadata?.ino === cached.ino && metadata.mutationToken === cached.token) {
      const read = repo.fs.context.fileSystem.readFile(full, {
        range: { offset: Number.MAX_SAFE_INTEGER }
      });
      await read.stream.cancel();
      if (read.stat.ino === cached.ino && read.stat.mutationToken === cached.token) {
        repo.fs.check();
        const release = repo.fs.context.budget.buffered(read.stat.sizeBytes);
        release();
        repo.fs.context.budget.io(read.stat.sizeBytes);
        return `${mode}:${cached.oid}`;
      }
    }
    const body = await entry.content();
    if (body === void 0) return void 0;
    const oid = (await git3.hashBlob({ object: body })).oid;
    const snapshot = repo.fs.workReadSnapshot(full);
    if (ordinary && snapshot !== void 0 && (cache.size < capacity || cache.has(full))) {
      cache.set(full, { ino: snapshot.ino, token: snapshot.mutationToken, oid, conversion });
    }
    return `${mode}:${oid}`;
  };
}

// src/shell/commands/git-status.ts
async function gitMatrix(repo, paths = ["."], stagingSizes) {
  const rows = [];
  const ignoreFs = missingIgnoreProbes(repo);
  const inspectWork = boundedWorkIdentity(repo);
  const relevant = (path) => path === "." || paths.some(
    (prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`)
  );
  await git4.walk({
    ...repo,
    trees: [git4.TREE({ ref: "HEAD" }), git4.WORKDIR(), git4.STAGE()],
    iterate: async (walk5, children) => {
      const selected = [];
      for (const child of children) {
        const names = child;
        const path = names.find((name) => typeof name === "string");
        if (path === void 0 || path !== ".git" && !path.startsWith(".git/") && relevant(path))
          selected.push(walk5(child));
      }
      return await Promise.all(selected);
    },
    map: async (path, entries) => {
      repo.fs.check();
      if (path === ".git" || path.startsWith(".git/")) return null;
      if (!relevant(path)) return null;
      const [head, , stage] = entries;
      const types = await Promise.all(entries.map((entry) => entry?.type()));
      if (path === "." || types.includes("tree")) return;
      if (head === null && stage === null && await git4.isIgnored({ ...repo, fs: ignoreFs, filepath: path }))
        return;
      rows.push(await matrixRow(path, entries, inspectWork, stagingSizes));
      return void 0;
    }
  });
  return rows.sort((a, b) => compareUtf8(a[0], b[0]));
}
async function matrixRow(path, entries, inspectWork, stagingSizes) {
  const [head, work, stage] = entries;
  if (stagingSizes !== void 0 && head == null && stage == null && work != null && await work.type() === "blob") {
    stagingSizes.set(path, (await work.stat()).size);
    return [path, 0, 2, 0];
  }
  const h = await entryIdentity(head), i = await entryIdentity(stage);
  const w = await inspectWork(work, path);
  const workColumn = matrixColumn(h, w), stageColumn = matrixColumn(h, i, w);
  if (stagingSizes !== void 0 && work != null && workColumn !== stageColumn)
    stagingSizes.set(path, (await work.stat()).size);
  return [path, h === void 0 ? 0 : 1, workColumn, stageColumn];
}
async function entryIdentity(entry) {
  return entry == null ? void 0 : `${await entry.mode()}:${await entry.oid()}`;
}
async function requireCleanGitTree(repo) {
  const dirty = (await gitMatrix(repo)).some(
    ([, head, work, stage]) => head !== work || work !== stage
  );
  if (dirty) throw new VfsError("EEXIST", "git: operation requires a clean working tree and index");
}
function gitStatusCode(head, work, stage) {
  if (head === 0 && stage === 0) return "??";
  const index = head === stage ? " " : head === 0 ? "A" : stage === 0 ? "D" : "M";
  const tree = work === stage ? " " : work === 0 ? "D" : "M";
  return `${index}${tree}`;
}
function boundedWorkIdentity(repo) {
  const inspect = cachedWorkIdentity(repo);
  let active = 0;
  const waiting = [];
  return async (entry, path) => {
    if (entry == null) return void 0;
    if (active < 32) active++;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      return await inspect(entry, path);
    } finally {
      const next = waiting.shift();
      if (next === void 0) active--;
      else next();
    }
  };
}
function matrixColumn(head, value, work) {
  if (value === void 0) return 0;
  if (value === head) return 1;
  return work === void 0 || value === work ? 2 : 3;
}
function missingIgnoreProbes(repo) {
  const memoizeMissing = (read) => {
    const missing = /* @__PURE__ */ new Map();
    return (path) => {
      const cached = missing.get(path);
      if (cached !== void 0) {
        repo.fs.check();
        return cached;
      }
      if (missing.size >= 128) return read(path);
      const pending = read(path).then(
        (value) => {
          missing.delete(path);
          return value;
        },
        (error) => {
          if (!(error instanceof VfsError) || error.code !== "ENOENT") missing.delete(path);
          throw error;
        }
      );
      missing.set(path, pending);
      return pending;
    };
  };
  return {
    promises: {
      ...repo.fs.promises,
      // Git's ignore reader requests UTF-8; successful bodies are never retained.
      readFile: memoizeMissing((path) => repo.fs.promises.readFile(path, "utf8")),
      stat: memoizeMissing(repo.fs.promises.stat),
      lstat: memoizeMissing(repo.fs.promises.lstat)
    }
  };
}

// src/shell/commands/git-local.ts
async function copyObjects(source, target, fresh = false) {
  if (gitExists(source.fs, `${source.gitdir}/shallow`) || gitExists(source.fs, `${source.gitdir}/objects/info/alternates`))
    throw new VfsError(
      "ENOTSUP",
      "git: shallow repositories and object alternates are unsupported"
    );
  const tree = new GitObjectTree(source.fs);
  const from = `${source.gitdir}/objects`, to = `${target.gitdir}/objects`;
  if (fresh && await copyFreshGitObjects(source.fs, from, to, tree)) return;
  await copyDirectory(source.fs, from, to, tree);
}
async function copyDirectory(fs, source, target, tree) {
  fs.check();
  fs.mkdir(target, true);
  for (const entry of tree.consume(source)) {
    fs.check();
    const from = `${source}/${entry.name}`, to = `${target}/${entry.name}`;
    if (entry.kind === "symlink")
      throw new VfsError("ENOTSUP", "git: symbolic links in object storage are unsupported", from);
    if (entry.kind === "directory") await copyDirectory(fs, from, to, tree);
    else if (!gitExists(fs, to)) {
      const bytes2 = await fs.promises.readFile(from);
      if (typeof bytes2 === "string") throw new VfsError("EIO", "expected binary Git object", from);
      await fs.promises.writeFile(to, bytes2);
    }
  }
}
async function importRefs(source, target, remote2, bare = false, fresh = false) {
  await copyObjects(source, target, fresh);
  const branches = await git5.listBranches(source);
  for (const branch2 of branches) {
    source.fs.check();
    const oid = await git5.resolveRef({ ...source, ref: `refs/heads/${branch2}` });
    await git5.writeRef({
      ...target,
      ref: bare ? `refs/heads/${branch2}` : `refs/remotes/${remote2}/${branch2}`,
      value: oid,
      force: true
    });
  }
  for (const tag of await git5.listTags(source)) {
    const ref = `refs/tags/${tag}`;
    const oid = await git5.resolveRef({ ...source, ref });
    if (gitExists(target.fs, `${target.gitdir}/${ref}`)) {
      if (await git5.resolveRef({ ...target, ref }) !== oid)
        throw new VfsError("EEXIST", "git: refusing to replace an existing tag", tag);
    } else await git5.writeRef({ ...target, ref, value: oid });
  }
  return branches;
}
async function localClone(fs, argv, fds) {
  const args = gitArguments(argv, ["--bare", "--no-checkout"], ["-b", "--branch"]);
  gitOperands(args, 1, 2);
  const path = localGitPath(args.operands[0] ?? "", fs.context.session.cwd);
  const source = gitRepository(fs, path, false);
  const requestedBranch = args.values.get("-b") ?? args.values.get("--branch");
  const available = await git5.listBranches(source);
  if (requestedBranch !== void 0 && !available.includes(requestedBranch))
    throw new VfsError("ENOENT", "git: requested branch not found", requestedBranch);
  const name = basename(path).replace(/\.git$/u, "");
  const destination = localGitPath(args.operands[1] ?? name, fs.context.session.cwd);
  const bare = args.flags.has("--bare");
  if (gitExists(fs, destination) && fs.context.fileSystem.list(destination).length !== 0)
    throw new VfsError("EEXIST", "git: clone destination is not empty", destination);
  fs.mkdir(destination, true);
  const dir = fs.context.fileSystem.realpath(destination);
  if (dir === source.dir || dir === source.gitdir || isDescendant(source.gitdir, dir))
    throw new VfsError("EINVAL", "git: destination overlaps source object storage");
  const target = { fs, dir, gitdir: bare ? dir : normalizePath(`${dir}/.git`) };
  const current = await git5.currentBranch(source);
  const selectedBranch = requestedBranch ?? (typeof current === "string" ? current : void 0);
  const branch2 = selectedBranch ?? "main";
  await git5.init({ ...target, bare, defaultBranch: branch2 });
  await git5.setConfig({ ...target, path: "remote.origin.url", value: source.dir });
  await git5.setConfig({
    ...target,
    path: "remote.origin.fetch",
    value: "+refs/heads/*:refs/remotes/origin/*"
  });
  const branches = await importRefs(source, target, "origin", bare, true);
  await checkoutClone(
    source,
    target,
    selectedBranch,
    branches,
    bare,
    args.flags.has("--no-checkout")
  );
  await writeText(fds[2], `Cloned local repository into '${dir}'.
`);
}
async function remoteRepository(repo, remote2) {
  const url = await git5.getConfig({ ...repo, path: `remote.${remote2}.url` });
  if (typeof url !== "string")
    throw new VfsError("ENOENT", "git: remote is not configured", remote2);
  return gitRepository(repo.fs, localGitPath(url, repo.dir), false);
}
async function localFetch(repo, argv, fds) {
  const args = gitArguments(argv);
  gitOperands(args, 0, 1);
  const remote2 = args.operands[0] ?? "origin";
  const source = await remoteRepository(repo, remote2);
  await importRefs(source, repo, remote2);
  const branch2 = await git5.currentBranch(source);
  if (branch2 !== void 0 && await git5.listBranches(source).then((names) => names.includes(branch2)))
    await git5.writeRef({
      ...repo,
      ref: `refs/remotes/${remote2}/HEAD`,
      value: `refs/remotes/${remote2}/${branch2}`,
      symbolic: true,
      force: true
    });
  await writeText(fds[2], `Fetched local remote '${remote2}'.
`);
}
async function setTracking(repo, branch2, remote2, remoteBranch) {
  await git5.setConfig({ ...repo, path: `branch.${branch2}.remote`, value: remote2 });
  await git5.setConfig({
    ...repo,
    path: `branch.${branch2}.merge`,
    value: `refs/heads/${remoteBranch}`
  });
}
async function localPush(repo, argv, fds) {
  const args = gitArguments(argv, ["-u", "--set-upstream"]);
  gitOperands(args, 0, 2);
  const remote2 = args.operands[0] ?? "origin";
  const target = await remoteRepository(repo, remote2);
  const current = await git5.currentBranch(repo);
  const refspec = args.operands[1] ?? current;
  if (refspec === void 0) throw new VfsError("EINVAL", "git: push requires a branch");
  const [from, to = from, extra] = refspec.split(":");
  if (!from || !to || extra !== void 0 || from.startsWith("+") || to.startsWith("refs/"))
    throw new VfsError(
      "ENOTSUP",
      "git: only branch pushes without force or deletion are supported"
    );
  if (!/^[A-Za-z0-9_-]+(?:[/.][A-Za-z0-9_-]+)*$/u.test(to) || to === "HEAD" || to.split("/").some((part) => part.endsWith(".lock")))
    throw new VfsError("EINVAL", "git: unsupported destination branch name", to);
  const bare = await git5.getConfig({ ...target, path: "core.bare" });
  if (bare !== true && bare !== "true" && await git5.currentBranch(target) === to)
    throw new VfsError("EACCES", "git: refusing to push to the checked-out branch", to);
  const ref = `refs/heads/${to}`, refPath = normalizePath(`${target.gitdir}/${ref}`);
  target.fs.mkdir(dirname(refPath), true);
  const token = target.fs.context.fileSystem.getMutationToken(refPath);
  const old = await optionalRef(target, ref);
  const oid = await git5.resolveRef({ ...repo, ref: from });
  await copyObjects(repo, target);
  if (old !== void 0 && old !== oid && !await git5.isDescendent({ ...target, oid, ancestor: old }))
    throw new VfsError("EEXIST", "git: non-fast-forward push rejected", to);
  target.fs.check();
  target.fs.context.budget.io(41);
  await target.fs.context.fileSystem.writeFile(refPath, `${oid}
`, { ifMutationToken: token });
  await git5.writeRef({ ...repo, ref: `refs/remotes/${remote2}/${to}`, value: oid, force: true });
  if (args.flags.size > 0) await setTracking(repo, from, remote2, to);
  await writeText(fds[2], `Pushed '${from}' to local remote '${remote2}/${to}'.
`);
}
async function optionalRef(repo, ref) {
  try {
    return await git5.resolveRef({ ...repo, ref });
  } catch (error) {
    if (error instanceof git5.Errors.NotFoundError) return void 0;
    throw error;
  }
}
async function localPull(repo, argv, fds) {
  const args = gitArguments(argv, ["--ff-only"]);
  gitOperands(args, 0, 2);
  const branch2 = await git5.currentBranch(repo);
  if (branch2 === void 0) throw new VfsError("EINVAL", "git: pull requires a checked-out branch");
  const configuredRemote = await git5.getConfig({
    ...repo,
    path: `branch.${branch2}.remote`
  });
  const remote2 = args.operands[0] ?? (typeof configuredRemote === "string" ? configuredRemote : "origin");
  const merge2 = await git5.getConfig({ ...repo, path: `branch.${branch2}.merge` });
  const remoteBranch = args.operands[1] ?? (typeof merge2 === "string" ? merge2.replace(/^refs\/heads\//u, "") : branch2);
  await localFetch(repo, [remote2], fds);
  const theirs = `refs/remotes/${remote2}/${remoteBranch}`;
  await requireCleanGitTree(repo);
  const ours = await gitHead(repo);
  if (ours === void 0 || ours !== await optionalRef(repo, theirs)) {
    await checkoutGit(repo, { ref: theirs, dryRun: true });
    await git5.merge({ ...repo, ours: branch2, theirs, fastForwardOnly: true });
    await checkoutGit(repo, { ref: branch2 });
  }
  await writeText(fds[2], "Updated by fast-forward only.\n");
}
async function checkoutClone(source, target, branch2, branches, bare, noCheckout) {
  if (branch2 !== void 0 && branches.includes(branch2)) {
    const oid = await git5.resolveRef({ ...source, ref: `refs/heads/${branch2}` });
    await git5.writeRef({ ...target, ref: `refs/heads/${branch2}`, value: oid, force: true });
    await setTracking(target, branch2, "origin", branch2);
    if (!bare && !noCheckout) await checkoutGit(target, { ref: branch2 });
  } else {
    const oid = await gitHead(source);
    if (oid !== void 0) {
      await git5.writeRef({ ...target, ref: "HEAD", value: oid, force: true });
      if (!bare && !noCheckout) await checkoutGit(target, { ref: oid });
    }
  }
}

// src/shell/commands/git-worktree.ts
import * as git6 from "isomorphic-git";
function relativePath2(repo, value) {
  const written = normalizeFileSystemPath(value, repo.fs.context.session.cwd);
  let path = normalizePath(written);
  try {
    path = repo.fs.context.fileSystem.realpath(written, { follow: false });
  } catch (error) {
    if (!(error instanceof VfsError) || error.code !== "ENOENT") throw error;
    const separator = written.lastIndexOf("/");
    const parent = repo.fs.context.fileSystem.realpath(written.slice(0, separator) || "/");
    path = normalizePath(`${parent}/${written.slice(separator + 1)}`);
  }
  if (path !== repo.dir && !isDescendant(repo.dir, path))
    throw new VfsError("EINVAL", "git: path is outside the working tree", value);
  const relative = path === repo.dir ? "." : path.slice(repo.dir === "/" ? 1 : repo.dir.length + 1);
  if (relative === ".git" || relative.startsWith(".git/"))
    throw new VfsError("EINVAL", "git: Git metadata cannot be staged", value);
  return relative;
}
async function gitAdd(repo, argv) {
  const args = gitArguments(argv, ["-A", "--all"]);
  gitOperands(args, args.flags.size === 0 ? 1 : 0, Number.MAX_SAFE_INTEGER);
  const paths = args.operands.length === 0 ? ["."] : args.operands.map((path) => relativePath2(repo, path));
  repo.fs.coalesceConfigReads(repo.gitdir);
  const options = { ...repo, cache: {} };
  const sizes = /* @__PURE__ */ new Map();
  const matrix = await gitMatrix(options, paths, sizes);
  const selected = matrix.filter(
    ([path, , work, stage]) => work !== stage && paths.some((prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`))
  );
  for (const batch of stagingBatches(selected, sizes)) {
    repo.fs.check();
    const bodies = batch.filter(([, , work]) => work !== 0);
    repo.fs.beginObjectWrites(
      repo.gitdir,
      bodies.reduce((sum, [path]) => sum + (sizes.get(path) ?? 0), 0),
      bodies.length
    );
    try {
      const existing = batch.filter(([, head, work, stage]) => work !== 0 && (head === 0 || stage !== 0)).map(([path]) => path);
      if (existing.length > 0) await git6.add({ ...options, filepath: existing, force: true });
      const headOnly = batch.filter(([, head, work, stage]) => head !== 0 && work !== 0 && stage === 0).map(([path]) => path);
      if (headOnly.length > 0) await git6.add({ ...options, filepath: headOnly });
      const removed = batch.filter(([, , work]) => work === 0).map(([path]) => path);
      if (removed.length > 0) await git6.remove({ ...options, filepath: removed });
    } finally {
      repo.fs.endObjectWrites();
    }
  }
  for (const path of paths) {
    if (path !== "." && !matrix.some(([name]) => name === path || name.startsWith(`${path}/`)))
      await git6.add({ ...options, filepath: path });
  }
}
function* stagingBatches(rows, sizes) {
  const removalOnly = rows.every(([, , work]) => work === 0);
  for (let start = 0; start < rows.length; ) {
    const end = removalOnly ? Math.min(start + 1024, rows.length) : smallBatchEnd(rows, sizes, start);
    yield rows.slice(start, end);
    start = end;
  }
}
function smallBatchEnd(rows, sizes, start) {
  let end = Math.min(start + 32, rows.length);
  let bytes2 = rows.slice(start, end).reduce((total, [path]) => total + (sizes.get(path) ?? 0), 0);
  while (end < rows.length && end - start < 128) {
    const size = sizes.get(rows[end]?.[0] ?? "") ?? 0;
    if (bytes2 + size > 1024 * 1024) break;
    bytes2 += size;
    end++;
  }
  return end;
}
async function gitStatus(repo, argv, fds) {
  const args = gitArguments(argv, ["--short", "-s", "--porcelain"]);
  gitOperands(args, 0);
  const rows = await gitMatrix(repo);
  for (const [path, head, work, stage] of rows) {
    repo.fs.check();
    if (head === work && work === stage) continue;
    const code = gitStatusCode(head, work, stage);
    await writeText(fds[1], `${code} ${JSON.stringify(path)}
`);
  }
}
async function gitCommit(repo, argv, fds) {
  const args = gitArguments(argv, ["--allow-empty"], ["-m", "--message"]);
  gitOperands(args, 0);
  const message = args.values.get("-m") ?? args.values.get("--message");
  if (message === void 0) throw new VfsError("EINVAL", "git: commit requires -m MESSAGE");
  const author = await gitIdentity(repo);
  const env = repo.fs.context.session.env;
  const committer = {
    ...author,
    name: env.get("GIT_COMMITTER_NAME") ?? author.name,
    email: env.get("GIT_COMMITTER_EMAIL") ?? author.email
  };
  repo.fs.beginCommitWrites(repo.gitdir);
  let oid;
  try {
    oid = await git6.commit({
      ...repo,
      message,
      author,
      committer,
      disallowEmpty: !args.flags.has("--allow-empty")
    });
  } finally {
    repo.fs.endCommitWrites();
  }
  await writeText(fds[1], `${oid}
`);
}
async function gitLog(repo, argv, fds) {
  const args = gitArguments(argv, ["--oneline"], ["-n", "--max-count"]);
  gitOperands(args, 0, 1);
  const depth = Number(args.values.get("-n") ?? args.values.get("--max-count") ?? "10");
  if (!Number.isSafeInteger(depth) || depth < 1)
    throw new VfsError("EINVAL", "git: invalid log count");
  for (const { oid, commit: commit2 } of await git6.log({
    ...repo,
    ref: args.operands[0] ?? "HEAD",
    depth
  })) {
    repo.fs.check();
    const text = args.flags.has("--oneline") ? `${oid.slice(0, 7)} ${commit2.message.split("\n")[0]}
` : `commit ${oid}
Author: ${commit2.author.name} <${commit2.author.email}>

${commit2.message.trimEnd()}

`;
    await writeText(fds[1], text);
  }
}
async function gitBranch(repo, argv, fds) {
  const args = gitArguments(argv);
  gitOperands(args, 0, 2);
  const name = args.operands[0];
  if (name !== void 0)
    await git6.branch({ ...repo, ref: name, object: args.operands[1] ?? "HEAD" });
  else {
    const current = await git6.currentBranch(repo);
    for (const branch2 of await git6.listBranches(repo))
      await writeText(fds[1], `${branch2 === current ? "*" : " "} ${branch2}
`);
  }
}
async function gitCheckout(repo, argv) {
  const args = gitArguments(argv, ["--force", "-f"], ["-b"]);
  const force = args.flags.has("--force") || args.flags.has("-f");
  const branch2 = args.values.get("-b");
  gitOperands(args, branch2 === void 0 ? 1 : 0, 1);
  const ref = branch2 ?? args.operands[0];
  if (ref === void 0) throw new VfsError("EINVAL", "git: checkout requires a reference");
  if (branch2 !== void 0)
    await git6.branch({ ...repo, ref: branch2, object: args.operands[0] ?? "HEAD" });
  const oid = await checkoutOid(repo, ref);
  const head = await git6.resolveRef({ ...repo, ref: "HEAD" });
  if (!force && oid === head && branch2 !== void 0) {
    await git6.writeRef({
      ...repo,
      ref: "HEAD",
      value: `refs/heads/${branch2}`,
      symbolic: true,
      force: true
    });
    return;
  }
  if (!force) await requireCleanGitTree(repo);
  await checkoutGit(repo, { ref, force });
}
async function gitDiff(repo, argv, fds) {
  const args = gitArguments(argv, ["--cached", "--staged"]);
  gitOperands(args, 0);
  const cached = args.flags.size > 0;
  const trees = cached ? [git6.TREE({ ref: "HEAD" }), git6.STAGE()] : [git6.STAGE(), git6.WORKDIR()];
  const compare = boundedDiffBodies();
  await git6.walk({
    ...repo,
    trees,
    map: async (path, entries) => {
      repo.fs.check();
      if (path === ".git" || path.startsWith(".git/")) return null;
      const [before, after] = entries;
      if (path === "." || await before?.type() === "tree" || await after?.type() === "tree")
        return;
      if (!cached && before == null) return;
      const oldOid = await before?.oid();
      if (cached && oldOid !== void 0 && oldOid === await after?.oid()) return;
      await compare(() => renderWalkerDiff(repo, fds, path, before, after, cached, oldOid));
      return void 0;
    }
  });
}
function boundedDiffBodies() {
  let active = 0;
  const waiting = [];
  return async (run) => {
    if (active < 32) active++;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      await run();
    } finally {
      const next = waiting.shift();
      if (next === void 0) active--;
      else next();
    }
  };
}
async function renderWalkerDiff(repo, fds, path, before, after, cached, oldOid) {
  repo.fs.check();
  const right = await walkerContent(repo, after, cached);
  if (!cached && right !== void 0 && oldOid === (await git6.hashBlob({ object: right })).oid)
    return;
  const left = await walkerContent(repo, before, true);
  await renderGitDiff(
    repo,
    fds,
    path,
    before == null,
    after == null,
    left ?? new Uint8Array(),
    right ?? new Uint8Array()
  );
}
async function renderGitDiff(repo, fds, path, added, removed, oldBytes, newBytes) {
  if (oldBytes.length === newBytes.length && oldBytes.every((byte, i) => byte === newBytes[i]))
    return;
  const release = repo.fs.context.budget.buffered(oldBytes.byteLength + newBytes.byteLength);
  try {
    const header = `diff --git a/${path} b/${path}
`;
    if (oldBytes.includes(0) || newBytes.includes(0)) {
      await writeText(fds[1], `${header}Binary files differ
`);
      return;
    }
    const diff = createLineDiff(
      new TextDecoder().decode(oldBytes),
      new TextDecoder().decode(newBytes)
    );
    await writeText(
      fds[1],
      header + renderLineDiff(
        added ? "/dev/null" : `a/${path}`,
        removed ? "/dev/null" : `b/${path}`,
        diff
      )
    );
  } finally {
    release();
  }
}
async function walkerContent(repo, entry, stored) {
  if (entry == null) return void 0;
  if (stored) return (await git6.readBlob({ ...repo, oid: await entry.oid() })).blob;
  return await entry.content();
}
async function checkoutOid(repo, ref) {
  try {
    return await git6.resolveRef({ ...repo, ref });
  } catch (error) {
    if (!(error instanceof git6.Errors.NotFoundError)) throw error;
    return await git6.resolveRef({ ...repo, ref: `refs/remotes/origin/${ref}` });
  }
}

// src/shell/commands/git.ts
var SPEC = {
  name: "git",
  usage: "[-C DIRECTORY] COMMAND [ARGUMENT...]",
  summary: "operates Git repositories and local remotes in the VFS"
};
var gitCommand = /* @__PURE__ */ defineApplet(SPEC, async (context, argv, fds) => {
  try {
    return await executeGit(context, argv, fds);
  } catch (error) {
    if (error instanceof VfsError) throw error;
    await writeText(fds[2], `git: ${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
});
async function executeGit(context, argv, fds) {
  let index = 0, cwd = context.session.cwd;
  while (argv[index] === "-C") {
    const path = argv[index + 1];
    if (path === void 0) throw new VfsError("EINVAL", "git: -C requires a directory");
    cwd = localGitPath(path, cwd);
    if (context.fileSystem.stat(cwd).kind !== "directory")
      throw new VfsError("ENOTDIR", "git: not a directory", cwd);
    index += 2;
  }
  const scoped = { ...context, session: { ...context.session, cwd } };
  const fs = new GitFileSystem(scoped);
  const command = argv[index], args = argv.slice(index + 1);
  if (command === void 0 || command === "--help") {
    await writeText(
      fds[1],
      "git: init add status diff commit log branch checkout config remote clone fetch push pull rev-parse\nLocal paths only; pull is fast-forward only.\n"
    );
    return 0;
  }
  if (command === "init") await initialize(fs, args);
  else if (command === "clone") await localClone(fs, args, fds);
  else await repositoryCommand(gitRepository(fs, cwd), command, args, fds);
  fs.check();
  return 0;
}
async function initialize(fs, argv) {
  const args = gitArguments(argv, ["--bare"], ["-b", "--initial-branch"]);
  gitOperands(args, 0, 1);
  const dir = commandPath(fs.context, args.operands[0] ?? ".");
  await git7.init({
    fs,
    dir,
    bare: args.flags.has("--bare"),
    defaultBranch: args.values.get("-b") ?? args.values.get("--initial-branch") ?? "main"
  });
}
async function repositoryCommand(repo, command, args, fds) {
  if (repo.gitdir === repo.dir && ["add", "status", "diff", "commit", "checkout", "pull"].includes(command))
    throw new VfsError("ENOTSUP", "git: command requires a working tree");
  switch (command) {
    case "add":
      return gitAdd(repo, args);
    case "status":
      return gitStatus(repo, args, fds);
    case "diff":
      return gitDiff(repo, args, fds);
    case "commit":
      return gitCommit(repo, args, fds);
    case "log":
      return gitLog(repo, args, fds);
    case "branch":
      return gitBranch(repo, args, fds);
    case "checkout":
      return gitCheckout(repo, args);
    case "fetch":
      return localFetch(repo, args, fds);
    case "push":
      return localPush(repo, args, fds);
    case "pull":
      return localPull(repo, args, fds);
    case "config":
      return configure(repo, args, fds);
    case "remote":
      return remote(repo, args, fds);
    case "rev-parse": {
      const parsed = gitArguments(args);
      gitOperands(parsed, 1);
      await writeText(
        fds[1],
        `${await git7.resolveRef({ ...repo, ref: parsed.operands[0] ?? "HEAD" })}
`
      );
      return;
    }
    default:
      throw new VfsError("ENOTSUP", `git: unsupported command ${command}`);
  }
}
async function configure(repo, argv, fds) {
  const args = gitArguments(argv, ["--local", "--get"]);
  gitOperands(args, 1, 2);
  const path = args.operands[0] ?? "";
  if (args.flags.has("--get") && args.operands.length !== 1)
    throw new VfsError("EINVAL", "git: --get takes one key");
  const value = args.operands[1];
  if (value === void 0) {
    const found = await git7.getConfig({ ...repo, path });
    if (found === void 0) throw new VfsError("ENOENT", "git: config key not found", path);
    await writeText(fds[1], `${String(found)}
`);
  } else await git7.setConfig({ ...repo, path, value });
}
async function remote(repo, argv, fds) {
  if (argv[0] === "add") {
    const args = gitArguments(argv.slice(1));
    gitOperands(args, 2);
    const name = args.operands[0] ?? "", value = args.operands[1] ?? "";
    if (!/^[A-Za-z0-9_-]+$/u.test(name)) throw new VfsError("EINVAL", "git: invalid remote name");
    await git7.addRemote({
      ...repo,
      remote: name,
      url: localGitPath(value, repo.fs.context.session.cwd)
    });
  } else {
    const args = gitArguments(argv, ["-v"]);
    gitOperands(args, 0);
    for (const entry of await git7.listRemotes(repo))
      await writeText(
        fds[1],
        args.flags.has("-v") ? `${entry.remote}	${entry.url}
` : `${entry.remote}
`
      );
  }
}

// demo/benchmark-git-command.ts
function benchmarkGitCommand(identityTime) {
  if (identityTime === void 0) return gitCommand;
  return {
    name: gitCommand.name,
    run: (context, argv, fds) => gitCommand.run({ ...context, now: () => identityTime }, argv, fds)
  };
}

// demo/benchmark-git-checkout-recovery.ts
async function runCheckoutRecovery(vfs, identityTime) {
  const root = "/scratch/checkout-recovery";
  const fs = createFsAdapter(vfs);
  await fs.promises.rm(root, { recursive: true, force: true });
  const shell = new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] });
  const run = (script) => shell.executeText({ script, cwd: root });
  const succeed = async (script) => {
    const result = await run(script);
    if (result.exitCode !== 0) throw new Error(`${script}: ${result.stderr}`);
  };
  await shell.executeText({ script: `git init ${root}` });
  await succeed("git config user.name Recovery; git config user.email recovery@example.invalid");
  for (let n = 0; n < 32; n++) await vfs.writeFile(`${root}/f${n}`, `base ${n}
`);
  await succeed("git add -A && git commit -m base && git branch base");
  for (let n = 0; n < 32; n++) await vfs.writeFile(`${root}/f${n}`, `next ${n}
`);
  await succeed("git add -A && git commit -m next");
  const head = await git8.resolveRef({ fs, dir: root, ref: "HEAD" });
  let writes = 0;
  const wrapped = new Proxy(vfs, {
    get(target, property) {
      if (property === "forCredentials" || property === "canUseBulkOperation") return void 0;
      if (property === "writeFile")
        return async (...args) => {
          if (args[0].startsWith(`${root}/f`) && ++writes === 8)
            throw new VfsError("ENOSPC", "injected checkout write failure");
          return target.writeFile(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const faulty = new Shell({ fileSystem: wrapped, commands: [benchmarkGitCommand(identityTime)] });
  if ((await faulty.executeText({ script: "git checkout base", cwd: root })).exitCode === 0 || writes < 8)
    throw new Error("Checkout fault was not observed");
  if (await git8.resolveRef({ fs, dir: root, ref: "HEAD" }) !== head)
    throw new Error("Failed checkout changed HEAD");
  let changed = 0;
  for (let n = 0; n < 32; n++) {
    const body = await fs.promises.readFile(`${root}/f${n}`, "utf8");
    if (body === `base ${n}
`) changed++;
    else if (body !== `next ${n}
`) throw new Error("Unexpected partial checkout bytes");
    const { blob } = await git8.readBlob({ fs, dir: root, oid: head, filepath: `f${n}` });
    if (new TextDecoder().decode(blob) !== `next ${n}
`)
      throw new Error("Checkout corrupted history");
  }
  if (changed === 0 || changed === 32) throw new Error("Expected a partial worktree");
  if ((await run("git checkout base")).exitCode === 0)
    throw new Error("Dirty partial checkout was not guarded");
  await succeed("git checkout --force base");
  for (let n = 0; n < 32; n++)
    if (await fs.promises.readFile(`${root}/f${n}`, "utf8") !== `base ${n}
`)
      throw new Error("Checkout repair failed");
  if ((await run("git status --porcelain")).stdout !== "")
    throw new Error("Checkout repair left dirty files");
  await fs.promises.rm(root, { recursive: true });
  return { iterations: 1, verified: 100 };
}

// demo/workspace-operations.ts
var WorkspaceOperations = class {
  constructor(capacity2 = 64) {
    this.capacity = capacity2;
  }
  capacity;
  tail = Promise.resolve();
  pending = 0;
  run(operation) {
    if (this.pending >= this.capacity)
      return Promise.reject(new VfsError("EAGAIN", "Workspace is busy; retry shortly"));
    this.pending++;
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      }
    );
    return result;
  }
};

// demo/benchmark-git-recovery.ts
var ROOT = "/scratch/recovery";
async function runGitRecovery(vfs, operation, identityTime) {
  if (operation === "checkout-failure") return runCheckoutRecovery(vfs, identityTime);
  const fs = createFsAdapter(vfs);
  await fs.promises.rm(ROOT, { recursive: true, force: true });
  const shell = new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] });
  const run = (script) => shell.executeText({ script, cwd: ROOT });
  const requireSuccess = async (script) => {
    const outcome = await run(script);
    if (outcome.exitCode !== 0) throw new Error(`${script}: ${outcome.stderr}`);
  };
  await shell.executeText({ script: `git init ${ROOT}` });
  await requireSuccess(
    "git config user.name Recovery; git config user.email recovery@example.invalid"
  );
  await vfs.writeFile(`${ROOT}/seed`, "seed\n");
  await requireSuccess("git add seed && git commit -m seed");
  const oldIndex = await fs.promises.readFile(`${ROOT}/.git/index`);
  const head = await git9.resolveRef({ fs, dir: ROOT, ref: "HEAD" });
  const files = operation === "partial-add-retry" ? 256 : 32;
  for (let n = 0; n < files; n++) await vfs.writeFile(`${ROOT}/new${n}`, `new body ${n}
`);
  if (operation === "concurrent-two-adds") {
    const callers = [
      new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] }),
      new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] })
    ];
    const outcomes = await Promise.all(
      callers.map((caller, n) => caller.executeText({ script: `git add new${n}`, cwd: ROOT }))
    );
    if (outcomes.some((outcome) => outcome.exitCode !== 0))
      throw new Error("Concurrent adds failed");
    const staged = await git9.listFiles({ fs, dir: ROOT });
    if (staged.length !== 3 || !staged.includes("new0") || !staged.includes("new1"))
      throw new Error("Concurrent adds lost selection");
    await requireSuccess("git add -A");
  } else if (operation === "serialized-two-shells") {
    const other = new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] });
    const operations = new WorkspaceOperations();
    const enqueue = (target, script) => operations.run(() => target.executeText({ script, cwd: ROOT }));
    const outcomes = await Promise.all([
      enqueue(shell, "git add seed"),
      enqueue(other, "git add -A")
    ]);
    if (outcomes.some((outcome) => outcome.exitCode !== 0))
      throw new Error("Serialized callers failed");
  } else {
    let injected = false;
    let batches = 0;
    const controller = new AbortController();
    const wrapped = new Proxy(vfs, {
      get(target, property) {
        if (property === "forCredentials") return void 0;
        if (property === "writeFiles")
          return async (...args) => {
            batches++;
            if (!injected && (operation.startsWith("batch-") || operation === "partial-add-retry" && batches === 2)) {
              injected = true;
              throw new VfsError(
                operation === "batch-capacity" ? "ENOSPC" : "ENOENT",
                "injected batch failure"
              );
            }
            return target.writeFiles(...args);
          };
        if (property === "writeFile")
          return async (...args) => {
            if (!injected && operation === "index-capacity" && args[0] === `${ROOT}/.git/index`) {
              injected = true;
              throw new VfsError("ENOSPC", "injected index capacity exhaustion");
            }
            return target.writeFile(...args);
          };
        if (property === "readFile")
          return (...args) => {
            const result = target.readFile(...args);
            if (!injected && operation === "cancel-mid-add" && args[0] === `${ROOT}/new0`) {
              injected = true;
              controller.abort();
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const faulty = new Shell({
      fileSystem: wrapped,
      commands: [benchmarkGitCommand(identityTime)]
    });
    const failed = await faulty.executeText({
      script: "git add -A",
      cwd: ROOT,
      signal: controller.signal
    });
    if (!injected || failed.exitCode === 0) throw new Error(`Fault was not observed: ${operation}`);
    const after = await fs.promises.readFile(`${ROOT}/.git/index`);
    if (operation === "partial-add-retry") {
      const staged = await git9.listFiles({ fs, dir: ROOT });
      if (staged.length !== 129)
        throw new Error(`Expected first batch to persist, got ${staged.length}`);
      await git9.walk({
        fs,
        dir: ROOT,
        trees: [git9.STAGE()],
        map: async (_path, [entry]) => {
          if (entry != null && await entry.type() === "blob")
            await git9.readBlob({ fs, dir: ROOT, oid: await entry.oid() });
        }
      });
    } else if (after.length !== oldIndex.length || !after.every((byte, n) => byte === oldIndex[n]))
      throw new Error("Failed add published an index");
    if (await git9.resolveRef({ fs, dir: ROOT, ref: "HEAD" }) !== head)
      throw new Error("Failed add changed HEAD");
    await requireSuccess("git add -A");
  }
  await requireSuccess("git commit -m recovered");
  if ((await run("git status --porcelain")).stdout !== "")
    throw new Error("Recovery left a dirty tree");
  const oid = await git9.resolveRef({ fs, dir: ROOT, ref: "HEAD" });
  for (let n = 0; n < files; n++) {
    const { blob } = await git9.readBlob({ fs, dir: ROOT, oid, filepath: `new${n}` });
    if (new TextDecoder().decode(blob) !== `new body ${n}
`)
      throw new Error("Recovered blob differs");
  }
  await fs.promises.rm(ROOT, { recursive: true });
  return { iterations: 1, verified: files + 4 };
}

// demo/benchmark-git-shell.ts
import * as git10 from "isomorphic-git";
var ROOT2 = "/scratch/shell-repo";
var REMOTE = "/scratch/shell-remote.git";
var COPY = "/scratch/shell-copy";
var ORIGINAL = "const value = 1;\n".repeat(48);
var CHANGED = "// changed\nconst value = 2;\n";
var GitShellBenchmark = class {
  constructor(vfs, identityTime) {
    this.vfs = vfs;
    this.shell = new Shell({
      fileSystem: vfs,
      commands: [benchmarkGitCommand(identityTime)],
      // Permit the baseline's repeated large index writes to finish too.
      // Other limits remain the same as the real shell.
      limits: { maxTotalIoBytes: 128 * 1024 * 1024 }
    });
  }
  vfs;
  shell;
  async execute(script, cwd = ROOT2) {
    const result = await this.shell.executeText({ script, cwd });
    if (result.exitCode !== 0)
      throw new Error(`Shell Git benchmark failed: ${script}: ${result.stderr}`);
  }
  async run(operation, files) {
    const fs = createFsAdapter(this.vfs);
    switch (operation) {
      case "init":
        await fs.promises.rm(ROOT2, { recursive: true, force: true });
        await fs.promises.mkdir(ROOT2, { recursive: true });
        await this.execute(
          "git init -b main; git config user.name Benchmark; git config user.email benchmark@example.invalid"
        );
        break;
      case "populate":
        for (let i = 0; i < files; i++) {
          const sub = `${ROOT2}/d${Math.floor(i / 100)}`;
          if (i % 100 === 0) this.vfs.mkdir(sub);
          await this.vfs.writeFile(`${sub}/f${i}.txt`, `file ${i}
${ORIGINAL}`);
        }
        break;
      case "add-all":
      case "add-unchanged":
      case "add-removals":
      case "add-changed":
        await this.execute("git add -A");
        break;
      case "commit":
        await this.execute("git commit -m initial");
        break;
      case "clone-bare":
        for (const path of [REMOTE, COPY])
          await fs.promises.rm(path, { recursive: true, force: true });
        await this.execute(`git clone --bare . ${REMOTE}; git remote add origin ${REMOTE}`);
        break;
      case "clone-worktree":
        await this.execute(`git clone ${REMOTE} ${COPY}`);
        break;
      case "fetch-unchanged":
        await this.execute("git fetch origin");
        break;
      case "pull-unchanged":
        await this.execute("git pull --ff-only origin main", COPY);
        break;
      case "change-one":
        await this.vfs.writeFile(`${ROOT2}/d0/f0.txt`, CHANGED);
        break;
      case "add-one":
        await this.execute("git add d0/f0.txt");
        break;
      case "commit-one":
        await this.execute("git commit -m changed");
        break;
      case "push-one":
        await this.execute("git push origin main");
        break;
      case "pull-one":
        await this.execute("git pull --ff-only origin main", COPY);
        break;
      case "change-all":
        for (let i = 0; i < files; i++)
          await this.vfs.writeFile(
            `${ROOT2}/d${Math.floor(i / 100)}/f${i}.txt`,
            `file ${i}
${ORIGINAL.replaceAll("1", "2")}`
          );
        break;
      case "add-removals-repeat": {
        const index = `${ROOT2}/.git/index`;
        const bytes2 = await fs.promises.readFile(index);
        try {
          for (let n = 0; n < 20; n++) {
            await this.vfs.writeFile(index, bytes2);
            await this.execute("git add -A");
            if ((await git10.listFiles({ fs, dir: ROOT2 })).length !== 0)
              throw new Error("Repeated deletion staging left indexed files");
          }
        } finally {
          await this.vfs.writeFile(index, bytes2);
        }
        break;
      }
      case "remove-files":
        for (let i = 0; i < files; i++)
          await this.vfs.remove(`${ROOT2}/d${Math.floor(i / 100)}/f${i}.txt`);
        break;
    }
    return {
      iterations: operation === "add-removals-repeat" ? 20 : ["populate", "change-all", "remove-files"].includes(operation) ? files : 1,
      verified: operation === "add-removals-repeat" ? 21 : 1
    };
  }
  async validate(operation, files) {
    const fs = createFsAdapter(this.vfs);
    const options = { fs, dir: ROOT2 };
    if (operation === "add-changed") {
      let verified = 0;
      await git10.walk({
        ...options,
        trees: [git10.STAGE()],
        map: async (path, [entry]) => {
          if (await entry?.type() !== "blob") return;
          const number = Number(path.match(/f(\d+)\.txt$/u)?.[1]);
          const expected = `file ${number}
${ORIGINAL.replaceAll("1", "2")}`;
          const blob = await git10.readBlob({ ...options, oid: await entry.oid() });
          if (new TextDecoder().decode(blob.blob) !== expected)
            throw new Error("Changed staging bytes differ");
          verified++;
        }
      });
      if (verified !== files) throw new Error("Changed staging lost files");
      return verified;
    }
    if (operation === "add-one") {
      let oid;
      await git10.walk({
        ...options,
        trees: [git10.STAGE()],
        map: async (path, [entry]) => {
          if (path === "d0/f0.txt") oid = await entry?.oid();
        }
      });
      if (oid === void 0 || new TextDecoder().decode((await git10.readBlob({ ...options, oid })).blob) !== CHANGED)
        throw new Error("Shell Git benchmark did not stage the changed content");
      return 1;
    }
    if (operation !== "add-removals") return 0;
    if ((await git10.listFiles(options)).length !== 0)
      throw new Error("Shell Git benchmark did not stage every removal");
    if ((await git10.listFiles({ ...options, ref: "HEAD" })).length !== files)
      throw new Error("Shell Git benchmark changed committed history");
    const head = await git10.resolveRef({ ...options, ref: "HEAD" });
    if (head !== await git10.resolveRef({ fs, dir: COPY, ref: "HEAD" }) || head !== await git10.resolveRef({ fs, dir: REMOTE, gitdir: REMOTE, ref: "HEAD" }))
      throw new Error("Shell Git benchmark local remotes do not match");
    for (let i = 0; i < files; i++) {
      const body = await fs.promises.readFile(`${COPY}/d${Math.floor(i / 100)}/f${i}.txt`, "utf8");
      if (body !== (i === 0 ? CHANGED : `file ${i}
${ORIGINAL}`))
        throw new Error("Shell Git benchmark local clone/pull changed bytes");
    }
    for (const path of [ROOT2, REMOTE, COPY]) await fs.promises.rm(path, { recursive: true });
    return files * 2 + 3;
  }
};

// demo/benchmark-git-workflow.ts
import * as git11 from "isomorphic-git";
var SOURCE = "/scratch/coding-source";
var COPY2 = "/scratch/coding-copy";
var EDITED = "export const edited = true;\n";
function workflowBody(index, mixed) {
  const length = mixed && index < 4 ? 256 * 1024 : 768;
  let seed = index + 1;
  return Uint8Array.from({ length }, () => {
    seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
    return 32 + (seed >>> 24) % 95;
  });
}
var GitCodingWorkflow = class {
  constructor(vfs, mixed, identityTime) {
    this.vfs = vfs;
    this.mixed = mixed;
    this.shell = new Shell({ fileSystem: vfs, commands: [benchmarkGitCommand(identityTime)] });
  }
  vfs;
  mixed;
  shell;
  async execute(script, cwd = COPY2) {
    const result = await this.shell.executeText({ script, cwd });
    if (result.exitCode !== 0) throw new Error(`${script}: ${result.stderr}`);
    return result.stdout;
  }
  async run(operation, files) {
    switch (operation) {
      case "prepare":
        for (const path of [SOURCE, COPY2])
          await createFsAdapter(this.vfs).promises.rm(path, { recursive: true, force: true });
        await this.execute(`git init ${SOURCE}`, "/");
        await this.execute(
          "git config user.name Coding; git config user.email coding@example.invalid",
          SOURCE
        );
        for (let n = 0; n < files; n++)
          await this.vfs.writeFile(`${SOURCE}/f${n}`, workflowBody(n, this.mixed));
        await this.execute("git add -A && git commit -m base && git branch base", SOURCE);
        break;
      case "clone":
        await this.execute(`git clone ${SOURCE} ${COPY2}`, "/");
        await this.execute(
          "git config user.name Coding; git config user.email coding@example.invalid"
        );
        break;
      case "status-clean":
      case "status-final":
        if (await this.execute("git status --porcelain") !== "")
          throw new Error("Expected clean worktree");
        break;
      case "edit":
        await this.vfs.writeFile(`${COPY2}/f0`, EDITED);
        await this.vfs.remove(`${COPY2}/f1`);
        await this.vfs.writeFile(`${COPY2}/added`, "new file\n");
        break;
      case "status-dirty": {
        const status = await this.execute("git status --porcelain");
        if (status.trim().split("\n").length !== 3) throw new Error("Expected three changes");
        break;
      }
      case "diff":
        if (!(await this.execute("git diff")).includes("diff --git"))
          throw new Error("Missing worktree diff");
        break;
      case "add-partial":
        await this.execute("git add f0 added");
        break;
      case "diff-staged":
        if (!(await this.execute("git diff --cached")).includes("added"))
          throw new Error("Missing staged addition");
        break;
      case "commit-partial":
        await this.execute("git commit -m partial");
        break;
      case "add-rest":
        await this.execute("git add -A");
        break;
      case "commit-rest":
        await this.execute("git commit -m deletion");
        break;
      case "checkout-base":
        await this.execute("git checkout base");
        break;
      case "checkout-main":
        await this.execute("git checkout main");
        break;
    }
    return { iterations: 1, verified: 1 };
  }
  async validate(operation, files) {
    const fs = createFsAdapter(this.vfs);
    const opts = { fs, dir: COPY2 };
    if (operation === "commit-partial") {
      const head = await git11.resolveRef({ ...opts, ref: "HEAD" });
      const old = await git11.readBlob({ ...opts, oid: head, filepath: "f1" });
      if (old.blob.length !== workflowBody(1, this.mixed).length)
        throw new Error("Unstaged deletion committed");
      const status = await this.execute("git status --porcelain");
      if (!status.includes(' D "f1"') || status.trim().split("\n").length !== 1)
        throw new Error("Partial commit changed selection");
      return 2;
    }
    const original = operation === "clone" || operation === "checkout-base";
    if (!original && operation !== "checkout-main") return 0;
    const expectedFiles = Array.from({ length: files }, (_, n) => `f${n}`).filter(
      (name) => original || name !== "f1"
    );
    if (!original) expectedFiles.push("added");
    const actual = await git11.listFiles(opts);
    if (actual.slice().sort().join("\n") !== expectedFiles.sort().join("\n"))
      throw new Error("Index paths differ");
    for (const path of expectedFiles) {
      const expected = path === "added" ? new TextEncoder().encode("new file\n") : !original && path === "f0" ? new TextEncoder().encode(EDITED) : workflowBody(Number(path.slice(1)), this.mixed);
      const bytes2 = await fs.promises.readFile(`${COPY2}/${path}`);
      if (bytes2.length !== expected.length || !bytes2.every((byte, n) => byte === expected[n]))
        throw new Error(`Checkout bytes differ: ${path}`);
    }
    if (operation === "checkout-main") {
      if ((await git11.log({ ...opts })).length !== 3) throw new Error("Commit history differs");
    }
    return files + 1;
  }
};

// demo/benchmark-suite.ts
var AUTHOR = {
  name: "cf-vfs benchmark",
  email: "benchmark@example.invalid",
  timestamp: 17e8,
  timezoneOffset: 0
};
var BODY = "const value = 1;\n".repeat(48);
var CHANGED2 = "// changed\nconst value = 2;\n";
function verify(condition, message) {
  if (!condition) throw new Error(`Benchmark verification failed: ${message}`);
}
var PublicBenchmarkSuite = class {
  constructor(vfs, identityTime) {
    this.vfs = vfs;
    this.identityTime = identityTime;
    this.gitShell = new GitShellBenchmark(vfs, identityTime);
    this.codingSmall = new GitCodingWorkflow(vfs, false, identityTime);
    this.codingMixed = new GitCodingWorkflow(vfs, true, identityTime);
  }
  vfs;
  identityTime;
  gitShell;
  codingSmall;
  codingMixed;
  metadata = new FsMetadataCache();
  onEvent = this.metadata.onEvent;
  adapter(cache) {
    return createFsAdapter(this.vfs, cache ? { metadataCache: this.metadata } : {});
  }
  async cleanup() {
    await this.adapter(false).promises.rm("/scratch", { recursive: true, force: true });
  }
  async run(stage) {
    if (stage.group === "files") return this.files(stage);
    if (stage.group === "git-shell") return this.gitShell.run(stage.operation, stage.files);
    if (stage.group === "coding-small") return this.codingSmall.run(stage.operation, stage.files);
    if (stage.group === "coding-mixed") return this.codingMixed.run(stage.operation, stage.files);
    if (stage.group === "git-recovery")
      return runGitRecovery(this.vfs, stage.operation, this.identityTime);
    return this.repository(stage);
  }
  async validate(stage) {
    if (stage.group === "git-shell") return this.gitShell.validate(stage.operation, stage.files);
    if (stage.group === "coding-small")
      return this.codingSmall.validate(stage.operation, stage.files);
    if (stage.group === "coding-mixed")
      return this.codingMixed.validate(stage.operation, stage.files);
    if (stage.group === "git-recovery") return 0;
    const fs = this.adapter(stage.cache).promises;
    if (stage.group === "files") {
      for (let i = 0; i < stage.files; i += 1)
        verify(
          await fs.readFile(`/scratch/files/renamed${i}`, "utf8") === `${BODY}suffix`,
          "append/rename preserved bytes"
        );
      await fs.rm("/scratch/files", { recursive: true });
    } else {
      for (let i = 0; i < stage.files; i += 1)
        verify(
          await fs.readFile(`/scratch/repo/d${Math.floor(i / 100)}/f${i}.txt`, "utf8") === (i === 0 ? CHANGED2 : `file ${i}
${BODY}`),
          "checkout bytes"
        );
      await fs.rm("/scratch/repo", { recursive: true });
    }
    return stage.files;
  }
  async files(stage) {
    const fs = this.adapter(stage.cache).promises;
    const root = "/scratch/files";
    const iterations = stage.files;
    switch (stage.operation) {
      case "write":
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm("/scratch/copied", { recursive: true, force: true });
        await fs.mkdir(root, { recursive: true });
        for (let i = 0; i < iterations; i += 1) await fs.writeFile(`${root}/f${i}`, BODY);
        break;
      case "stat":
        await fs.readdir(root);
        for (let i = 0; i < iterations; i += 1)
          verify((await fs.stat(`${root}/f${i}`)).size === BODY.length, "stat size");
        break;
      case "stat-after-overwrite":
        await fs.writeFile(`${root}/f0`, BODY);
        for (let i = 0; i < iterations; i += 1)
          verify((await fs.stat(`${root}/f${i}`)).size === BODY.length, "metadata after overwrite");
        break;
      case "read":
        for (let i = 0; i < iterations; i += 1)
          verify(await fs.readFile(`${root}/f${i}`, "utf8") === BODY, "read bytes");
        break;
      case "readdir":
        for (let i = 0; i < 10; i += 1)
          verify((await fs.readdir(root)).length === iterations, "directory count");
        return { iterations: 10, verified: 10 };
      case "append":
        for (let i = 0; i < iterations; i += 1)
          await fs.writeFile(`${root}/f${i}`, "suffix", { flag: "a" });
        break;
      case "rename":
        for (let i = 0; i < iterations; i += 1)
          await fs.rename(`${root}/f${i}`, `${root}/renamed${i}`);
        break;
      case "copy-tree":
        await this.vfs.copy(root, "/scratch/copied", { recursive: true });
        verify(this.vfs.list("/scratch/copied").length === iterations, "copied count");
        break;
      case "remove-tree":
        await fs.rm("/scratch/copied", { recursive: true });
        break;
      default:
        throw new Error("Unknown file stage");
    }
    return {
      iterations: ["copy-tree", "remove-tree"].includes(stage.operation) ? 1 : iterations,
      verified: 1
    };
  }
  async repository(stage) {
    const fs = this.adapter(stage.cache);
    const dir = "/scratch/repo";
    const opts = { fs, dir };
    const target = `${dir}/d0/f0.txt`;
    switch (stage.operation) {
      case "init":
        await fs.promises.rm(dir, { recursive: true, force: true });
        await fs.promises.mkdir(dir, { recursive: true });
        await git12.init({ ...opts, defaultBranch: "main" });
        break;
      case "populate":
        for (let i = 0; i < stage.files; i += 1) {
          const sub = `d${Math.floor(i / 100)}`;
          if (i % 100 === 0) await fs.promises.mkdir(`${dir}/${sub}`);
          await fs.promises.writeFile(`${dir}/${sub}/f${i}.txt`, `file ${i}
${BODY}`);
        }
        break;
      case "add-all":
        for (let offset = 0; offset < stage.files; offset += 32) {
          const filepath = Array.from(
            { length: Math.min(32, stage.files - offset) },
            (_, index) => {
              const file = offset + index;
              return `d${Math.floor(file / 100)}/f${file}.txt`;
            }
          );
          await git12.add({ ...opts, filepath });
        }
        break;
      case "commit": {
        const oid = await git12.commit({ ...opts, message: "initial", author: AUTHOR });
        await git12.writeRef({ ...opts, ref: "refs/heads/benchmark-initial", value: oid });
        break;
      }
      case "status-clean": {
        const matrix = await git12.statusMatrix(opts);
        verify(
          matrix.length === stage.files && matrix.every((row) => row[1] === 1 && row[2] === 1 && row[3] === 1),
          "clean status"
        );
        break;
      }
      case "status-change": {
        await fs.promises.writeFile(target, CHANGED2);
        const matrix = await git12.statusMatrix(opts);
        verify(matrix.filter((row) => row[1] !== row[2]).length === 1, "one changed file");
        break;
      }
      case "diff": {
        const original = await git12.readBlob({
          ...opts,
          oid: await git12.resolveRef({ ...opts, ref: "benchmark-initial" }),
          filepath: "d0/f0.txt"
        });
        const next = await fs.promises.readFile(target, "utf8");
        verify(createLineDiff(new TextDecoder().decode(original.blob), next).changes > 0, "diff");
        break;
      }
      case "add-one":
        await git12.add({ ...opts, filepath: "d0/f0.txt" });
        break;
      case "commit-one":
        await git12.commit({ ...opts, message: "changed", author: AUTHOR });
        break;
      case "log": {
        const commits = await git12.log({ ...opts, depth: 2 });
        verify(
          commits.length === 2 && commits[1]?.oid === await git12.resolveRef({ ...opts, ref: "benchmark-initial" }),
          "commit chain"
        );
        break;
      }
      case "branch":
        await git12.branch({ ...opts, ref: "feature" });
        break;
      case "checkout-old":
        await git12.checkout({ ...opts, ref: "benchmark-initial" });
        verify(await fs.promises.readFile(target, "utf8") === `file 0
${BODY}`, "old checkout");
        break;
      case "checkout-main":
        await git12.checkout({ ...opts, ref: "main" });
        verify(await fs.promises.readFile(target, "utf8") === CHANGED2, "main checkout");
        break;
      default:
        throw new Error("Unknown Git stage");
    }
    return { iterations: stage.operation === "populate" ? stage.files : 1, verified: 1 };
  }
};

// demo/benchmark-fixture.ts
async function createBenchmarkFixture(storage) {
  let suite;
  const fs = new DurableObjectFileSystem(storage, {
    workspaceId: "benchmark-fixture",
    maxEntries: 2e4,
    maxInlineLogicalBytes: 32 * 1024 * 1024,
    maxInFlightBufferedBytes: 16 * 1024 * 1024,
    onEvent: (event) => suite?.onEvent(event)
  });
  await fs.initialize();
  suite = new PublicBenchmarkSuite(fs, 17e11);
  return suite;
}
export {
  createBenchmarkFixture
};
