import { awkCommand } from "@corca-ai/cf-vfs/shell/commands/awk";

export default {
  fetch(): Response {
    return new Response(`${awkCommand.name}:${awkCommand.run.length}`);
  },
} satisfies ExportedHandler;
