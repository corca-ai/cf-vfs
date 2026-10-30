import { awikiCommand } from "@corca-ai/cf-vfs/shell/commands/awiki";
export default {
  fetch(): Response {
    return new Response(`${awikiCommand.name}:${awikiCommand.run.length}`);
  },
} satisfies ExportedHandler;
