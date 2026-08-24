import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@div3rsa/agent-runtime": fileURLToPath(new URL("./packages/agent-runtime/src/index.ts", import.meta.url)),
      "@div3rsa/platform-core": fileURLToPath(new URL("./packages/platform-core/src/index.ts", import.meta.url)),
      "@div3rsa/model-gateway": fileURLToPath(new URL("./services/model-gateway/src/index.ts", import.meta.url)),
      "@div3rsa/db": fileURLToPath(new URL("./packages/db/src/database.types.ts", import.meta.url)),
      "@div3rsa/skill-engine": fileURLToPath(new URL("./packages/skill-engine/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["apps/web/lib/**/*.test.ts", "packages/**/*.test.ts", "services/**/*.test.ts", "workers/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] }
  }
});
