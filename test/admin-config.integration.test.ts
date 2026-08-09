import { describe, expect, it } from "vitest";
import adminWranglerConfig from "../wrangler.admin.jsonc?raw";

type AdminWranglerConfig = {
	readonly env: {
		readonly test: {
			readonly routes: readonly unknown[];
			readonly vars: { readonly KEY_ENVIRONMENT: string };
		};
	};
	readonly vars: { readonly KEY_ENVIRONMENT: string };
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
});

function stripJsoncComments(value: string): string {
	return value.replaceAll(/^\s*\/\/.*$/gmu, "");
}
