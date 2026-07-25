import { compareDecimalIntegers, normalizeDecimalInteger } from "../../core/decimal-integer.js";
import { VfsError } from "../../core/errors.js";
import {
  type AppletSpec,
  type AppletSpecWithOptions,
  appletUsageError,
  defineApplet,
  parseAppletOptions,
} from "./applet.js";
import { writeText } from "./helpers.js";

const DATE = {
  name: "date",
  usage: "[-u] [+FORMAT]",
  summary: "prints the current time in UTC",
  options: { short: { u: { name: "utc" } } },
} as const satisfies AppletSpecWithOptions<"utc">;

const SLEEP = {
  name: "sleep",
  usage: "SECONDS",
  summary: "waits for a whole number of seconds",
} as const satisfies AppletSpec;

const EXPR = {
  name: "expr",
  usage: "EXPRESSION",
  summary: "evaluates a bounded integer or string expression",
} as const satisfies AppletSpec;

const TWO_DIGITS = (value: number): string => value.toString().padStart(2, "0");

/**
 * Formats a timestamp with the conversions this profile declares.
 *
 * Only fields that are unambiguous in the fixed `TZ=UTC` locale appear. There
 * is no locale database, so `%c`, `%x`, `%X`, `%Z`, and the padding modifiers
 * are refused rather than approximated with an English default.
 */
function formatDate(format: string, at: Date, command: AppletSpec): string {
  let output = "";
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index] ?? "";
    if (character !== "%") {
      output += character;
      continue;
    }
    const conversion = format[++index];
    switch (conversion) {
      case "Y":
        output += at.getUTCFullYear().toString().padStart(4, "0");
        break;
      case "m":
        output += TWO_DIGITS(at.getUTCMonth() + 1);
        break;
      case "d":
        output += TWO_DIGITS(at.getUTCDate());
        break;
      case "H":
        output += TWO_DIGITS(at.getUTCHours());
        break;
      case "M":
        output += TWO_DIGITS(at.getUTCMinutes());
        break;
      case "S":
        output += TWO_DIGITS(at.getUTCSeconds());
        break;
      case "F":
        output += `${at.getUTCFullYear().toString().padStart(4, "0")}-${TWO_DIGITS(
          at.getUTCMonth() + 1,
        )}-${TWO_DIGITS(at.getUTCDate())}`;
        break;
      case "T":
        output += `${TWO_DIGITS(at.getUTCHours())}:${TWO_DIGITS(at.getUTCMinutes())}:${TWO_DIGITS(
          at.getUTCSeconds(),
        )}`;
        break;
      case "s":
        output += Math.floor(at.getTime() / 1000).toString();
        break;
      case "%":
        output += "%";
        break;
      default:
        throw appletUsageError(command, `unsupported conversion %${conversion ?? ""}`);
    }
  }
  return output;
}

/**
 * Prints the current time.
 *
 * Always UTC: the runtime fixes `TZ=UTC` and has no timezone database, so `-u`
 * is accepted and changes nothing rather than implying a choice that does not
 * exist. Setting the clock is not supported. The value comes from the
 * execution's injected clock, which on Workers advances only across I/O — a
 * script must not use it to measure elapsed time.
 */
export const dateCommand = /* @__PURE__ */ defineApplet(DATE, async (context, argv, fds) => {
  const parsed = parseAppletOptions(DATE, argv);
  const [operand, ...rest] = parsed.operands;
  if (rest.length > 0) throw appletUsageError(DATE, "accepts at most one format");
  if (operand !== undefined && !operand.startsWith("+")) {
    throw appletUsageError(DATE, "setting the clock is not supported");
  }
  const at = new Date(context.now());
  const format = operand === undefined ? "%Y-%m-%d %H:%M:%S UTC" : operand.slice(1);
  await writeText(fds[1], `${formatDate(format, at, DATE)}\n`);
  return 0;
});

