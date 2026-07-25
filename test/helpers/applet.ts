import {
  type AppletRunner,
  type AppletSpec,
  defineApplet,
  type ShellApplet,
} from "../../src/shell/commands/applet.js";

/**
 * Defines a throwaway applet for a test.
 *
 * Tests care about the runner, not the published metadata, so this fills in a
 * placeholder specification. Use `defineApplet` directly when a case exercises
 * aliases, usage text, or the option table.
 */
export function defineTestApplet(name: string, runner: AppletRunner): ShellApplet {
  const spec: AppletSpec = { name, usage: "", summary: `test applet ${name}` };
  return defineApplet(spec, runner);
}
