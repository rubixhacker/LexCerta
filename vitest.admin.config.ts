import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.admin.jsonc", environment: "test" },
			miniflare: { bindings: { API_KEY_PEPPER: "admin-test-pepper" } },
		}),
	],
	test: { fileParallelism: false, include: ["src/admin/**/*.test.ts", "test/admin-*.test.ts"] },
});
