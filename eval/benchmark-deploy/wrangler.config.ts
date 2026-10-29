import { defineWranglerConfig } from "wrangler/experimental-config";

/** Static assets for the benchmark Worker, beside `cloudflare.config.ts`. */
export default defineWranglerConfig({
  assetsDirectory: "../../demo/public",
});
