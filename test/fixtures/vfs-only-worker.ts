import { MAX_INLINE_FILE_BYTES } from "@corca-ai/cf-vfs/vfs";

export default {
  fetch(): Response {
    return new Response(String(MAX_INLINE_FILE_BYTES));
  },
} satisfies ExportedHandler;
