import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
			miniflare: {
				bindings: {
					API_KEY_PEPPER: "local-test-pepper",
					COURTLISTENER_API_TOKEN: "fixture-courtlistener-token",
				},
			},
		}),
	],
	test: {
		include: [
			"src/admission/**/*.test.ts",
			"src/auth/**/*.test.ts",
			"src/courtlistener/**/*.test.ts",
			"src/telemetry/**/*.test.ts",
			"src/verification/**/*.test.ts",
			"test/**/*.test.ts",
		],
		exclude: ["test/admin-*.test.ts"],
	},
});
