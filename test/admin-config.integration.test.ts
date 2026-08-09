import { describe, expect, it } from "vitest";
import adminWranglerConfig from "../wrangler.admin.jsonc?raw";

type AdminWranglerConfig = {
	readonly observability: ObservabilityConfig;
	readonly env: {
		readonly test: {
			readonly routes: readonly unknown[];
			readonly vars: { readonly KEY_ENVIRONMENT: string };
			readonly observability: ObservabilityConfig;
		};
	};
	readonly vars: { readonly KEY_ENVIRONMENT: string };
};

type ObservabilityConfig = {
	readonly enabled: boolean;
	readonly logs: {
		readonly enabled: boolean;
		readonly invocation_logs: boolean;
		readonly persist: boolean;
	};
	readonly traces: {
		readonly enabled: boolean;
		readonly persist: boolean;
	};
};

describe("admin Worker configuration", () => {
	it("uses production keys by default while keeping the workerd test environment isolated", () => {
		// Given: the committed standalone admin Wrangler configuration.
		const configuration = JSON.parse(
			stripJsoncComments(adminWranglerConfig),
		) as AdminWranglerConfig;

		// When: production defaults and the named test environment are inspected.
		const testEnvironment = configuration.env.test;

		// Then: the default cannot issue test-prefixed keys, and test has no production route.
		expect(configuration.vars.KEY_ENVIRONMENT).toBe("production");
		expect(testEnvironment.vars.KEY_ENVIRONMENT).toBe("test");
		expect(testEnvironment.routes).toEqual([]);
	});

	it.each([
		["production", (config: AdminWranglerConfig) => config.observability],
		["test", (config: AdminWranglerConfig) => config.env.test.observability],
	] as const)(
		"disables invocation logs and persists only explicitly configured telemetry for %s",
		(_environment, readObservability) => {
			const configuration = JSON.parse(
				stripJsoncComments(adminWranglerConfig),
			) as AdminWranglerConfig;

			const observability = readObservability(configuration);

			expect(observability).toEqual({
				enabled: true,
				logs: { enabled: true, invocation_logs: false, persist: true },
				traces: { enabled: true, persist: true },
			});
		},
	);
});

function stripJsoncComments(value: string): string {
	return value.replaceAll(/^\s*\/\/.*$/gmu, "");
}
