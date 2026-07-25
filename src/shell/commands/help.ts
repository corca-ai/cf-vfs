import { type AppletSpecWithOptions, defineApplet, parseAppletOptions } from "./applet.js";
import { BufferedTextWriter, writeText } from "./helpers.js";

const HELP = {
  name: "help",
  usage: "[-s] [NAME...]",
  summary: "lists the registered commands, or describes named ones",
  kind: "session-builtin",
  options: { short: { s: { name: "synopsis" } } },
} as const satisfies AppletSpecWithOptions<"synopsis">;

/**
 * Describes the commands the active registry provides.
 *
 * With no operand it lists every registered name with its summary; with
 * operands it describes those names and exits 1 for any it does not recognize.
 * `-s` prints only the synopsis line, which is what a script checking a
 * spelling wants.
 *
 * It reads the registry through the command context, so it never imports the
 * applet table and a narrow registry describes exactly what it registered.
 * Bash's `-d` and `-m` forms are outside this profile.
 */
export const helpCommand = /* @__PURE__ */ defineApplet(HELP, async (context, argv, fds) => {
  const parsed = parseAppletOptions(HELP, argv);
  const synopsisOnly = parsed.options.some((option) => option.name === "synopsis");
  const described = context.listCommands();
  const output = new BufferedTextWriter(context, fds[1]);
  let status = 0;
  try {
    if (parsed.operands.length === 0) {
      for (const command of described) {
        await output.write(
          synopsisOnly
            ? `${synopsis(command.name, command.usage)}\n`
            : `${command.name.padEnd(12)}${command.summary}\n`,
        );
      }
    } else {
      const index = new Map(described.map((command) => [command.name, command]));
      for (const name of parsed.operands) {
        const command = index.get(name);
        if (command === undefined) {
          await output.flush();
          await writeText(fds[2], `help: no help topics match \`${name}'\n`);
          status = 1;
          continue;
        }
        await output.write(`${synopsis(command.name, command.usage)}\n`);
        if (!synopsisOnly) await output.write(`    ${command.summary}\n`);
      }
    }
    await output.flush();
  } finally {
    output.abort();
  }
  return status;
});

function synopsis(name: string, usage: string): string {
  return usage === "" ? name : `${name} ${usage}`;
}
