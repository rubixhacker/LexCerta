import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.telemetry.jsonc", environment: "test" },
		}),
	],
	test: { include: ["test/telemetry-trace-worker.integration.test.ts"] },
});
