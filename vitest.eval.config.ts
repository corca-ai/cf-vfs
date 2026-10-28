import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./eval/wrangler.jsonc" },
      miniflare: {
        bindings: { AGENT_EVAL_TOKEN: "test-token", AGENT_EVAL_MAX_INSTANCES: "3" },
      },
    }),
  ],
  test: {
    include: ["eval/test/**/*.test.ts"],
  },
});
