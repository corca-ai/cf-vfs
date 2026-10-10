import { gitCommand } from "@corca-ai/cf-vfs/shell/commands/git";
export default {
  fetch(): Response {
    return new Response(`${gitCommand.name}:${gitCommand.run.length}`);
  },
} satisfies ExportedHandler;
