import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: { bindings: { API_KEY_PEPPER: "local-test-pepper" } },
		}),
	],
	test: {
		include: ["src/auth/**/*.test.ts", "src/verification/**/*.test.ts", "test/**/*.test.ts"],
	},
});
