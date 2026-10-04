import type { ByteRange } from "../../src/vfs/types.js";

function withPrototype<T extends object>(value: T, prototype: object): T {
  Object.setPrototypeOf(value, prototype);
  return value;
}

/** Own fields, including non-enumerable ones, define byte ranges at each adapter. */
export const OWN_RANGE_CASES = [
  {
    name: "own offset ignores inherited suffix",
    make: () => withPrototype({ offset: 2 }, { suffix: 5 }),
    expected: { offset: 2, length: 10 },
  },
  {
    name: "own suffix ignores inherited offset and length",
    make: () => withPrototype({ suffix: 5 }, { offset: 2, length: 3 }),
    expected: { offset: 7, length: 5 },
  },
  {
    name: "own length ignores inherited offset and suffix",
    make: () => withPrototype({ length: 5 }, { offset: 2, suffix: 3 }),
    expected: { offset: 0, length: 5 },
  },
  {
    name: "non-enumerable offset",
    make: () => Object.defineProperty({ offset: 2 }, "offset", { enumerable: false }),
    expected: { offset: 2, length: 10 },
  },
  {
    name: "non-enumerable length",
    make: () => Object.defineProperty({ length: 5 }, "length", { enumerable: false }),
    expected: { offset: 0, length: 5 },
  },
  {
    name: "non-enumerable suffix",
    make: () => Object.defineProperty({ suffix: 5 }, "suffix", { enumerable: false }),
    expected: { offset: 7, length: 5 },
  },
] satisfies readonly {
  name: string;
  make: () => ByteRange;
  expected: { offset: number; length: number };
}[];

export const INVALID_OWN_RANGE_CASES = [
  { name: "inherited fields only", make: () => withPrototype({}, { offset: 2 }) },
  {
    name: "non-enumerable negative offset",
    make: () => Object.defineProperty({ offset: -1 }, "offset", { enumerable: false }),
  },
  {
    name: "non-enumerable unknown field",
    make: () => Object.defineProperty({ offset: 0 }, "extra", { value: 1 }),
  },
  {
    name: "non-enumerable mixed suffix",
    make: () => Object.defineProperty({ offset: 0 }, "suffix", { value: 1 }),
  },
];

export const DIRECTORY_ASSERTION_PATHS = ["/missing/", "//missing///", "/parent/../missing/"];

/** Each recursive syntax shape also has a small valid control. */
export const AWK_DEPTH_CASES = [
  { name: "assignment", make: (depth: number) => `BEGIN { ${"a=".repeat(depth)}1 }` },
  {
    name: "conditional statement",
    make: (depth: number) => `BEGIN { ${"if(1) ".repeat(depth)}print 1 }`,
  },
  { name: "unary expression", make: (depth: number) => `BEGIN { print ${"!".repeat(depth)}1 }` },
  { name: "power expression", make: (depth: number) => `BEGIN { print ${"1^".repeat(depth)}1 }` },
  { name: "field expression", make: (depth: number) => `BEGIN { print ${"$".repeat(depth)}1 }` },
  {
    name: "conditional expression",
    make: (depth: number) => `BEGIN { print ${"1?1:".repeat(depth)}1 }`,
  },
  { name: "binary tree", make: (depth: number) => `BEGIN { print ${"1+".repeat(depth)}1 }` },
];
