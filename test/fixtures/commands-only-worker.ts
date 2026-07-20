import { catCommand, grepCommand } from "@corca-ai/cf-vfs/shell/commands";

export default {
  fetch(): Response {
    return new Response(`${catCommand.name},${grepCommand.name}`);
  },
} satisfies ExportedHandler;