/**
 * Waits for a whole number of seconds.
 *
 * The wait is abortable, so cancelling an execution wakes it immediately, and
 * it is refused outright when it could not finish inside the execution
 * deadline — a request that can only end in a timeout is better reported as a
 * usage error than served for thirty seconds first. Fractional and suffixed
 * durations are outside the profile.
 */
export const sleepCommand = /* @__PURE__ */ defineApplet(SLEEP, async (context, argv) => {
  const [operand, ...rest] = argv;
  if (operand === undefined || rest.length > 0)
    throw appletUsageError(SLEEP, "requires one operand");
  if (!/^[0-9]+$/u.test(operand)) {
    throw appletUsageError(SLEEP, "duration must be a whole number of seconds");
  }
  const milliseconds = Number(operand) * 1000;
  if (milliseconds > context.budget.limits.deadlineMs) {
    throw appletUsageError(SLEEP, "duration exceeds the execution deadline");
  }
  if (milliseconds === 0) return 0;
  context.budget.checkDeadline();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      context.signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(context.signal.reason ?? new VfsError("ECANCELED", "execution was cancelled"));
    };
    if (context.signal.aborted) {
      abort();
      return;
    }
    context.signal.addEventListener("abort", abort, { once: true });
  });
  return 0;
});

const COMPARISONS = ["=", "!=", "<", "<=", ">", ">="] as const;
const ARITHMETIC = ["+", "-", "*", "/", "%"] as const;

/**
 * Evaluates one bounded expression.
 *
 * The profile is a single infix operation: integer arithmetic, a comparison, or
 * `length`. It is deliberately not a grammar — `expr` in POSIX has precedence, grouping, and quoting rules that
 * would need a parser, and arithmetic in this shell belongs in `$(( ))`.
 * Operands are strict decimal integers, matching the runtime's integer profile.
 */
export const exprCommand = /* @__PURE__ */ defineApplet(EXPR, async (_context, argv, fds) => {
  const value = evaluateExpr(argv);
  await writeText(fds[1], `${value}\n`);
  // POSIX: a null or zero result is status 1, so `expr` composes with `&&`.
  return value === "0" || value === "" ? 1 : 0;
});

function integer(value: string): bigint {
  const normalized = normalizeDecimalInteger(value);
  if (normalized === undefined) throw appletUsageError(EXPR, "non-integer argument");
  return BigInt(`${normalized.negative ? "-" : ""}${normalized.digits}`);
}

function evaluateExpr(argv: readonly string[]): string {
  if (argv.length === 2 && argv[0] === "length") return String([...(argv[1] ?? "")].length);
  const [left = "", operator = "", right = ""] = argv;
  if (argv.length !== 3) throw appletUsageError(EXPR, "expected a single infix expression");
  if (ARITHMETIC.includes(operator as (typeof ARITHMETIC)[number])) {
    const a = integer(left);
    const b = integer(right);
    if ((operator === "/" || operator === "%") && b === 0n) {
      throw appletUsageError(EXPR, "division by zero");
    }
    const result =
      operator === "+"
        ? a + b
        : operator === "-"
          ? a - b
          : operator === "*"
            ? a * b
            : operator === "/"
              ? a / b
              : a % b;
    return result.toString();
  }
  if (COMPARISONS.includes(operator as (typeof COMPARISONS)[number])) {
    const numericLeft = normalizeDecimalInteger(left);
    const numericRight = normalizeDecimalInteger(right);
    // POSIX compares numerically when both sides are integers and by byte order
    // otherwise, which is the only comparison this runtime has anywhere else.
    const order =
      numericLeft !== undefined && numericRight !== undefined
        ? compareDecimalIntegers(numericLeft, numericRight)
        : left < right
          ? -1
          : left > right
            ? 1
            : 0;
    const truth =
      operator === "="
        ? order === 0
        : operator === "!="
          ? order !== 0
          : operator === "<"
            ? order < 0
            : operator === "<="
              ? order <= 0
              : operator === ">"
                ? order > 0
                : order >= 0;
    return truth ? "1" : "0";
  }
  throw appletUsageError(EXPR, `unsupported operator ${operator}`);
}
