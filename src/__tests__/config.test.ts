import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Config validation (Success Criterion 5)", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		vi.resetModules();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("loadConfig() returns config when COURTLISTENER_API_KEY is set", async () => {
		process.env.COURTLISTENER_API_KEY = "test-key-123";
		const { loadConfig } = await import("../config.js");
		const config = loadConfig();
		expect(config.COURTLISTENER_API_KEY).toBe("test-key-123");
	});

	it("loadConfig() calls process.exit(1) when COURTLISTENER_API_KEY is missing", async () => {
		process.env.COURTLISTENER_API_KEY = undefined;
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		const { loadConfig } = await import("../config.js");
		loadConfig();
		expect(exitSpy).toHaveBeenCalledWith(1);
		exitSpy.mockRestore();
	});

	it("PORT defaults to 3000 when not set", async () => {
		process.env.COURTLISTENER_API_KEY = "test-key";
		process.env.PORT = undefined;
		const { loadConfig } = await import("../config.js");
		const config = loadConfig();
		expect(config.PORT).toBe(3000);
	});

	it("PORT coerces string '8080' to number 8080", async () => {
		process.env.COURTLISTENER_API_KEY = "test-key";
		process.env.PORT = "8080";
		const { loadConfig } = await import("../config.js");
		const config = loadConfig();
		expect(config.PORT).toBe(8080);
	});
});
