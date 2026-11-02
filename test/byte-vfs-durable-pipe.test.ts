import { it } from "vitest";
import { PIPE_CASES } from "./helpers/pipe-cases.js";

// The pipe replaces parts of the runtime's streams, so its contract is
// checked in workerd too.
for (const [name, run] of Object.entries(PIPE_CASES)) it(name, run);
