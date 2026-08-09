import { describe, expect, it } from "vitest";
import { z } from "zod";
import workerConfigRaw from "../wrangler.jsonc?raw";

const qualificationConfigSchema = z.object({
	limits: z.object({ cpu_ms: z.number().int().positive() }),
});

describe("Worker qualification configuration", () => {
	it("declares the approved paid-plan CPU budget", () => {
		const config = qualificationConfigSchema.parse(JSON.parse(workerConfigRaw));

		expect(config.limits.cpu_ms).toBe(5_000);
	});
});
