import { catCommand, wcCommand } from "@corca-ai/cf-vfs/shell/commands";
import { createAppletRegistry } from "@corca-ai/cf-vfs/shell/commands/applet";

// A narrow consumer that dispatches two applets through the multicall resolver
// without the shell language: no parser, no registry-wide applet table.
//
// Neither applet matches a pattern, and `grep` — which shares a module with
// `wc` — is what would drag in the regex engine. The preset asserts that
// engine absent, so this measures per-applet elimination inside a module and
// not just per-module elimination.
const registry = createAppletRegistry([catCommand, wcCommand]);

export default {
  fetch(request: Request): Response {
    const name = new URL(request.url).pathname.slice(1);
    const entry = registry.find(name) ?? registry.findPath(`/bin/${name}`);
    return entry === undefined
      ? new Response("command not resolved", { status: 404 })
      : new Response(`${entry.command.name}:${entry.kind}:${entry.command.run.length}`);
  },
} satisfies ExportedHandler;
