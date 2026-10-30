import type { JqEvaluationBudget } from "./jq-budget.js";
import { JqRuntimeError } from "./jq-errors.js";
import { isJsonNumber, type JsonValue, jsonKind, renderJson } from "./json-value.js";

/**
 * `@text`, `@json`, `@csv`, `@tsv`, `@html`, `@uri`, `@sh` and `@base64`, as
 * jq 1.7.1's `f_format` renders them. They apply to a whole input, or to each
 * interpolated value of a string written after the format.
 */

const ENCODER = new TextEncoder();
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function text(value: JsonValue, budget: JqEvaluationBudget): string {
  return typeof value === "string" ? value : renderJson(value, { budget });
}

function escaped(value: string, table: Readonly<Record<string, string>>): string {
  let out = "";
  for (const character of value) out += table[character] ?? character;
  return out;
}

const CSV_ESCAPES = { '"': '""' };
const TSV_ESCAPES = { "\t": "\\t", "\r": "\\r", "\n": "\\n", "\\": "\\\\" };
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" };

/** One field of a `@csv` or `@tsv` row; null and NaN are empty. */
function field(value: JsonValue, format: "csv" | "tsv", budget: JqEvaluationBudget): string {
  if (value === null) return "";
  if (typeof value === "boolean") return String(value);
  if (isJsonNumber(value)) {
    return typeof value === "number" && Number.isNaN(value) ? "" : renderJson(value, { budget });
  }
  if (typeof value === "string") {
    return format === "csv" ? `"${escaped(value, CSV_ESCAPES)}"` : escaped(value, TSV_ESCAPES);
  }
  throw new JqRuntimeError(`jq: ${jsonKind(value)} is not valid in a csv row`);
}

function row(value: JsonValue, format: "csv" | "tsv", budget: JqEvaluationBudget): string {
  if (!Array.isArray(value)) {
    throw new JqRuntimeError(`jq: ${jsonKind(value)} cannot be ${format}-formatted, only array`);
  }
  return value.map((item) => field(item, format, budget)).join(format === "csv" ? "," : "\t");
}

function uri(value: string): string {
  let out = "";
  for (const byte of ENCODER.encode(value)) {
    const character = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/u.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function shell(value: JsonValue, budget: JqEvaluationBudget): string {
  const words = Array.isArray(value) ? value : [value];
  return words
    .map((word) => {
      if (typeof word === "string") return `'${word.replaceAll("'", "'\\''")}'`;
      if (word !== null && typeof word === "object" && !isJsonNumber(word)) {
        throw new JqRuntimeError(`jq: ${jsonKind(word)} can not be escaped for shell`);
      }
      return renderJson(word, { budget });
    })
    .join(" ");
}

function base64(value: string): string {
  const bytes = ENCODER.encode(value);
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const count = Math.min(3, bytes.length - index);
    const code =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    for (let digit = 0; digit < 4; digit += 1) {
      out += digit <= count ? (BASE64[(code >> (18 - digit * 6)) & 0x3f] ?? "") : "=";
    }
  }
  return out;
}

export function formatValue(name: string, value: JsonValue, budget: JqEvaluationBudget): string {
  switch (name) {
    case "text":
      return text(value, budget);
    case "json":
      return renderJson(value, { budget });
    case "csv":
    case "tsv":
      return row(value, name, budget);
    case "html":
      return escaped(text(value, budget), HTML_ESCAPES);
    case "uri":
      return uri(text(value, budget));
    case "sh":
      return shell(value, budget);
    case "base64":
      return base64(text(value, budget));
    default:
      throw new JqRuntimeError(`jq: ${name} is not a valid format`);
  }
}
