import { describe, expect, it } from "vitest";
import { z } from "zod";
import publicConfigRaw from "../wrangler.jsonc?raw";
import traceConfigRaw from "../wrangler.telemetry.jsonc?raw";

const observabilitySchema = z.object({
	traces: z.object({ enabled: z.boolean(), persist: z.boolean() }),
});
const serviceSchema = z.object({ binding: z.literal("TELEMETRY_TRACES"), service: z.string() });
const publicEnvironmentSchema = z.object({
	observability: observabilitySchema,
	services: z.array(serviceSchema),
});
const publicConfigSchema = z.object({
	observability: observabilitySchema,
	services: z.array(serviceSchema),
	env: z.object({ local: publicEnvironmentSchema, test: publicEnvironmentSchema }),
});
const traceEnvironmentSchema = z.object({
	routes: z.array(z.unknown()),
	observability: observabilitySchema,
	workers_dev: z.boolean(),
});
const traceConfigSchema = z.object({
	observability: observabilitySchema,
	workers_dev: z.boolean(),
	env: z.object({ local: traceEnvironmentSchema, test: traceEnvironmentSchema }),
});
const automaticTracesDisabled = { enabled: false, persist: false };
const customTracesEnabled = { enabled: true, persist: true };

describe("telemetry trace isolation configuration", () => {
	it("disables persisted automatic public traces in every main Worker environment", () => {
		// Given: the committed main Worker Wrangler configuration.
		const config = publicConfigSchema.parse(JSON.parse(publicConfigRaw));

		// When: production, test, and local telemetry settings are read.
		const environments = [config, config.env.test, config.env.local];

		// Then: only the isolated service binding can receive the strict telemetry event.
		expect(environments.map((environment) => environment.observability.traces)).toEqual([
			automaticTracesDisabled,
			automaticTracesDisabled,
			automaticTracesDisabled,
		]);
		expect(environments.map((environment) => environment.services)).toEqual([
			[{ binding: "TELEMETRY_TRACES", service: "lexcerta-telemetry-traces" }],
			[{ binding: "TELEMETRY_TRACES", service: "lexcerta-telemetry-traces-test" }],
			[{ binding: "TELEMETRY_TRACES", service: "lexcerta-telemetry-traces-local" }],
		]);
	});

	it("persists custom traces only in the route-free telemetry Worker", () => {
		// Given: the dedicated telemetry Worker Wrangler configuration.
		const config = traceConfigSchema.parse(JSON.parse(traceConfigRaw));

		// When: its persisted tracing and public route settings are inspected.
		const environments = [config, config.env.test, config.env.local];

		// Then: every telemetry deployment has custom trace persistence without a route.
		expect(environments.map((environment) => environment.observability.traces)).toEqual([
			customTracesEnabled,
			customTracesEnabled,
			customTracesEnabled,
		]);
		expect(config).not.toHaveProperty("routes");
		expect(config.workers_dev).toBe(false);
		expect(config.env.test.routes).toEqual([]);
		expect(config.env.local.routes).toEqual([]);
		expect(config.env.test.workers_dev).toBe(false);
		expect(config.env.local.workers_dev).toBe(false);
	});
});
