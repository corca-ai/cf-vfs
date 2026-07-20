import { lsCommand } from "@corca-ai/cf-vfs/shell/commands/ls";

export default {
  fetch(): Response {
    return new Response(lsCommand.name);
  },
} satisfies ExportedHandler;
