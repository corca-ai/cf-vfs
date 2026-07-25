import { catCommand, grepCommand } from "@corca-ai/cf-vfs/shell/commands";
import { createAppletRegistry } from "@corca-ai/cf-vfs/shell/commands/applet";

// A narrow consumer that dispatches two applets through the multicall resolver
// without the shell language: no parser, no registry-wide applet table.
const registry = createAppletRegistry([catCommand, grepCommand]);

export default {
  fetch(request: Request): Response {
    const name = new URL(request.url).pathname.slice(1);
    const entry = registry.find(name) ?? registry.findPath(`/bin/${name}`);
    return entry === undefined
      ? new Response("command not resolved", { status: 404 })
      : new Response(`${entry.command.name}:${entry.kind}:${entry.command.run.length}`);
  },
} satisfies ExportedHandler;
