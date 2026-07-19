import { VfsError } from "../core/errors.js";
import type { RegexEngine, RegexProgram } from "../core/types.js";

export interface NativeRegexEngineOptions {
  maxPatternLength?: number;
}

export function createNativeRegexEngine(
  options: NativeRegexEngineOptions = {},
): RegexEngine {
  const maximumLength = options.maxPatternLength ?? 512;
  return {
    compile(pattern: string, ignoreCase: boolean): RegexProgram {
      if (pattern.length === 0 || pattern.length > maximumLength) {
        throw new VfsError(
          "EINVAL",
          `regex pattern must contain 1 to ${maximumLength} characters`,
        );
      }
      const flags = ignoreCase ? "iu" : "u";
      let lineExpression: RegExp;
      try {
        lineExpression = new RegExp(pattern, flags);
      } catch (error) {
        throw new VfsError(
          "EINVAL",
          error instanceof Error ? error.message : "invalid regular expression",
        );
      }

      return {
        findLine(value: string): number {
          lineExpression.lastIndex = 0;
          return lineExpression.exec(value)?.index ?? -1;
        },
        replace(value: string, replacement: string, global: boolean) {
          const expression = new RegExp(pattern, `${flags}${global ? "g" : ""}`);
          const counter = new RegExp(pattern, `${flags}${global ? "g" : ""}`);
          let replacements = 0;
          value.replace(counter, (match) => {
            replacements += 1;
            return match;
          });
          return { value: value.replace(expression, replacement), replacements };
        },
      };
    },
  };
}
